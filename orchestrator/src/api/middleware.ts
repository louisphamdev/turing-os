import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { getConsumerTokenManager } from '../core/consumer-token';
import { logger } from '../core/logger';

/**
 * Request-logging middleware.
 *
 * - Correlation id: reads an inbound `X-Request-Id` header (so a caller's id is
 *   preserved across the proxy) or mints one with crypto.randomUUID(). The id is
 *   echoed on the response header and attached as `(req as any).requestId` so
 *   downstream handlers can include it in their own log lines.
 * - On response `finish`, logs one structured line with
 *   { requestId, method, path, status, durationMs }.
 * - Noisy scrape/probe endpoints (/metrics, /health, /health/ping) are logged at
 *   `debug` instead of `info`, so a default LOG_LEVEL=info run is not drowned by
 *   Prometheus/liveness traffic while the data is still there when debugging.
 *
 * Wire this EARLY in the chain (after express.json, before routes).
 */
const QUIET_PATHS = new Set(['/metrics', '/health', '/health/ping']);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const requestId = incoming && incoming.length > 0 ? incoming : crypto.randomUUID();
  (req as unknown as { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const fields = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    };
    if (QUIET_PATHS.has(req.path)) {
      logger.debug('http_request', fields);
    } else {
      logger.info('http_request', fields);
    }
  });

  next();
}

/**
 * Bearer-token equality check helpers shared by route registrations.
 * Each factory returns a middleware bound to the env-var value, so swapping
 * the token requires a restart (acceptable: tokens are deployment-scoped).
 */

