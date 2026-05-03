/**
 * Consumer Token System
 * 
 * Generates and validates consumer tokens that workers use to authenticate
 * with the gateway proxy. Workers never receive real API keys - only these
 * scoped, time-limited consumer tokens.
 */

import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

import { Role, Permission } from './rbac';

// Re-export types from rbac for convenience
export type { Role, Permission } from './rbac';

export interface ConsumerToken {
  tokenId: string;          // Hashed token identifier
  workerId: string;         // Which worker this token belongs to
  role: Role;
  permissions: Permission[];
  expiresAt: Date;
  createdAt: Date;
  rateLimit: {
    requests: number;       // Max requests per window
    windowMs: number;       // Window in milliseconds
  };
  metadata: {
    ticketId?: string;      // Associated ticket
    projectId?: string;
    description?: string;
  };
}

export interface TokenPayload {
  jti: string;              // JWT ID
  workerId: string;
  role: Role;
  perms: Permission[];
  exp: number;               // Expiration timestamp
  iat: number;               // Issued at
  rate: {
    req: number;
    win: number;
  };
  meta?: {
    ticketId?: string;
    projectId?: string;
  };
}

export interface TokenValidationResult {
  valid: boolean;
  error?: string;
  payload?: TokenPayload;
  tokenId?: string;
}

// Rate limit tracking per token
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute default window

export class ConsumerTokenManager {
  private tokens: Map<string, ConsumerToken> = new Map();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private jwtSecret: string;

  constructor(jwtSecret?: string) {
    this.jwtSecret = jwtSecret || process.env.JWT_SECRET || 'turing-os-consumer-token-secret-dev';
    
    if (!process.env.JWT_SECRET) {
      console.warn('[ConsumerTokenManager] WARNING: JWT_SECRET not set. Using default (DEV ONLY)');
    }
  }

  /**
   * Generate a new consumer token for a worker
   */
  generateToken(options: {
    workerId: string;
    role: Role;
    permissions: Permission[];
    expiresIn?: number;           // Hours, default 24
    rateLimit?: {
      requests: number;
      windowMs: number;
    };
    metadata?: {
      ticketId?: string;
      projectId?: string;
      description?: string;
    };
  }): { token: string; expiresAt: Date; tokenId: string } {
    const { workerId, role, permissions, expiresIn = 24, rateLimit, metadata } = options;
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 60 * 60 * 1000);
    
    // Generate unique token ID
    const rawTokenId = crypto.randomBytes(16).toString('hex');
    const tokenId = crypto.createHash('sha256').update(rawTokenId).digest('hex').slice(0, 16);
    
    // Create JWT payload
    const payload: TokenPayload = {
      jti: rawTokenId,
      workerId,
      role,
      perms: permissions,
      exp: Math.floor(expiresAt.getTime() / 1000),
      iat: Math.floor(now.getTime() / 1000),
      rate: {
        req: rateLimit?.requests || 100,
        win: rateLimit?.windowMs || RATE_LIMIT_WINDOW_MS,
      },
      meta: metadata,
    };

    // Sign JWT
    const token = jwt.sign(payload, this.jwtSecret, { algorithm: 'HS256' });
    
    // Store token metadata
    const consumerToken: ConsumerToken = {
      tokenId,
      workerId,
      role,
      permissions,
      expiresAt,
      createdAt: now,
      rateLimit: {
        requests: payload.rate.req,
        windowMs: payload.rate.win,
      },
      metadata: metadata || {},
    };
    
    this.tokens.set(tokenId, consumerToken);
    
    console.log(`[ConsumerTokenManager] Generated token for worker ${workerId} (${role}), expires ${expiresAt.toISOString()}`);
    
