/**
 * Plane Proxy — Proxies Plane CE API calls through the gateway.
 *
 * Mirrors TaigaProxy. Intercepts Plane REST requests, injects the real
 * API token from the credential vault, scopes the URL to the configured
 * workspace + project, and writes an audit record.
 *
 * The worker receives a `consumer-token` JWT and never sees the raw token.
 */

import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

interface PlaneRequest {
  [key: string]: unknown;
}

export class PlaneProxy {
  private vault: any;
  private auditLogger: AuditLogger;

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
  }

  private getPlaneConfig(): { apiUrl: string; workspace: string; project: string } {
    return {
      apiUrl: (process.env.PLANE_API_URL || '').replace(/\/$/, ''),
      workspace: process.env.PLANE_WORKSPACE_SLUG || '',
      project: process.env.PLANE_PROJECT_ID || '',
    };
  }

  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: PlaneRequest,
    _headers: Record<string, string>
  ): Promise<any> {
    const cfg = this.getPlaneConfig();
    if (!cfg.apiUrl || !cfg.workspace || !cfg.project) {
      throw { message: 'Plane is not configured (PLANE_API_URL / PLANE_WORKSPACE_SLUG / PLANE_PROJECT_ID)', statusCode: 503 };
    }

    let credential = await this.vault.getCredentialByType('plane');
    if (!credential) {
      const fallbackKey = process.env.PLANE_API_TOKEN;
      if (!fallbackKey) {
        throw { message: 'No Plane credential configured', statusCode: 503 };
      }
      credential = { key: fallbackKey, type: 'plane', provider: 'generic', id: 'env', authHeader: 'X-API-Key' };
    }

    const cleanEndpoint = endpoint.replace(/^\//, '');
    const targetUrl = `${cfg.apiUrl}/workspaces/${cfg.workspace}/projects/${cfg.project}/${cleanEndpoint}`;

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      // Plane CE uses X-API-Key. Some forks accept Authorization: Bearer ...
      // The credential's authHeader controls which scheme is used.
      ...(credential.authHeader === 'X-API-Key'
        ? { 'X-API-Key': credential.key }
        : { Authorization: `${credential.authHeader} ${credential.key}` }),
    };

    this.auditLogger.logServiceRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      service: 'plane',
      method: `${method} /${cleanEndpoint}`,
      requestBody: body,
    });

    return this.makeRequest(targetUrl, method, requestHeaders, body);
  }

  private async makeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        throw {
          message: `Plane API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      if (response.status === 204) {
        return { success: true };
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw { message: 'Plane request timeout', statusCode: 504 };
      }
      throw error;
    }
  }
}