function timingSafeBearerMatch(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractBearer(req: Request): string {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * Require ADMIN_API_TOKEN bearer. Without the env, the orchestrator refuses
 * every admin-only request (fail-closed).
 */
export function makeRequireAdmin(): (req: Request, res: Response, next: NextFunction) => void {
  const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
  if (!ADMIN_API_TOKEN) {
    console.warn('[Middleware] ADMIN_API_TOKEN is not set. Admin-only endpoints will refuse every request.');
  }
  return function requireAdmin(req, res, next) {
    if (!ADMIN_API_TOKEN) {
      res.status(503).json({ error: 'ADMIN_API_TOKEN not configured on this orchestrator' });
      return;
    }
    if (timingSafeBearerMatch(extractBearer(req), ADMIN_API_TOKEN)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}

/**
 * Worker→orchestrator auth. Verifies the worker's CONSUMER_TOKEN (JWT)
 * — the same short-lived, per-worker, revocable token that workers use
 * to call the gateway. This replaces a static shared secret with a
 * rotatable, per-worker credential:
 *  - revocation is honoured (Redis-backed blacklist)
 *  - tokens auto-expire (role-based TTL, see RBAC)
 *  - audit logs can attribute every webhook to a workerId/role/ticketId
 *
 * Fallback: if no Bearer is presented AND the legacy WORKER_INTERNAL_TOKEN
 * env is set, the static value is accepted. Once all workers run with
 * CONSUMER_TOKEN, the env can be unset (fail-closed JWT-only).
 *
 * Ticket binding (P2-5): on routes that carry a `:ticketId` path param
 * (the worker-inbox drain/peek routes), the validated JWT's `meta.ticketId`
 * MUST equal the requested ticket. This stops a worker holding a valid token
 * for ticket A from draining/peeking ticket B's admin inbox. A token that
 * carries no ticket id (older issuance) is allowed through with a one-time
 * warning, and the legacy static secret carries no identity at all so it
 * likewise cannot be ticket-bound (deprecation-logged on use).
 *
 * NOTE(follow-up): body-param worker routes (/blocked, /completed,
 * /worker-message, /health/heartbeat, /checkpoint) identify their ticket via
 * `ticket_id` in the JSON body, not a path param, so they are NOT bound here.
 * Binding those is deferred to a follow-up task.
 */
export function makeRequireWorkerToken(): (req: Request, res: Response, next: NextFunction) => void {
  const LEGACY_TOKEN = process.env.WORKER_INTERNAL_TOKEN || '';
  if (LEGACY_TOKEN) {
    console.warn(
      '[Middleware] WORKER_INTERNAL_TOKEN is set — legacy static-secret path enabled alongside JWT. ' +
        'Unset once every worker is gateway-mode (sends CONSUMER_TOKEN).',
    );
  }
  // Emit the "token has no ticket id, cannot bind" warning at most once per
  // process to avoid log spam from repeated requests with older tokens.
  let warnedUnbindableJwt = false;
  return function requireWorkerToken(req, res, next) {
    const provided = extractBearer(req);

    if (!provided) {
      res.status(401).json({ error: 'Unauthorized (missing bearer)' });
      return;
    }

    // Try JWT consumer token first (the canonical path).
    try {
      const result = getConsumerTokenManager().validateToken(provided);
      if (result.valid && result.payload) {
        // Attach the validated payload so downstream handlers can attribute
        // the request to a workerId/role/ticketId.
        (req as unknown as { workerToken?: unknown }).workerToken = result.payload;

        // Ticket binding: only enforce on path-param routes (:ticketId).
        const routeTicketId = req.params?.ticketId;
        if (routeTicketId) {
          const tokenTicketId = result.payload.meta?.ticketId;
          if (tokenTicketId) {
            if (tokenTicketId !== routeTicketId) {
              res.status(403).json({ error: 'Forbidden (token not bound to this ticket)' });
              return;
            }
          } else if (!warnedUnbindableJwt) {
            // Older token without a ticket id — cannot bind. Allow but warn once.
            warnedUnbindableJwt = true;
            console.warn(
              '[Middleware] Worker JWT has no meta.ticketId — cannot bind it to the requested ' +
                'ticket. Allowing for backward-compat; re-issue tokens with a ticketId to enforce binding.',
            );
          }
        }
        next();
        return;
      }
    } catch {
      // Fall through to legacy comparison.
    }

    if (LEGACY_TOKEN && timingSafeBearerMatch(provided, LEGACY_TOKEN)) {
      // Legacy static secret carries no identity, so it cannot be ticket-bound.
      // Keep accepting it transitionally, but log a deprecation notice on use.
      console.warn(
        '[Middleware] DEPRECATED: request authenticated via legacy WORKER_INTERNAL_TOKEN. ' +
          'This static secret carries no identity and CANNOT be ticket-bound. ' +
          'Migrate the worker to a per-ticket CONSUMER_TOKEN (JWT) and unset WORKER_INTERNAL_TOKEN.',
      );
      next();
      return;
    }

    res.status(401).json({ error: 'Unauthorized (worker token)' });
  };
}

/**
 * HMAC-signature verification for Plane webhooks. When PLANE_WEBHOOK_SECRET
 * is set, the request must carry X-Plane-Signature: sha256=<hex> computed
 * over the EXACT raw request bytes (captured in index.ts via the express.json
 * `verify` hook as `req.rawBody`). We HMAC the raw bytes — never a re-serialized
 * JSON.stringify(req.body), which would not match Plane's real signature.
 *
 * Fail-closed: when PLANE_WEBHOOK_SECRET is unset, every request is REJECTED
 * (503), because /webhooks/plane can spawn/kill containers. The only exception
 * is the explicit dev escape hatch ALLOW_UNSIGNED_PLANE_WEBHOOK=true, which
 * allows unsigned requests through with a loud warning (never use in prod).
 *
 * TODO(replay): enforce a signed timestamp/nonce once Plane's webhook envelope
 * is confirmed. Plane's exact timestamp header is not known here, so we do NOT
 * add a hard timestamp requirement that could break real Plane interop. The
 * existing idempotency check in webhooks.ts (router.post('/plane'), the
 * `registry.lookupByTicket(ticket_id) || priorityQueue.hasTask(ticket_id)`
 * guard, ~line 235) is the current partial mitigation against replays.
 */
export function makeVerifyPlaneSignature(): (req: Request, res: Response, next: NextFunction) => void {
  const PLANE_WEBHOOK_SECRET = process.env.PLANE_WEBHOOK_SECRET || '';
  const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK === 'true';
  if (!PLANE_WEBHOOK_SECRET) {
    console.warn(
      '[Middleware] PLANE_WEBHOOK_SECRET is not set. /webhooks/plane requests will be ' +
        (ALLOW_UNSIGNED
          ? 'ALLOWED because ALLOW_UNSIGNED_PLANE_WEBHOOK=true (DEV ONLY — never set in production).'
          : 'REJECTED (fail-closed). Configure the Plane webhook secret to enable the endpoint.'),
    );
  }
  return function verifyPlaneSignature(req, res, next) {
    if (!PLANE_WEBHOOK_SECRET) {
      // Fail-closed: reject unless the explicit dev escape hatch is set.
      if (ALLOW_UNSIGNED) {
        console.warn(
          '[Middleware] ⚠️  Accepting UNSIGNED Plane webhook (ALLOW_UNSIGNED_PLANE_WEBHOOK=true). ' +
            'This bypasses HMAC verification and must NEVER be enabled in production.',
        );
        next();
        return;
      }
      res.status(503).json({ error: 'PLANE_WEBHOOK_SECRET not configured; /webhooks/plane is disabled (fail-closed)' });
      return;
    }
    const headerName = process.env.PLANE_WEBHOOK_SIGNATURE_HEADER || 'x-plane-signature';
    const provided = (req.get(headerName) || '').toLowerCase();
    if (!provided) {
      res.status(401).json({ error: 'Missing Plane webhook signature' });
      return;
    }
    // HMAC over the EXACT raw request bytes Plane signed — not a re-serialized body.
    // Fail closed: if the raw body was never captured (e.g. a non-JSON Content-Type
    // meant express.json() skipped it), we cannot verify the signature. Do NOT fall
    // back to an empty buffer — reject instead.
    const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (rawBody === undefined) {
      res.status(400).json({ error: 'Cannot verify signature: raw body unavailable' });
      return;
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', PLANE_WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (timingSafeBearerMatch(provided, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid Plane webhook signature' });
  };
}
