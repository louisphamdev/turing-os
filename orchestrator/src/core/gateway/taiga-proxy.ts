/**
 * Taiga Proxy - Proxies Taiga API calls
 * 
 * Intercepts Taiga API calls, injects the real API key from vault,
 * and logs all requests for audit purposes.
 */

import { DecryptedCredential } from '../credential-vault';
import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

interface TaigaRequest {
  project?: string;
  epic?: any;
  userStory?: any;
  task?: any;
  issue?: any;
  [key: string]: any;
}

export class TaigaProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  /**
   * Get Taiga API URL from config
   */
  private getTaigaConfig(): { apiUrl: string } {
    return {
      apiUrl: process.env.TAIGA_API_URL || 'https://api.taiga.io/api/v1',
    };
  }

  /**
   * Proxy a Taiga API request
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: TaigaRequest,
    headers: any
  ): Promise<any> {
    const config = this.getTaigaConfig();

    // Get the real API key from vault
    let credential = await this.vault.getCredentialByType('taiga');
    
    if (!credential) {
      // Fallback: use environment variable directly (for initial migration)
      const fallbackKey = process.env.TAIGA_API_KEY;
      if (!fallbackKey) {
        throw { message: 'No Taiga credential configured', statusCode: 503 };
      }
      credential = { key: fallbackKey, type: 'taiga', provider: 'generic', id: 'env', authHeader: 'Bearer' };
    }

    // Build the target URL
    const targetUrl = `${config.apiUrl}/${endpoint}`;
    
    // Build request headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `${credential.authHeader} ${credential.key}`,
    };

    // Log the request
    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'taiga',
      method: `${method} /${endpoint}`,
      requestBody: body,
    });

    // Make the actual API call
    const response = await this.makeRequest(targetUrl, method, requestHeaders, body);

    return response;
  }

  /**
   * Make the HTTP request to Taiga
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
          message: `Taiga API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return { success: true };
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        throw { message: 'Taiga request timeout', statusCode: 504 };
      }
      
      throw error;
    }
  }
}
