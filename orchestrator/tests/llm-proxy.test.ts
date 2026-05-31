/**
 * Unit tests for LLMProxy credential resolution.
 * Network calls are mocked so the test stays hermetic.
 *
 * Focus: the "fall back to any LLM credential" path. The provider-specific
 * lookup returns null, but a non-matching-provider key exists in the vault.
 * Before P1-7 this threw `TypeError: Cannot set properties of null`.
 */

import { LLMProxy } from '../src/core/gateway/llm-proxy';

const tokenPayload = {
  workerId: 'w-1',
  role: 'software-engineer' as const,
  jti: 'tok-1',
  perms: ['llm:call'],
  rate: { req: 60, win: 60_000 },
};

describe('LLMProxy credential resolution', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation(
      jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json', entries: () => [] },
        json: async () => ({ id: 'resp-1' }),
      })) as any
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('uses the provider-specific credential when available', async () => {
    const vault = {
      getCredentialByType: jest.fn(async (_type: string, provider?: string) =>
        provider === 'openai'
          ? { key: 'openai-key', type: 'llm', provider: 'openai', id: 'v1' }
          : null
      ),
    };
    const auditLogger = { logLLMRequest: jest.fn() };
    const proxy = new LLMProxy(vault, auditLogger as any);

    await proxy.proxy(tokenPayload as any, 'chat/completions', 'POST', { model: 'gpt-4o' }, {});

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer openai-key');
  });

  it('falls back to any LLM credential when the provider-specific one is missing', async () => {
    // Provider-specific lookup (with provider arg) returns null; the bare
    // "any" lookup returns a credential for a different provider.
    const vault = {
      getCredentialByType: jest.fn(async (_type: string, provider?: string) =>
        provider
          ? null
          : { key: 'fallback-key', type: 'llm', provider: 'anthropic', id: 'v2' }
      ),
    };
    const auditLogger = { logLLMRequest: jest.fn() };
    const proxy = new LLMProxy(vault, auditLogger as any);

    // This must NOT throw a TypeError (the pre-fix null-deref bug).
    await expect(
      proxy.proxy(tokenPayload as any, 'chat/completions', 'POST', { model: 'gpt-4o' }, {})
    ).resolves.toEqual({ id: 'resp-1' });

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer fallback-key');
  });

  it('throws a 503 when no LLM credential is configured at all', async () => {
    const vault = {
      getCredentialByType: jest.fn(async () => null),
    };
    const auditLogger = { logLLMRequest: jest.fn() };
    const proxy = new LLMProxy(vault, auditLogger as any);

    await expect(
      proxy.proxy(tokenPayload as any, 'chat/completions', 'POST', { model: 'gpt-4o' }, {})
    ).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('No LLM credential'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
