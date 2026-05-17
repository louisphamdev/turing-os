import * as crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { makeRequireAdmin, makeRequireWorkerToken, makeVerifyPlaneSignature } from '../src/api/middleware';

function fakeReq(headers: Record<string, string> = {}, body: any = {}): Request {
  return {
    get: (name: string) => headers[name.toLowerCase()],
    body,
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
});

describe('makeVerifyPlaneSignature', () => {
  const ORIGINAL_SECRET = process.env.PLANE_WEBHOOK_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PLANE_WEBHOOK_SECRET;
    else process.env.PLANE_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  it('is a no-op when secret unset', () => {
    delete process.env.PLANE_WEBHOOK_SECRET;
    const mw = makeVerifyPlaneSignature();
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({}, { hello: 'world' }), res, n.next);
    expect(n.called).toBe(true);
  });

  it('rejects when signature header missing', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({}, { ticket_id: 'T-1' }), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });

  it('accepts valid signature', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const body = { ticket_id: 'T-1' };
    const canonical = JSON.stringify(body);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'plane-secret').update(canonical).digest('hex');
    const { res } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ 'x-plane-signature': sig }, body), res, n.next);
    expect(n.called).toBe(true);
  });

  it('rejects forged signature', () => {
    process.env.PLANE_WEBHOOK_SECRET = 'plane-secret';
    const mw = makeVerifyPlaneSignature();
    const body = { ticket_id: 'T-1' };
    const wrongSig = 'sha256=' + crypto.createHmac('sha256', 'wrong-key').update(JSON.stringify(body)).digest('hex');
    const { res, calls } = fakeRes();
    const n = fakeNext();
    mw(fakeReq({ 'x-plane-signature': wrongSig }, body), res, n.next);
    expect(calls.status).toBe(401);
    expect(n.called).toBe(false);
  });
});
