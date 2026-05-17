/**
 * Lightweight Redis-backed audit store for security signals.
 *
 * Two channels are exposed today:
 *   - prompt-filter — every reject from scanTaskDescription
 *   - gateway       — every proxy call (success or error)
 *
 * Storage strategy: Redis LIST with LPUSH + LTRIM keeps the newest N
 * entries, and EXPIRE caps total retention. When Redis is unreachable we
 * fall back to an in-memory ring buffer so callers can still query
 * recent events; nothing is lost from the application's perspective.
 */

import { createClient, RedisClientType } from 'redis';

const DEFAULT_MAXLEN = 50_000;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface AuditRecord {
  ts: number;
  channel: string;
  // Free-form structured payload; never put secrets here.
  payload: Record<string, unknown>;
}

export class AuditStore {
  private redis: RedisClientType | null = null;
  private mirror: Map<string, AuditRecord[]> = new Map();
  private maxLen: number;
  private ttlSeconds: number;

  constructor(opts: { maxLen?: number; ttlSeconds?: number } = {}) {
    this.maxLen = opts.maxLen ?? DEFAULT_MAXLEN;
    this.ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this._connect().catch((err) => {
      console.warn('[AuditStore] Redis connect failed:', err?.message || err);
    });
  }

  private async _connect(): Promise<void> {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const client = createClient({ url }) as RedisClientType;
    client.on('error', () => undefined);
    await client.connect();
    this.redis = client;
  }

  private key(channel: string): string {
    return `audit:${channel}`;
  }

  private memoryAppend(channel: string, record: AuditRecord): void {
    let bucket = this.mirror.get(channel);
    if (!bucket) {
      bucket = [];
      this.mirror.set(channel, bucket);
    }
    bucket.unshift(record);
    if (bucket.length > this.maxLen) {
      bucket.length = this.maxLen;
    }
  }

  /** Append an entry. Best-effort; never throws. */
  async record(channel: string, payload: Record<string, unknown>): Promise<void> {
    const entry: AuditRecord = { ts: Date.now(), channel, payload };
    this.memoryAppend(channel, entry);

    if (!this.redis) return;
    const k = this.key(channel);
    try {
      await this.redis.lPush(k, JSON.stringify(entry));
      await this.redis.lTrim(k, 0, this.maxLen - 1);
      await this.redis.expire(k, this.ttlSeconds);
    } catch (err: any) {
      console.warn(`[AuditStore] Redis write to ${k} failed:`, err?.message || err);
    }
  }

  /** Read the most-recent N records (defaults to 100). */
  async tail(channel: string, count = 100): Promise<AuditRecord[]> {
    if (count <= 0) return [];
    if (this.redis) {
      try {
        const items = await this.redis.lRange(this.key(channel), 0, count - 1);
        return items.map((s: string) => {
          try {
            return JSON.parse(s) as AuditRecord;
          } catch {
            return { ts: 0, channel, payload: { raw: s } };
          }
        });
      } catch (err: any) {
        console.warn(`[AuditStore] Redis read of ${channel} failed:`, err?.message || err);
      }
    }
    const bucket = this.mirror.get(channel) || [];
    return bucket.slice(0, count);
  }
}

let singleton: AuditStore | null = null;

export function getAuditStore(): AuditStore {
  if (!singleton) singleton = new AuditStore();
  return singleton;
}
