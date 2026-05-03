/**
 * Wiki Proxy - Proxies Wiki.js GraphQL calls
 * 
 * Intercepts Wiki.js API calls, injects the real JWT token from vault,
 * and logs all requests for audit purposes.
 */

import { DecryptedCredential } from '../credential-vault';
import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

export class WikiProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  /**
   * Get Wiki API URL from config
   */
  private getWikiConfig(): { apiUrl: string } {
    return {
      apiUrl: process.env.WIKI_URL || 'http://localhost:3001',
    };
  }

  /**
   * Proxy a Wiki.js GraphQL request
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: { query?: string; variables?: any },
    headers: any
  ): Promise<any> {
    const config = this.getWikiConfig();

    // Get the real JWT token from vault
    let credential = await this.vault.getCredentialByType('wiki');
    
    if (!credential) {
      // Fallback: use environment variable
      const fallbackToken = process.env.WIKI_JWT_TOKEN;
      if (!fallbackToken) {
        throw { message: 'No Wiki credential configured', statusCode: 503 };
      }
      credential = { key: fallbackToken, type: 'wiki', provider: 'generic', id: 'env', authHeader: 'Bearer' };
    }

    // Build the target URL
    const targetUrl = endpoint === 'graphql' || !endpoint
      ? `${config.apiUrl}/graphql`
      : `${config.apiUrl}/${endpoint}`;
    
    // Build request headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${credential.key}`,
    };

    // Log the request
    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'wiki',
      method: `${method} /graphql`,
      requestBody: body,
    });

    // Make the actual API call
    const response = await this.makeRequest(targetUrl, method, requestHeaders, body);

    return response;
  }

  /**
   * Make the HTTP request to Wiki.js
   */
  private async makeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

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
          message: `Wiki API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        throw { message: 'Wiki request timeout', statusCode: 504 };
      }
      
      throw error;
    }
  }
}
