/**
 * Gateway Proxy Handler
 * 
 * Main routing handler for all gateway proxy requests.
 * Validates tokens, enforces RBAC, and routes to appropriate service proxies.
 */

import { Request, Response } from 'express';
import { getConsumerTokenManager, TokenValidationResult } from '../consumer-token';
import { getRBACService, methodToAction } from '../rbac';
import { getCredentialVault, DecryptedCredential } from '../credential-vault';
import { AuditLogger, AuditEntry } from './audit-logger';
import { RateLimiter } from './rate-limiter';
import { LLMProxy } from './llm-proxy';
import { PlaneProxy } from './plane-proxy';
import { BookStackProxy } from './bookstack-proxy';
import { MatrixProxy } from './matrix-proxy';

export interface GatewayConfig {
  enabled: boolean;
  baseUrl: string;
  port: number;
}

export class ProxyHandler {
  private tokenManager = getConsumerTokenManager();
  private rbac = getRBACService();
  private vault = getCredentialVault();
  private auditLogger = AuditLogger.getInstance();
  private rateLimiter = new RateLimiter();
  
  private llmProxy: LLMProxy;
  private planeProxy: PlaneProxy;
  private bookstackProxy: BookStackProxy;
  private matrixProxy: MatrixProxy;

  constructor() {
    this.llmProxy = new LLMProxy(this.vault, this.auditLogger);
    this.planeProxy = new PlaneProxy(this.vault, this.auditLogger);
    this.bookstackProxy = new BookStackProxy(this.vault, this.auditLogger);
    this.matrixProxy = new MatrixProxy(this.vault, this.auditLogger);
  }

