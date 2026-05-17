import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { getConsumerTokenManager } from '../core/consumer-token';

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
 */
export function makeRequireWorkerToken(): (req: Request, res: Response, next: NextFunction) => void {
  const LEGACY_TOKEN = process.env.WORKER_INTERNAL_TOKEN || '';
  if (LEGACY_TOKEN) {
    console.warn(
      '[Middleware] WORKER_INTERNAL_TOKEN is set — legacy static-secret path enabled alongside JWT. ' +
        'Unset once every worker is gateway-mode (sends CONSUMER_TOKEN).',
    );
  }
  return function requireWorkerToken(req, res, next) {
    const provided = extractBearer(req);

    if (!provided) {
      res.status(401).json({ error: 'Unauthorized (missing bearer)' });
      return;
    }

    // Try JWT consumer token first (the canonical path).
    try {
      const result = getConsumerTokenManager().validateToken(provided);
      if (result.valid) {
        next();
        return;
      }
    } catch {
      // Fall through to legacy comparison.
    }

    if (LEGACY_TOKEN && timingSafeBearerMatch(provided, LEGACY_TOKEN)) {
      next();
      return;
    }

    res.status(401).json({ error: 'Unauthorized (worker token)' });
  };
}

/**
 * HMAC-signature verification for Plane webhooks. When PLANE_WEBHOOK_SECRET
 * is unset, the middleware is a no-op (transitional). When set, the request
 * must carry X-Plane-Signature: sha256=<hex> computed over the raw body.
 *
 * Express has already parsed the JSON body by this point, so we recompute
 * the canonical form. For tighter security a raw-body capture would be
 * preferable; until then this defends against trivial tampering.
 */
export function makeVerifyPlaneSignature(): (req: Request, res: Response, next: NextFunction) => void {
  const PLANE_WEBHOOK_SECRET = process.env.PLANE_WEBHOOK_SECRET || '';
  if (!PLANE_WEBHOOK_SECRET) {
    console.warn(
      '[Middleware] PLANE_WEBHOOK_SECRET is not set. /webhooks/plane is unauthenticated. ' +
        'Configure Plane webhook secret to fail-closed.',
    );
  }
  return function verifyPlaneSignature(req, res, next) {
    if (!PLANE_WEBHOOK_SECRET) {
      next();
      return;
    }
    const headerName = process.env.PLANE_WEBHOOK_SIGNATURE_HEADER || 'x-plane-signature';
    const provided = (req.get(headerName) || '').toLowerCase();
    if (!provided) {
      res.status(401).json({ error: 'Missing Plane webhook signature' });
      return;
    }
    const canonical = JSON.stringify(req.body ?? {});
    const expected = 'sha256=' + crypto.createHmac('sha256', PLANE_WEBHOOK_SECRET).update(canonical).digest('hex');
    if (timingSafeBearerMatch(provided, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Invalid Plane webhook signature' });
  };
}