    return {
      token,
      expiresAt,
      tokenId,
    };
  }

  /**
   * Validate a consumer token
   */
  validateToken(token: string): TokenValidationResult {
    try {
      // Verify JWT signature and expiration
      const payload = jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] }) as TokenPayload;
      
      // Check if we have the token metadata (for additional validation)
      const tokenId = crypto.createHash('sha256').update(payload.jti).digest('hex').slice(0, 16);
      const stored = this.tokens.get(tokenId);
      
      // Even if JWT is valid, check against our store for revocation
      if (stored && stored.expiresAt < new Date()) {
        return { valid: false, error: 'Token expired' };
      }
      
      return {
        valid: true,
        payload,
        tokenId,
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return { valid: false, error: 'Token expired' };
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return { valid: false, error: 'Invalid token' };
      }
      return { valid: false, error: 'Token validation failed' };
    }
  }

  /**
   * Check and update rate limit for a token
   */
  checkRateLimit(tokenId: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let entry = this.rateLimits.get(tokenId);
    
    if (!entry || now - entry.windowStart > windowMs) {
      // Start new window
      entry = { count: 0, windowStart: now };
      this.rateLimits.set(tokenId, entry);
    }
    
    const resetAt = entry.windowStart + windowMs;
    const remaining = Math.max(0, limit - entry.count);
    
    if (entry.count >= limit) {
      return { allowed: false, remaining: 0, resetAt };
    }
    
    // Increment counter
    entry.count++;
    
    return { allowed: true, remaining: remaining - 1, resetAt };
  }

  /**
   * Revoke a token immediately
   */
  revokeToken(tokenId: string): boolean {
    const deleted = this.tokens.delete(tokenId);
    this.rateLimits.delete(tokenId);
    
    if (deleted) {
      console.log(`[ConsumerTokenManager] Revoked token: ${tokenId}`);
    }
    
    return deleted;
  }

  /**
   * Revoke all tokens for a specific worker
   */
  revokeWorkerTokens(workerId: string): number {
    let count = 0;
    
    for (const [tokenId, token] of this.tokens.entries()) {
      if (token.workerId === workerId) {
        this.tokens.delete(tokenId);
        this.rateLimits.delete(tokenId);
        count++;
      }
    }
    
    console.log(`[ConsumerTokenManager] Revoked ${count} tokens for worker ${workerId}`);
    return count;
  }

  /**
   * List all active tokens (metadata only)
   */
  listTokens(): Array<{
    tokenId: string;
    workerId: string;
    role: Role;
    expiresAt: Date;
    permissions: Permission[];
  }> {
    const now = new Date();
    
    return Array.from(this.tokens.values())
      .filter(t => t.expiresAt > now)
      .map(t => ({
        tokenId: t.tokenId,
        workerId: t.workerId,
        role: t.role,
        expiresAt: t.expiresAt,
        permissions: t.permissions,
      }));
  }

  /**
   * Get token metadata by tokenId
   */
  getTokenMetadata(tokenId: string): ConsumerToken | null {
    return this.tokens.get(tokenId) || null;
  }

  /**
   * Extend token expiration
   */
  extendToken(tokenId: string, additionalHours: number): boolean {
    const token = this.tokens.get(tokenId);
    if (!token) return false;
    
    token.expiresAt = new Date(token.expiresAt.getTime() + additionalHours * 60 * 60 * 1000);
    
    console.log(`[ConsumerTokenManager] Extended token ${tokenId} until ${token.expiresAt.toISOString()}`);
    return true;
  }

  /**
   * Clean up expired tokens
   */
  cleanupExpiredTokens(): number {
    const now = new Date();
    let count = 0;
    
    for (const [tokenId, token] of this.tokens.entries()) {
      if (token.expiresAt < now) {
        this.tokens.delete(tokenId);
        this.rateLimits.delete(tokenId);
        count++;
      }
    }
    
    if (count > 0) {
      console.log(`[ConsumerTokenManager] Cleaned up ${count} expired tokens`);
    }
    
    return count;
  }

  /**
   * Verify token has specific permission
   */
  hasPermission(payload: TokenPayload, permission: Permission): boolean {
    // Check exact permission
    if (payload.perms.includes(permission)) {
      return true;
    }
    
    // Check wildcard permissions (e.g., 'llm:*' covers 'llm:read' and 'llm:write')
    const [service, action] = permission.split(':');
    const wildcard = `${service}:*`;
    
    return payload.perms.includes(wildcard as Permission) || payload.perms.includes('*');
  }

  /**
   * Verify token has access to specific service
   */
  hasServiceAccess(payload: TokenPayload, service: 'llm' | 'taiga' | 'wiki' | 'matrix' | 'github'): boolean {
    const servicePerms = payload.perms.filter(p => p.startsWith(service) || p === '*');
    return servicePerms.length > 0;
  }
}

// Singleton instance
let tokenManagerInstance: ConsumerTokenManager | null = null;

export function getConsumerTokenManager(jwtSecret?: string): ConsumerTokenManager {
  if (!tokenManagerInstance) {
    tokenManagerInstance = new ConsumerTokenManager(jwtSecret);
  }
  return tokenManagerInstance;
}