  /**
   * Main request handler - routes to appropriate service proxy
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const startTime = Date.now();
    const path = req.path;
    const method = req.method;

    // Extract service and endpoint from path: /gateway/{service}/{endpoint}
    const pathParts = path.split('/').filter(Boolean); // ['gateway', 'llm', 'chat', 'completions']
    
    if (pathParts.length < 2 || pathParts[0] !== 'gateway') {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const service = pathParts[1] as 'llm' | 'plane' | 'bookstack' | 'matrix' | 'health';
    
    // Health check endpoint
    if (service === 'health') {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    // Validate authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.slice(7); // Remove 'Bearer ' prefix

    // Validate token
    const validation = this.tokenManager.validateToken(token);
    if (!validation.valid || !validation.payload) {
      res.status(401).json({ error: validation.error || 'Invalid token' });
      return;
    }

    // Check rate limit
    const rateLimit = validation.payload.rate;
    const rateCheck = this.tokenManager.checkRateLimit(
      validation.tokenId!,
      rateLimit.req,
      rateLimit.win
    );

    res.setHeader('X-RateLimit-Limit', rateLimit.req);
    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
    res.setHeader('X-RateLimit-Reset', rateCheck.resetAt);

    if (!rateCheck.allowed) {
      res.status(429).json({ 
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000)
      });
      return;
    }

    // Check service access permission.
    if (!this.rbac.canAccessService(validation.payload.role, service)) {
      res.status(403).json({ error: `Access denied for service: ${service}` });
      return;
    }

    // Enforce method-level action for non-LLM services. LLM semantics don't
    // map cleanly to read/write (a POST to /chat/completions is conceptually
    // "read a completion"), so service-level access is the strongest check
    // applied there. For plane/bookstack/matrix/github, GET/HEAD requires
    // `<service>:read` and mutations require `<service>:write`.
    if (service !== 'llm') {
      const action = methodToAction(method);
      if (!this.rbac.canPerformAction(validation.payload.role, service, action)) {
        res.status(403).json({
          error: `Access denied: role '${validation.payload.role}' lacks ${service}:${action} permission`,
        });
        return;
      }
    }

    // Route to appropriate proxy
    try {
      let result: any;
      const endpoint = pathParts.slice(2).join('/');

      switch (service) {
        case 'llm':
          result = await this.llmProxy.proxy(validation.payload, endpoint, method, req.body, req.headers);
          break;
        case 'plane':
          result = await this.planeProxy.proxy(
            validation.payload,
            endpoint,
            method,
            req.body,
            req.headers as unknown as Record<string, string>
          );
          break;
        case 'bookstack':
          result = await this.bookstackProxy.proxy(
            validation.payload,
            endpoint,
            method,
            req.body,
            req.query as Record<string, any>,
          );
          break;
        case 'matrix':
          result = await this.matrixProxy.proxy(validation.payload, endpoint, method, req.body, req.headers);
          break;
        default:
          res.status(400).json({ error: `Unknown service: ${service}` });
          return;
      }

      // Log successful request
      const duration = Date.now() - startTime;
      this.auditLogger.log({
        workerId: validation.payload.workerId,
        role: validation.payload.role,
        tokenId: validation.tokenId!,
        service,
        method: `${method} /${endpoint}`,
        requestHeaders: this.sanitizeHeaders(req.headers),
        requestBody: this.sanitizeBody(req.body),
        responseStatus: 200,
        duration,
      });

      res.status(200).json(result);

    } catch (error: any) {
      const duration = Date.now() - startTime;

      // Log failed request
      this.auditLogger.log({
        workerId: validation.payload.workerId,
        role: validation.payload.role,
        tokenId: validation.tokenId!,
        service,
        method: `${method} /${pathParts.slice(2).join('/')}`,
        requestHeaders: this.sanitizeHeaders(req.headers),
        requestBody: this.sanitizeBody(req.body),
        responseStatus: error.statusCode || 500,
        duration,
        error: error.message,
      });

      console.error(`[ProxyHandler] ${service} proxy error:`, error);
      res.status(error.statusCode || 500).json({ 
        error: error.message || 'Internal gateway error' 
      });
    }
  }

  /**
   * Get credential for a service from vault
   */
  async getCredentialForService(
    service: 'llm' | 'plane' | 'bookstack' | 'matrix' | 'github'
  ): Promise<DecryptedCredential | null> {
    // Map service to provider
    const providerMap: Record<string, string | undefined> = {
      llm: 'openai', // Default, can be overridden per request
      plane: undefined,
      bookstack: undefined,
      matrix: undefined,
      github: undefined,
    };

    return this.vault.getCredentialByType(service, providerMap[service]);
  }

  /**
   * Sanitize headers for logging (remove sensitive values)
   */
  private sanitizeHeaders(headers: any): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
    
    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        sanitized[key] = value.slice(0, 100);
      }
    }
    
    return sanitized;
  }

  /**
   * Sanitize body for logging (remove sensitive fields)
   */
  private sanitizeBody(body: any): any {
    if (!body) return undefined;

    const sensitiveFields = [
      'api_key', 'apiKey', 'apikey',
      'token', 'access_token', 'refresh_token',
      'password', 'secret', 'authorization',
      'llm_api_key', 'plane_api_token', 'bookstack_token',
      'matrix_bot_token', 'github_token',
    ];

    try {
      const sanitized = JSON.parse(JSON.stringify(body));
      this.removeSensitiveFields(sanitized, sensitiveFields);
      return sanitized;
    } catch {
      return '[Complex Body]';
    }
  }

  /**
   * Recursively remove sensitive fields from object
   */
  private removeSensitiveFields(obj: any, sensitiveFields: string[]): void {
    if (!obj || typeof obj !== 'object') return;

    for (const key of Object.keys(obj)) {
      if (sensitiveFields.some(sf => key.toLowerCase().includes(sf.toLowerCase()))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        this.removeSensitiveFields(obj[key], sensitiveFields);
      }
    }
  }
}

// Singleton
let proxyHandlerInstance: ProxyHandler | null = null;

export function getProxyHandler(): ProxyHandler {
  if (!proxyHandlerInstance) {
    proxyHandlerInstance = new ProxyHandler();
  }
  return proxyHandlerInstance;
}
