/**
 * GitHub Proxy — REST passthrough.
 *
 * Forwards the caller's HTTP method, query string, and body to GitHub's REST
 * API at `https://api.github.com/{endpoint}`, injecting the vault-held token
 * in the `Authorization: Bearer <token>` header (GitHub's scheme) plus the
 * `Accept: application/vnd.github+json` header GitHub recommends. Returns the
 * upstream JSON verbatim.
 *
 * The worker receives a `consumer-token` JWT and never sees the raw GITHUB_TOKEN.
 */

import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

export class GithubProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  private getGithubConfig(): { apiUrl: string } {
    // GitHub.com REST API. GITHUB_API_URL allows pointing at a GHES instance
    // (e.g. https://github.example.com/api/v3) without code changes.
    return { apiUrl: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '') };
  }

  /**
   * Proxy a GitHub API request.
   *
   * @param endpoint REST path after `/gateway/github/`, e.g. `repos/o/r/issues`.
   * @param method   HTTP method to forward.
   * @param body     Parsed JSON body (forwarded only for non-safe methods).
   * @param query    Query string params, forwarded verbatim.
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: any,
    query: Record<string, any> = {},
  ): Promise<any> {
    const config = this.getGithubConfig();

    let credential = await this.vault.getCredentialByType('github');
    if (!credential) {
      const fallbackToken = process.env.GITHUB_TOKEN;
      if (!fallbackToken) {
        throw { message: 'No GitHub credential configured', statusCode: 503 };
      }
      credential = { key: fallbackToken, type: 'github', provider: 'generic', id: 'env' };
    }

    const cleanEndpoint = sanitizeEndpoint(endpoint);
    const qs = buildQueryString(query);
    const targetUrl = `${config.apiUrl}/${cleanEndpoint}${qs ? `?${qs}` : ''}`;

    const requestHeaders: Record<string, string> = {
      // GitHub REST recommends pinning the media type.
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub requires a User-Agent on every request.
      'User-Agent': 'turing-os-gateway',
      // GitHub REST accepts `Bearer <token>` (and the legacy `token <token>`).
      'Authorization': `Bearer ${credential.key}`,
    };

    const upperMethod = method.toUpperCase();
    const sendBody = upperMethod !== 'GET' && upperMethod !== 'HEAD' && body !== undefined && body !== null;
    if (sendBody) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'github',
      method: `${upperMethod} /${cleanEndpoint}`,
      requestBody: sendBody ? body : undefined,
    });

    return this.makeRequest(targetUrl, upperMethod, requestHeaders, sendBody ? body : undefined);
  }

  private async makeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: any,
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        throw {
          message: `GitHub API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      const text = await response.text();
      if (!text) return { success: true };
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw { message: 'GitHub request timeout', statusCode: 504 };
      }
      throw error;
    }
  }
}

/**
 * Strip the leading slash and reject path traversal. A worker must not be able
 * to escape `https://api.github.com/` (e.g. `../`, `%2e%2e`) or smuggle a full
 * URL via a scheme/host. Mirrors the leading-slash trimming the other proxies
 * do, but adds an explicit traversal guard since the GitHub endpoint is fully
 * caller-controlled.
 */
function sanitizeEndpoint(endpoint: string): string {
  const cleaned = (endpoint || '').replace(/^\/+/, '');
  const decoded = (() => {
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  })();
  // Reject `..` segments (raw or encoded), backslashes, and absolute/protocol
  // forms that would re-target the host.
  if (
    /(^|\/)\.\.(\/|$)/.test(decoded) ||
    decoded.includes('\\') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(decoded) ||
    decoded.startsWith('//')
  ) {
    throw { message: 'Invalid GitHub endpoint (path traversal rejected)', statusCode: 400 };
  }
  return cleaned;
}

function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}
