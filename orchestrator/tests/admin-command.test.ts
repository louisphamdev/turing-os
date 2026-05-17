jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
  })),
}));

// Set before importing webhooksRouter so makeRequireAdmin captures it.
process.env.ADMIN_API_TOKEN = 'admin-token-32-chars-min-length-aaaa';

import { Request, Response } from 'express';

import { WorkerRegistry } from '../src/core/registry';
import { DockerService } from '../src/core/docker';
import { HealthMonitor } from '../src/core/health-monitor';
import { webhooksRouter } from '../src/api/webhooks';
import { matrixService } from '../src/core/matrix';

interface MockResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

function buildResponse(): { res: Response; out: MockResponse } {
  const out: MockResponse = { status: 0, body: null, headers: {} };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(payload: any) {
      out.body = payload;
      return res;
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return out.headers[name.toLowerCase()];
    },
  } as unknown as Response;
  return { res, out };
}

function findRoute(router: any, method: string, path: string): Function {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`route ${method} ${path} not found`);
  return async (req: Request, res: Response) => {
    // Run every middleware on the route, including requireAdmin.
    const handlers: Function[] = layer.route.stack.map((h: any) => h.handle);
    for (const h of handlers) {
      let nextCalled = false;
      await h(req, res, () => {
        nextCalled = true;
      });
      if (!nextCalled) return; // a middleware short-circuited
    }
  };
}

function makeReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    body,
    params: {},
    query: {},
    get: (name: string) => headers[name.toLowerCase()],
    method: 'POST',
    path: '/admin-command',
  } as unknown as Request;
}

describe('POST /webhooks/admin-command', () => {
  let router: any;
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry();
    const docker = new DockerService();
    const health = new HealthMonitor(registry, docker);
    router = webhooksRouter(registry, docker, health);
  });

  it('rejects request without admin token', async () => {
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(makeReq({ target_ticket: 'T-1', command_type: 'inspect' }), res);
    expect(out.status).toBe(401);
  });

  it('rejects unknown command_type', async () => {
    registry.register('T-1', 'RUNNING', 'qa');
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { target_ticket: 'T-1', command_type: 'rm_rf_root' },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa' },
      ),
      res,
    );
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/Unknown command_type/);
  });

  it('rejects missing target_ticket', async () => {
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { command_type: 'inspect' },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa' },
      ),
      res,
    );
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/target_ticket/);
  });

  it('rejects malformed ticketId', async () => {
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { target_ticket: 'no spaces allowed', command_type: 'inspect' },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa' },
      ),
      res,
    );
    expect(out.status).toBe(400);
  });

  it('returns 404 when ticket is not in registry', async () => {
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { target_ticket: 'unknown-ticket', command_type: 'inspect' },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa' },
      ),
      res,
    );
    expect(out.status).toBe(404);
  });

  it('queues a valid command (202) and pushes onto the worker inbox', async () => {
    registry.register('T-2', 'RUNNING', 'se');
    const spy = jest.spyOn(matrixService, 'pushStructuredCommand').mockImplementation(() => undefined);

    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { target_ticket: 'T-2', command_type: 'register_tool', args: { tool_name: 'fetch_url' } },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa', 'x-admin-sender': 'louis' },
      ),
      res,
    );

    expect(out.status).toBe(202);
    expect(out.body.queued).toBe(true);
    expect(spy).toHaveBeenCalledWith('T-2', 'louis', {
      type: 'register_tool',
      args: { tool_name: 'fetch_url' },
    });

    spy.mockRestore();
  });

  it('rejects non-object args', async () => {
    registry.register('T-3', 'RUNNING', 'se');
    const handler = findRoute(router, 'POST', '/admin-command');
    const { res, out } = buildResponse();
    await handler(
      makeReq(
        { target_ticket: 'T-3', command_type: 'inspect', args: 'not-an-object' },
        { authorization: 'Bearer admin-token-32-chars-min-length-aaaa' },
      ),
      res,
    );
    expect(out.status).toBe(400);
  });
});
