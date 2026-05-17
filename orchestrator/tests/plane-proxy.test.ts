/**
 * Unit tests for PlaneProxy URL construction + auth-header handling.
 * Network calls are mocked so the test stays hermetic.
 */

import { PlaneProxy } from '../src/core/gateway/plane-proxy';

const tokenPayload = {
  workerId: 'w-1',
  role: 'software-engineer' as const,
  jti: 'tok-1',
  perms: ['plane:write'],
  rate: { req: 60, win: 60_000 },
};

function makeProxy(opts: { hasCredential: boolean; authHeader?: string }) {
  const vault = {
    getCredentialByType: jest.fn(async (type: string) =>
      opts.hasCredential
        ? { key: 'vault-key', type, provider: 'generic', id: 'v1', authHeader: opts.authHeader || 'X-API-Key' }
        : null
    ),
  };
  const auditLogger = { logServiceRequest: jest.fn() };
  return { proxy: new PlaneProxy(vault, auditLogger as any), vault, auditLogger };
}

describe('PlaneProxy', () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.PLANE_API_URL = 'http://plane.example/api/v1';
    process.env.PLANE_WORKSPACE_SLUG = 'turing';
    process.env.PLANE_PROJECT_ID = 'proj-uuid';
    delete process.env.PLANE_API_TOKEN;
    fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation(
      jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'T-1' }) })) as any
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fetchMock.mockRestore();
  });

  it('fails fast when PLANE_* env is missing', async () => {
    delete process.env.PLANE_API_URL;
    const { proxy } = makeProxy({ hasCredential: true });
    await expect(proxy.proxy(tokenPayload as any, 'issues/', 'GET', {}, {})).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('requires either a vault credential or PLANE_API_TOKEN env', async () => {
    const { proxy } = makeProxy({ hasCredential: false });
    await expect(proxy.proxy(tokenPayload as any, 'issues/', 'GET', {}, {})).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('No Plane credential'),
    });
  });

  it('builds the workspace-scoped URL and uses X-API-Key by default', async () => {
    const { proxy, auditLogger } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, 'issues/T-1/', 'PATCH', { state: 's-1' }, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://plane.example/api/v1/workspaces/turing/projects/proj-uuid/issues/T-1/');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('vault-key');
    expect(JSON.parse(init.body as string)).toEqual({ state: 's-1' });
    expect(auditLogger.logServiceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'plane', method: 'PATCH /issues/T-1/' })
    );
  });

  it('uses Authorization header when the credential authHeader is not X-API-Key', async () => {
    const { proxy } = makeProxy({ hasCredential: true, authHeader: 'Bearer' });
    await proxy.proxy(tokenPayload as any, 'issues/', 'GET', {}, {});

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer vault-key');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('strips a leading slash from the endpoint to avoid double slashes', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, '/states/', 'GET', {}, {});

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://plane.example/api/v1/workspaces/turing/projects/proj-uuid/states/');
  });

  it('does not send a body on GET requests', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, 'issues/', 'GET', { junk: true }, {});

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('falls back to PLANE_API_TOKEN env when the vault is empty', async () => {
    process.env.PLANE_API_TOKEN = 'env-token';
    const { proxy } = makeProxy({ hasCredential: false });
    await proxy.proxy(tokenPayload as any, 'issues/', 'GET', {}, {});

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('env-token');
  });

  it('translates non-2xx responses into a structured error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'issue not found',
    });
    const { proxy } = makeProxy({ hasCredential: true });
    await expect(proxy.proxy(tokenPayload as any, 'issues/missing/', 'GET', {}, {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
