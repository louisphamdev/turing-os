import { ActiveWorker } from './docker';
import { createClient } from 'redis';

/**
 * Worker Registry — tracks all active workers in-memory with periodic Redis persistence.
 * 
 * STRICT RULE #3: Register BEFORE provisioning to prevent duplicates.
 */
export class WorkerRegistry {
  private registry: Map<string, ActiveWorker> = new Map();
  private persistPath: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  private isRedisConnected = false;

  constructor(persistPath: string = '/tmp/turing-registry.json') {
    this.persistPath = persistPath;
    
    this.redisClient.on('error', (err) => console.warn('[Registry:Redis] Error', err));
    this.redisClient.on('connect', () => {
      console.log('[Registry:Redis] Connected');
      this.isRedisConnected = true;
      this._loadFromRedis().catch(() => this._loadFromDisk()); // fallback to disk
    });
    this.redisClient.connect().catch(() => {
      console.warn('[Registry:Redis] Initial connect failed, falling back to disk');
      this._loadFromDisk();
    });

    // Auto-persist every 30 seconds
    this.persistTimer = setInterval(() => {
      this._saveToRedis().catch(() => this._saveToDisk());
    }, 30000);
  }

  register(ticketId: string, status: ActiveWorker['status'], role: string = 'default', roomId: string = ''): void {
    this.registry.set(ticketId, {
      ticketId,
      containerId: '',
      role,
      roomId,
      startTime: Date.now(),
      status,
      lastHeartbeat: Date.now(),
      lastProgress: Date.now(),
      lastBlockedReason: undefined,
    });
    console.log(`[Registry] Registered ticket ${ticketId} (role: ${role}, status: ${status})`);
    this._saveToRedis().catch(() => this._saveToDisk());
  }

  update(ticketId: string, updates: Partial<ActiveWorker>): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      Object.assign(worker, updates);
      console.log(`[Registry] Updated ticket ${ticketId}:`, Object.keys(updates).join(', '));
      this._saveToRedis().catch(() => this._saveToDisk());
    } else {
      console.warn(`[Registry] Attempted to update unknown ticket ${ticketId}`);
    }
  }

  updateStatus(ticketId: string, status: ActiveWorker['status']): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      const oldStatus = worker.status;
      worker.status = status;
      if (status !== 'BLOCKED') {
        worker.lastBlockedReason = undefined;
      }
      console.log(`[Registry] Status: ${ticketId} ${oldStatus} → ${status}`);
      this._saveToRedis().catch(() => this._saveToDisk());
    } else {
      console.warn(`[Registry] Attempted to update status of unknown ticket ${ticketId}`);
    }
  }

  updateHeartbeat(ticketId: string): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
    }
  }

  updateProgress(ticketId: string): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      worker.lastProgress = Date.now();
    }
  }

  lookupByTicket(ticketId: string): ActiveWorker | undefined {
    return this.registry.get(ticketId);
  }

  lookupByContainer(containerId: string): ActiveWorker | undefined {
    for (const worker of this.registry.values()) {
      if (worker.containerId === containerId) {
        return worker;
      }
    }
    return undefined;
  }

  remove(ticketId: string): void {
    if (this.registry.delete(ticketId)) {
      console.log(`[Registry] Removed ticket ${ticketId}`);
      this._saveToRedis().catch(() => this._saveToDisk());
    }
  }

  listActive(): ActiveWorker[] {
    return Array.from(this.registry.values());
  }

  listByStatus(status: ActiveWorker['status']): ActiveWorker[] {
    return this.listActive().filter((w) => w.status === status);
  }

  count(): number {
    return this.registry.size;
  }

  /**
   * Get workers that may be stuck (no heartbeat within threshold)
   */
  getStuckWorkers(heartbeatThresholdMs: number): ActiveWorker[] {
    const now = Date.now();
    return this.listActive().filter(
      (w) => w.status === 'RUNNING' && now - w.lastHeartbeat > heartbeatThresholdMs
    );
  }

  /**
   * Clean up workers that are no longer running as containers.
   * STOPPED workers are preserved — they have a valid container that is just paused.
   * Only RUNNING workers whose container has disappeared are removed.
   */
  async reconcileWithDocker(runningContainerIds: string[]): Promise<void> {
    const runningSet = new Set(runningContainerIds);
    for (const [ticketId, worker] of this.registry.entries()) {
      if (
        worker.containerId &&
        worker.status === 'RUNNING' &&
        !runningSet.has(worker.containerId)
      ) {
        console.warn(`[Registry] Container for ticket ${ticketId} no longer running, removing`);
        this.registry.delete(ticketId);
      }
      // STOPPED workers are intentionally NOT removed — their container still exists (just paused)
    }
    await this._saveToRedis().catch(() => this._saveToDisk());
  }

  private async _saveToRedis(): Promise<void> {
    if (!this.isRedisConnected) throw new Error('Redis not connected');
    const data = JSON.stringify(Array.from(this.registry.entries()));
    await this.redisClient.set('turing_os_registry', data);
  }

  private async _loadFromRedis(): Promise<void> {
    const data = await this.redisClient.get('turing_os_registry');
    if (data) {
      const entries: [string, ActiveWorker][] = JSON.parse(data);
      for (const [key, value] of entries) {
        this.registry.set(key, value);
      }
      console.log(`[Registry] Restored ${entries.length} workers from Redis`);
    }
  }

  private _saveToDisk(): void {
    try {
      const data = JSON.stringify(Array.from(this.registry.entries()), null, 2);
      const fs = require('fs');
      fs.writeFileSync(this.persistPath, data, 'utf-8');
    } catch {
      // Silently ignore persistence errors (e.g. read-only filesystem)
    }
  }

  private _loadFromDisk(): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.persistPath)) {
        const data = fs.readFileSync(this.persistPath, 'utf-8');
        const entries: [string, ActiveWorker][] = JSON.parse(data);
        for (const [key, value] of entries) {
          this.registry.set(key, value);
        }
        console.log(`[Registry] Restored ${entries.length} workers from disk`);
      }
    } catch (error) {
      console.warn(`[Registry] Failed to load from disk: ${error}`);
    }
  }

  destroy(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this._saveToDisk();
  }
}