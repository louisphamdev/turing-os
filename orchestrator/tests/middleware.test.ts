import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { makeRequireAdmin, makeRequireWorkerToken, makeVerifyPlaneSignature } from '../src/api/middleware';

function fakeReq(
  headers: Record<string, string> = {},
  body: any = {},
  params: Record<string, string> = {},
): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    body,
    params,
  } as unknown as Request;
}

// Mirrors what index.ts captures: the exact raw bytes of the request body.
// The Plane verifier HMACs `req.rawBody`, NOT a re-serialized JSON.stringify(req.body),
// so tests must sign the same bytes Plane (and our parser) would see.
function fakePlaneReq(
  signatureHeader: string | undefined,
  rawBody: Buffer | undefined,
): Request {
  const headers: Record<string, string> = {};
  if (signatureHeader !== undefined) headers['x-plane-signature'] = signatureHeader;
  return {
    get: (name: string) => headers[name.toLowerCase()],
    rawBody,
    // body would normally be the parsed JSON; the verifier must not use it.
    body: rawBody ? JSON.parse(rawBody.toString('utf8')) : {},
  } as unknown as Request;
}

function fakeRes(): { res: Response; calls: { status: number; body: any } } {
  const state: { status: number; body: any } = { status: 0, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: any) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, calls: state };
}

function fakeNext(): { next: NextFunction; called: boolean } {
  const flag = { called: false };
  const next: NextFunction = () => {
    flag.called = true;
  };
  return { next, get called() { return flag.called; } };
}

describe('makeRequireAdmin', () => {
  const ORIGINAL = process.env.ADMIN_API_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = ORIGINAL;
  });

  it('returns 503 when ADMIN_API_TOKEN is unset', () => {
    delete process.env.ADMIN_API_TOKEN;
    const mw = makeRequireAdmin();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq(), res, n.next);
    expect(calls.status).toBe(503);
    expect(n.called).toBe(false);
  });

  it('rejects request without bearer', () => {
    process.env.ADMIN_API_TOKEN = 'super-secret-token-32-chars-long';
    const mw = makeRequireAdmin();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq(), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('rejects request with wrong length bearer', () => {
    process.env.ADMIN_API_TOKEN = 'super-secret-token-32-chars-long';
    const mw = makeRequireAdmin();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ authorization: 'Bearer too-short' }), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('accepts correct bearer', () => {
    process.env.ADMIN_API_TOKEN = 'super-secret-token-32-chars-long';
    const mw = makeRequireAdmin();
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ authorization: 'Bearer super-secret-token-32-chars-long' }), res, n.next);
    expect(n.called).toBe(true);
  });
});

