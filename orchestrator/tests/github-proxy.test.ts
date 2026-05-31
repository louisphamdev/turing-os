/**
 * Unit tests for GithubProxy URL construction + auth-header handling.
 * The vault and network calls are mocked so the test stays hermetic — it
 * never touches the real GitHub API.
 */

import { GithubProxy } from '../src/core/gateway/github-proxy';

const tokenPayload = {
  workerId: 'w-1',
  role: 'doctor' as const,
  jti: 'tok-1',
  perms: ['github:write'],
  rate: { req: 60, win: 60_000 },
};

function makeProxy(opts: { hasCredential: boolean }) {
  const vault = {
    getCredentialByType: jest.fn(async (type: string) =>
      opts.hasCredential
        ? { key: 'vault-key', type, provider: 'generic', id: 'v1' }
        : null
    ),
  };
  const auditLogger = { logServiceRequest: jest.fn() };
  return { proxy: new GithubProxy(vault, auditLogger as any), vault, auditLogger };
}

describe('GithubProxy', () => {
  const originalEnv = { ...process.env };
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_API_URL;
    fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation(
      jest.fn(async () => ({
        ok: true,
        status: 201,
        statusText: 'Created',
        text: async () => JSON.stringify({ number: 42, html_url: 'https://github.com/o/r/issues/42' }),
      })) as any
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fetchMock.mockRestore();
  });

  it('builds the api.github.com URL with Bearer auth + Accept header and forwards method/body', async () => {
    const { proxy, auditLogger } = makeProxy({ hasCredential: true });
    const body = { title: 'boom', body: 'Doctor incident' };
    const result = await proxy.proxy(tokenPayload as any, 'repos/o/r/issues', 'POST', body, {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://api.github.com/repos/o/r/issues');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer vault-key');
    expect(headers['Accept']).toBe('application/vnd.github+json');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);

    expect(auditLogger.logServiceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'github', method: 'POST /repos/o/r/issues' })
    );

    // Upstream JSON is returned verbatim.
    expect(result).toEqual({ number: 42, html_url: 'https://github.com/o/r/issues/42' });
  });

  it('strips a leading slash from the endpoint to avoid double slashes', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, '/user/repos', 'GET', undefined, {});

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://api.github.com/user/repos');
  });

  it('forwards query string params verbatim', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, 'repos/o/r/issues', 'GET', undefined, { state: 'open', labels: 'bug' });

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://api.github.com/repos/o/r/issues?state=open&labels=bug');
  });

  it('does not send a body on GET requests', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, 'user', 'GET', { junk: true }, {});

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('falls back to GITHUB_TOKEN env when the vault is empty', async () => {
    process.env.GITHUB_TOKEN = 'env-token';
    const { proxy } = makeProxy({ hasCredential: false });
    await proxy.proxy(tokenPayload as any, 'user', 'GET', undefined, {});

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer env-token');
  });

  it('requires either a vault credential or GITHUB_TOKEN env', async () => {
    const { proxy } = makeProxy({ hasCredential: false });
    await expect(proxy.proxy(tokenPayload as any, 'user', 'GET', undefined, {})).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('No GitHub credential'),
    });
  });

  it('rejects path traversal in the endpoint', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await expect(
      proxy.proxy(tokenPayload as any, 'repos/o/r/../../../user', 'GET', undefined, {})
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an absolute URL / host re-targeting in the endpoint', async () => {
    const { proxy } = makeProxy({ hasCredential: true });
    await expect(
      proxy.proxy(tokenPayload as any, 'https://evil.example/steal', 'GET', undefined, {})
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours GITHUB_API_URL for GHES instances', async () => {
    process.env.GITHUB_API_URL = 'https://github.example.com/api/v3/';
    const { proxy } = makeProxy({ hasCredential: true });
    await proxy.proxy(tokenPayload as any, 'user', 'GET', undefined, {});

    const [calledUrl] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://github.example.com/api/v3/user');
  });

  it('translates non-2xx responses into a structured error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => 'validation failed',
    });
    const { proxy } = makeProxy({ hasCredential: true });
    await expect(
      proxy.proxy(tokenPayload as any, 'repos/o/r/issues', 'POST', { title: '' }, {})
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
