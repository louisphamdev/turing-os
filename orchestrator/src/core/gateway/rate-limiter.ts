/**
 * Rate Limiter - Token bucket rate limiting for gateway requests
 * 
 * Implements rate limiting per consumer token to prevent abuse.
 */

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  requests: number;      // Bucket size
  windowMs: number;      // Refill window in milliseconds
}

export class RateLimiter {
  private limits: Map<string, RateLimitEntry> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup stale entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupInterval.unref?.();
  }

  /**
   * Check if a request is allowed under rate limiting
   */
  check(
    key: string, 
    config: RateLimitConfig
  ): { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number } {
    const now = Date.now();
    let entry = this.limits.get(key);

    // Initialize or refill bucket
    if (!entry || now - entry.lastRefill >= config.windowMs) {
      entry = {
        tokens: config.requests,
        lastRefill: now,
      };
      this.limits.set(key, entry);
    }

    // Calculate tokens to add based on time elapsed
    const elapsed = now - entry.lastRefill;
    const refillRate = config.requests / config.windowMs;
    const tokensToAdd = Math.floor(elapsed * refillRate);
    
    if (tokensToAdd > 0) {
      entry.tokens = Math.min(config.requests, entry.tokens + tokensToAdd);
      entry.lastRefill = now;
    }

    const remaining = Math.max(0, entry.tokens);
    const resetAt = entry.lastRefill + config.windowMs;

    if (entry.tokens <= 0) {
      // Calculate when next token will be available
      const retryAfter = Math.ceil((config.windowMs - elapsed) / 1000);
      return { 
        allowed: false, 
        remaining: 0, 
        resetAt,
        retryAfter,
      };
    }

    // Consume one token
    entry.tokens--;
    this.limits.set(key, entry);

    return {
      allowed: true,
      remaining: entry.tokens,
      resetAt,
    };
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    this.limits.delete(key);
  }

  /**
   * Reset all rate limits
   */
  resetAll(): void {
    this.limits.clear();
  }

  /**
   * Get current rate limit status for a key
   */
  getStatus(key: string, config: RateLimitConfig): {
    remaining: number;
    resetAt: number;
    windowMs: number;
  } {
    const entry = this.limits.get(key);
    
    if (!entry) {
      return {
        remaining: config.requests,
        resetAt: Date.now() + config.windowMs,
        windowMs: config.windowMs,
      };
    }

    return {
      remaining: Math.max(0, entry.tokens),
      resetAt: entry.lastRefill + config.windowMs,
      windowMs: config.windowMs,
    };
  }

  /**
   * Cleanup stale entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.limits.entries()) {
      // Remove entries older than 2 windows without activity
      if (now - entry.lastRefill > 2 * 60 * 1000) {
        this.limits.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[RateLimiter] Cleaned up ${cleaned} stale entries`);
    }
  }

  /**
   * Shutdown
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Alias for shutdown() — stops the cleanup timer. */
  stop(): void {
    this.shutdown();
  }
}

/**
 * Create rate limit config from role-based limits
 */
export function createRateLimitConfig(requestsPerMinute: number): RateLimitConfig {
  return {
    requests: requestsPerMinute,
    windowMs: 60 * 1000, // 1 minute window
  };
}