describe('makeRequireWorkerToken', () => {
  const ORIGINAL = process.env.WORKER_INTERNAL_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WORKER_INTERNAL_TOKEN;
    else process.env.WORKER_INTERNAL_TOKEN = ORIGINAL;
  });

  it('rejects when no bearer header is supplied', () => {
    delete process.env.WORKER_INTERNAL_TOKEN;
    const mw = makeRequireWorkerToken();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq(), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('accepts a valid CONSUMER_TOKEN (JWT)', () => {
    const { getConsumerTokenManager } = require('../src/core/consumer-token');
    const mgr = getConsumerTokenManager();
    const { token } = mgr.generateToken({
      workerId: 'wbr-1',
      role: 'qa',
      permissions: ['plane:read'],
      expiresIn: 1,
    });

    const mw = makeRequireWorkerToken();
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ authorization: `Bearer ${token}` }), res, n.next);
    expect(n.called).toBe(true);
  });

  it('rejects a forged JWT and no legacy fallback', () => {
    delete process.env.WORKER_INTERNAL_TOKEN;
    const mw = makeRequireWorkerToken();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ authorization: 'Bearer not.a.real.jwt' }), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('accepts legacy WORKER_INTERNAL_TOKEN when JWT path fails', () => {
    process.env.WORKER_INTERNAL_TOKEN = 'worker-internal-token-32-chars!!';
    const mw = makeRequireWorkerToken();
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ authorization: 'Bearer worker-internal-token-32-chars!!' }), res, n.next);
    expect(n.called).toBe(true);
  });

  // ─── P2-5: ticket binding on path-param worker-inbox routes ─────────────
  describe('ticket binding (P2-5)', () => {
    function tokenForTicket(ticketId: string): string {
      const { getConsumerTokenManager } = require('../src/core/consumer-token');
      const mgr = getConsumerTokenManager();
      const { token } = mgr.generateToken({
        workerId: `turing-worker-qa-${ticketId}`,
        role: 'qa',
        permissions: ['plane:read'],
        expiresIn: 1,
        metadata: { ticketId },
      });
      return token;
    }

    it('accepts a worker JWT for ticket A on /worker-inbox/A/... (binding matches)', () => {
      delete process.env.WORKER_INTERNAL_TOKEN;
      const token = tokenForTicket('A');
      const mw = makeRequireWorkerToken();
      const { res } = fakeRes();
      const n = fakeNext();
      mw(fakeReq({ authorization: `Bearer ${token}` }, {}, { ticketId: 'A' }), res, n.next);
      expect(n.called).toBe(true);
    });

    it('rejects (403) a worker JWT for ticket A on /worker-inbox/B/... (binding mismatch)', () => {
      delete process.env.WORKER_INTERNAL_TOKEN;
      const token = tokenForTicket('A');
      const mw = makeRequireWorkerToken();
      const { res, calls } = fakeRes();
      const n = fakeNext();
      mw(fakeReq({ authorization: `Bearer ${token}` }, {}, { ticketId: 'B' }), res, n.next);
      expect(calls.status).toBe(403);
      expect(n.called).toBe(false);
    });

    it('attaches the validated payload to req.workerToken', () => {
      delete process.env.WORKER_INTERNAL_TOKEN;
      const token = tokenForTicket('A');
      const mw = makeRequireWorkerToken();
      const { res } = fakeRes();
      const n = fakeNext();
      const req = fakeReq({ authorization: `Bearer ${token}` }, {}, { ticketId: 'A' });
      mw(req, res, n.next);
      expect(n.called).toBe(true);
      expect((req as any).workerToken?.meta?.ticketId).toBe('A');
    });

    it('allows a JWT with no meta.ticketId on a path-param route (cannot bind, warns once)', () => {
      delete process.env.WORKER_INTERNAL_TOKEN;
      const { getConsumerTokenManager } = require('../src/core/consumer-token');
      const mgr = getConsumerTokenManager();
      const { token } = mgr.generateToken({
        workerId: 'legacy-no-ticket',
        role: 'qa',
        permissions: ['plane:read'],
        expiresIn: 1,
      });
      const mw = makeRequireWorkerToken();
      const { res } = fakeRes();
      const n = fakeNext();
      mw(fakeReq({ authorization: `Bearer ${token}` }, {}, { ticketId: 'B' }), res, n.next);
      expect(n.called).toBe(true);
    });

    it('legacy WORKER_INTERNAL_TOKEN still passes on a path-param route (deprecation path, no binding)', () => {
      process.env.WORKER_INTERNAL_TOKEN = 'worker-internal-token-32-chars!!';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const mw = makeRequireWorkerToken();
        const { res } = fakeRes();
        const n = fakeNext();
        mw(
          fakeReq({ authorization: 'Bearer worker-internal-token-32-chars!!' }, {}, { ticketId: 'B' }),
          res,
          n.next,
        );
        expect(n.called).toBe(true);
        // The deprecation notice is logged on use.
        expect(
          warnSpy.mock.calls.some((c) => String(c[0]).includes('DEPRECATED')),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

describe('makeVerifyPlaneSignature', () => {
  const ORIGINAL_SECRET = process.env.PLANE_WEBHOOK_SECRET;
  const ORIGINAL_ALLOW = process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PLANE_WEBHOOK_SECRET;
    else process.env.PLANE_WEBHOOK_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_ALLOW === undefined) delete process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK;
    else process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK = ORIGINAL_ALLOW;
  });

  // The exact bytes Plane would POST (and our parser captures as req.rawBody).
  const RAW = Buffer.from('{"ticket_id":"T-1","status":"TODO"}', 'utf8');
  const signRaw = (secret: string, raw: Buffer): string =>
    'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

  it('rejects (fail-closed, 503) when secret unset', () => {
    delete process.env.PLANE_WEBHOOK_SECRET;
    delete process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK;
    const mw = makeVerifyPlaneSignature();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(undefined, RAW), res, n.next);
    expect(calls.status).toBe(503);
    expect(n.called).toBe(false);
  });

  it('allows when secret unset but ALLOW_UNSIGNED_PLANE_WEBHOOK=true (dev escape hatch)', () => {
    delete process.env.PLANE_WEBHOOK_SECRET;
    process.env.ALLOW_UNSIGNED_PLANE_WEBHOOK = 'true';
    const mw = makeVerifyPlaneSignature();
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(undefined, RAW), res, n.next);
    expect(n.called).toBe(true);
  });

  it('rejects when signature header missing', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(undefined, RAW), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('accepts a valid raw-body signature', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const sig = signRaw('plane-secret', RAW);
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(sig, RAW), res, n.next);
    expect(n.called).toBe(true);
  });

  it('rejects a tampered body (signature no longer matches the raw bytes)', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    // Sign the original bytes, then deliver different bytes.
    const sig = signRaw('plane-secret', RAW);
    const tampered = Buffer.from('{"ticket_id":"T-EVIL","status":"TODO"}', 'utf8');
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(sig, tampered), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('rejects a forged signature (wrong key)', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const wrongSig = signRaw('wrong-key', RAW);
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakePlaneReq(wrongSig, RAW), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });
});
