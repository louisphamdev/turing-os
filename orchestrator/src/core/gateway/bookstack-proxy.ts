/**
 * BookStack Proxy - Proxies BookStack API calls
 * 
 * Intercepts BookStack API calls, injects the real API token from vault,
 * and logs all requests for audit purposes.
 */

import { DecryptedCredential } from '../credential-vault';
import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

export class BookStackProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  /**
   * Get BookStack API URL from config
   */
  private getBookStackConfig(): { apiUrl: string } {
    return {
      apiUrl: process.env.BOOKSTACK_URL || 'http://bookstack:80',
    };
  }

  /**
   * Proxy a BookStack API request
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: { query?: string; variables?: any },
    headers: any
  ): Promise<any> {
    const config = this.getBookStackConfig();

    // Get the real API token from vault
    let credential = await this.vault.getCredentialByType('bookstack');
    
    if (!credential) {
      // Fallback: use environment variable
      const fallbackToken = process.env.BOOKSTACK_TOKEN;
      if (!fallbackToken) {
        throw { message: 'No BookStack credential configured', statusCode: 503 };
      }
      credential = { key: fallbackToken, type: 'bookstack', provider: 'generic', id: 'env', authHeader: 'Bearer' };
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

    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'bookstack',
      method: `${method} /graphql`,
      requestBody: body,
    });

    // Make the actual API call
    const response = await this.makeRequest(targetUrl, method, requestHeaders, body);

    return response;
  }

  /**
   * Make the HTTP request to BookStack
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
          message: `BookStack API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        throw { message: 'BookStack request timeout', statusCode: 504 };
      }
      
      throw error;
    }
  }
}
