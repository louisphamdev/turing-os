/**
 * Matrix Proxy - Proxies Matrix API calls
 * 
 * Intercepts Matrix API calls, injects the real bot token from vault,
 * and logs all requests for audit purposes.
 */

import { DecryptedCredential } from '../credential-vault';
import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

export class MatrixProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  /**
   * Get Matrix API URL from config
   */
  private getMatrixConfig(): { apiUrl: string } {
    return {
      apiUrl: process.env.SYNAPSE_API_URL || 'http://localhost:8008',
    };
  }

  /**
   * Proxy a Matrix API request
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: any,
    headers: any
  ): Promise<any> {
    const config = this.getMatrixConfig();

    // Get the real bot token from vault
    let credential = await this.vault.getCredentialByType('matrix');
    
    if (!credential) {
      // Fallback: use environment variable
      const fallbackToken = process.env.MATRIX_BOT_TOKEN;
      if (!fallbackToken) {
        throw { message: 'No Matrix credential configured', statusCode: 503 };
      }
      credential = { key: fallbackToken, type: 'matrix', provider: 'generic', id: 'env', authHeader: 'Bearer' };
    }

    // Build the target URL
    const targetUrl = `${config.apiUrl}/_matrix/client/r0/${endpoint}`;
    
    // Build request headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${credential.key}`,
    };

    // Handle Matrix-specific authentication (access_token in query param for some endpoints)
    let finalUrl = targetUrl;
    if (endpoint.includes('login') || endpoint.includes('register')) {
      // These endpoints use different auth
      finalUrl = `${targetUrl}?access_token=${credential.key}`;
    }

    // Log the request (sanitized)
    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'matrix',
      method: `${method} /${endpoint}`,
      requestBody: body,
    });

    // Make the actual API call
    const response = await this.makeRequest(finalUrl, method, requestHeaders, body);

    return response;
  }

  /**
   * Make the HTTP request to Matrix
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
          message: `Matrix API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      // Matrix returns empty body for some responses
      const text = await response.text();
      if (!text) {
        return { success: true };
      }

      return JSON.parse(text);
    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        throw { message: 'Matrix request timeout', statusCode: 504 };
      }
      
      throw error;
    }
  }
}
