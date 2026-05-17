/**
 * BookStack Proxy — REST passthrough.
 *
 * Forwards the caller's HTTP method, query string, and body to BookStack's
 * REST API at `{BOOKSTACK_URL}/api/{endpoint}`, injecting the vault-held
 * API token in the `Authorization: Token <key>` header (BookStack's scheme,
 * not Bearer). Returns the upstream JSON verbatim.
 */

import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

export class BookStackProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  private getBookStackConfig(): { apiUrl: string } {
    return { apiUrl: process.env.BOOKSTACK_URL || 'http://bookstack:80' };
  }

  /**
   * Proxy a BookStack API request.
   *
   * @param endpoint REST path after `/gateway/bookstack/`, e.g. `pages/123`.
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
    const config = this.getBookStackConfig();

    let credential = await this.vault.getCredentialByType('bookstack');
    if (!credential) {
      const fallbackToken = process.env.BOOKSTACK_TOKEN;
      if (!fallbackToken) {
        throw { message: 'No BookStack credential configured', statusCode: 503 };
      }
      credential = { key: fallbackToken, type: 'bookstack', provider: 'generic', id: 'env' };
    }

    const cleanEndpoint = (endpoint || '').replace(/^\/+/, '');
    const qs = buildQueryString(query);
    const targetUrl = `${config.apiUrl}/api/${cleanEndpoint}${qs ? `?${qs}` : ''}`;

    const requestHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Token ${credential.key}`,
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
      service: 'bookstack',
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
          message: `BookStack API error: ${response.status} ${response.statusText}`,
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
        throw { message: 'BookStack request timeout', statusCode: 504 };
      }
      throw error;
    }
  }
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
