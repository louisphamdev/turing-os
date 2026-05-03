/**
 * Health Monitor — Tracks worker heartbeats and detects stuck/dead workers.
 * 
 * Health States:
 *   HEALTHY  → Heartbeat < 2 min ago, progress recent
 *   WARNING  → Missed 1-2 heartbeats
 *   STUCK    → No heartbeat > 6 min OR no progress > 10 min
 *   DEAD     → Missed 3+ heartbeats → kill + respawn
 */

import { config } from '../config';
import { WorkerRegistry } from './registry';
import { DockerService } from './docker';
import { matrixService } from './matrix';
import { alertManager } from './alert-manager';
import { PMStateManager } from './pm-state';

export type HealthStatus = 'healthy' | 'warning' | 'stuck' | 'dead';

export interface WorkerHealthInfo {
  ticketId: string;
  status: HealthStatus;
  lastHeartbeat: number;
  lastProgress: number;
  timeSinceHeartbeat: number;
  timeSinceProgress: number;
  consecutiveMisses: number;
  cpuPercent?: number;
  memoryPercent?: number;
}

export interface ResourceThresholds {
  scaleUpThreshold: number;   // e.g. 80 (percent)
  scaleDownThreshold: number; // e.g. 20 (percent)
  idleTimeoutMinutes: number; // scale down after this long with no tasks
}

export class HealthMonitor {
  private registry: WorkerRegistry;
  private docker: DockerService;
  private pmStateManager: PMStateManager | null = null;
  private consecutiveMisses: Map<string, number> = new Map();

  // Thresholds
  private readonly heartbeatInterval = config.worker.heartbeatIntervalMs; // 2 min
  private readonly stuckThreshold = config.worker.stuckThresholdMs;       // 10 min
  private readonly deadThreshold: number;
  private readonly resourceCheckInterval = config.worker.resourceCheckIntervalMs; // 30s
  private readonly scaleUpThreshold = config.worker.scaleUpThreshold;      // 80%
  private readonly scaleDownThreshold = config.worker.scaleDownThreshold;  // 20%
  private readonly idleTimeoutMinutes = config.worker.idleTimeoutMinutes;   // 5 min

  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private resourceCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastScaleAction = 0;
  private readonly scaleCooldownMs = 60_000; // 1 minute between scale actions

  // ─── Flapping Detection ───────────────────────────────────────────────
  // ticketId → array of recent death timestamps (ms)
  private deathTimestamps: Map<string, number[]> = new Map();
  private readonly flappingWindowMs = 60 * 60 * 1000;   // 60 minutes
  private readonly flappingThreshold = 3;                  // 3 deaths → flapping

  constructor(registry: WorkerRegistry, docker: DockerService) {
    this.registry = registry;
    this.docker = docker;
    this.deadThreshold = this.heartbeatInterval * 3; // 6 min
  }

  /**
   * Set the PM State Manager (called from index.ts after construction)
   */
  setPMStateManager(pm: PMStateManager): void {
    this.pmStateManager = pm;
  }

  /**
   * Start periodic health checks (every 1 minute) and resource monitoring (every 30s)
   */
  start(): void {
    this.checkTimer = setInterval(() => {
      this.checkAll().catch((err) =>
        console.error('[HealthMonitor] Check failed:', err)
      );
    }, 60000);

    this.resourceCheckTimer = setInterval(() => {
      this.checkResources().catch((err) =>
        console.error('[HealthMonitor] Resource check failed:', err)
      );
    }, this.resourceCheckInterval);

    console.log(`[HealthMonitor] Started (health every 60s, resources every ${this.resourceCheckInterval / 1000}s)`);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.resourceCheckTimer) {
      clearInterval(this.resourceCheckTimer);
      this.resourceCheckTimer = null;
    }
  }

  /**
   * Process an incoming heartbeat from a worker
   */
  onHeartbeat(ticketId: string, payload: {
    status?: string;
    currentTask?: string;
    progress?: string;
  }): void {
    this.registry.updateHeartbeat(ticketId);
    this.consecutiveMisses.set(ticketId, 0);

    if (payload.progress) {
      this.registry.updateProgress(ticketId);
    }
  }

  /**
   * Check all workers' health
   */
  async checkAll(): Promise<void> {
    const now = Date.now();
    const workers = this.registry.listActive();

    for (const worker of workers) {
      if (worker.status !== 'RUNNING') continue;

      const timeSinceHeartbeat = now - worker.lastHeartbeat;
      const misses = this.consecutiveMisses.get(worker.ticketId) || 0;

      if (timeSinceHeartbeat > this.deadThreshold) {
        // DEAD — 3+ missed heartbeats
        this.consecutiveMisses.set(worker.ticketId, misses + 1);

        if (misses + 1 >= 3) {
          console.error(`[HealthMonitor] DEAD: Ticket ${worker.ticketId} (no heartbeat ${Math.round(timeSinceHeartbeat / 60000)}min)`);
          await this._handleDead(worker.ticketId);
        }
      } else if (timeSinceHeartbeat > this.heartbeatInterval) {
        // WARNING — missed 1-2 heartbeats
        this.consecutiveMisses.set(worker.ticketId, misses + 1);
        console.warn(`[HealthMonitor] WARNING: Ticket ${worker.ticketId} (heartbeat ${Math.round(timeSinceHeartbeat / 60000)}min ago, misses: ${misses + 1})`);
      } else {
        // HEALTHY
        this.consecutiveMisses.set(worker.ticketId, 0);
      }

      // Check progress staleness
      const timeSinceProgress = now - worker.lastProgress;
      if (timeSinceProgress > this.stuckThreshold && worker.status === 'RUNNING') {
        console.warn(`[HealthMonitor] STUCK (no progress): Ticket ${worker.ticketId} (${Math.round(timeSinceProgress / 60000)}min)`);
        // Send alert via AlertManager (non-blocking)
        alertManager.alertWorkerStuck(worker.ticketId, worker.role, Math.round(timeSinceProgress / 60000)).catch(() => {});
      }
    }

    // Reconcile registry with actual Docker containers
    try {
      // Use listAllWorkerContainers to see both running AND stopped containers
      // This way STOPPED workers are not incorrectly removed from registry during reconciliation
      const containers = await this.docker.listAllWorkerContainers();
      const runningIds = containers.map((c) => c.Id);
      await this.registry.reconcileWithDocker(runningIds);
    } catch (error) {
      console.error('[HealthMonitor] Docker reconciliation failed:', error);
    }
  }

  /**
   * Get health status for all workers
   */
  async getHealthSummary(): Promise<WorkerHealthInfo[]> {
    const now = Date.now();
    const stats = await this.docker.getContainerStats();

    return this.registry.listActive().map((worker) => {
      const timeSinceHeartbeat = now - worker.lastHeartbeat;
      const timeSinceProgress = now - worker.lastProgress;
      const misses = this.consecutiveMisses.get(worker.ticketId) || 0;

      let status: HealthStatus = 'healthy';
      if (timeSinceHeartbeat > this.deadThreshold && misses >= 3) {
        status = 'dead';
      } else if (timeSinceProgress > this.stuckThreshold) {
        status = 'stuck';
      } else if (timeSinceHeartbeat > this.heartbeatInterval) {
        status = 'warning';
      }

      // Attach per-container resource usage if available
      const containerStats = worker.containerId ? stats.get(worker.containerId) : undefined;

      return {
        ticketId: worker.ticketId,
        status,
        lastHeartbeat: worker.lastHeartbeat,
        lastProgress: worker.lastProgress,
        timeSinceHeartbeat,
        timeSinceProgress,
        consecutiveMisses: misses,
        cpuPercent: containerStats ? Math.round(containerStats.cpuPercent * 100) / 100 : undefined,
        memoryPercent: containerStats ? Math.round((containerStats.memoryUsage / containerStats.memoryLimit) * 10000) / 100 : undefined,
      };
    });
  }

  private async _handleDead(ticketId: string): Promise<void> {
    try {
      const worker = this.registry.lookupByTicket(ticketId);
      const role = worker?.role || 'default';
      const roomId = worker?.roomId || '';

      // ─── Flapping Detection ────────────────────────────────────────────
      const now = Date.now();
      const deaths = this.deathTimestamps.get(ticketId) || [];
      const recentDeaths = deaths.filter((ts) => now - ts < this.flappingWindowMs);
      recentDeaths.push(now);
      this.deathTimestamps.set(ticketId, recentDeaths);

      if (recentDeaths.length >= this.flappingThreshold) {
        // FLAPPING — stop auto-respawn, alert critical
        console.error(`[HealthMonitor] FLAPPING detected for ${ticketId}: ${recentDeaths.length} deaths in ${this.flappingWindowMs / 60000}min`);
        await alertManager.alertWorkerFlapping(ticketId, role, recentDeaths.length, Math.round(this.flappingWindowMs / 60000));
        await matrixService.notifyWorkerKilled(
          ticketId,
          `⚠️ Worker FLAPPING (${recentDeaths.length} deaths in 60min). Auto-respawn DISABLED. Manual intervention required.`
        );
        // Do NOT respawn — let human investigate
        return;
      }

      await this.docker.killWorker(ticketId);
      this.registry.remove(ticketId);

      // Send alert via AlertManager (with flapping-aware message)
      await alertManager.alertWorkerDead(
        ticketId,
        role,
        `3+ missed heartbeats (${recentDeaths.length}. recent death in last hour)`
      );

      // ─── PM Failover: Save state before killing PM ────────────────────
      const isPM = role === 'pm';
      if (isPM && this.pmStateManager) {
        console.log(`[HealthMonitor] PM death detected — saving queue state before respawn`);
        this.pmStateManager.saveState();
        await matrixService.sendDM(config.matrix.adminUserId || '',
          `🔄 **PM Failover**\nPM worker \`${ticketId}\` died (3+ missed heartbeats).\n` +
          `Saving queue state → will respawn PM with queue restored.`
        );
      } else {
        await matrixService.notifyWorkerKilled(
          ticketId,
          'Worker unresponsive (3+ missed heartbeats). Killed and respawning...'
        );
      }

      // Respawn the worker
      console.log(`[HealthMonitor] Respawning worker for ticket ${ticketId} (role: ${role})`);
      const containerId = await this.docker.spawnWorker(ticketId, role, roomId);
      this.registry.register(ticketId, 'RUNNING', role, roomId);
      this.registry.update(ticketId, { containerId });

      // ─── PM Failover: Inject queue state after PM respawn ────────────
      if (isPM && this.pmStateManager) {
        // Give PM a moment to start up, then inject queue state
        setTimeout(() => {
          this.pmStateManager!.injectQueueState();
          console.log(`[HealthMonitor] PM queue state injected after respawn`);
        }, 5000);
        await matrixService.notifyWorkerKilled(
          ticketId,
          `PM respawned with queue state restored (container: ${containerId.substring(0, 12)})`
        );
      } else {
        await matrixService.notifyWorkerKilled(
          ticketId,
          `Worker respawned successfully (container: ${containerId.substring(0, 12)})`
        );
      }
    } catch (error) {
      console.error(`[HealthMonitor] Failed to kill/respawn dead worker ${ticketId}:`, error);
    }
  }

  /**
   * Periodic resource check — auto-scale workers based on CPU/RAM usage.
   * Also checks disk space on the host.
   *
   * Scale UP   when avg usage > scaleUpThreshold AND not at max workers
   * Scale DOWN when avg usage < scaleDownThreshold AND running > minWorkers AND idle long enough
   */
  private async checkResources(): Promise<void> {
    const now = Date.now();

    // Rate-limit scale actions
    if (now - this.lastScaleAction < this.scaleCooldownMs) {
      return;
    }

    const runningCount = await this.docker.getRunningWorkerCount();
    const { avgCpuPercent, avgMemoryPercent } = await this.docker.getAverageResourceUsage();
    const avgUsage = Math.max(avgCpuPercent, avgMemoryPercent);

    console.log(`[HealthMonitor] Resource check: ${runningCount} workers running, avg usage ${avgUsage.toFixed(1)}% (CPU: ${avgCpuPercent.toFixed(1)}%, RAM: ${avgMemoryPercent.toFixed(1)}%)`);

    // ─── Disk space check ────────────────────────────────────────────────
    await this._checkDiskSpace().catch((e) =>
      console.error('[HealthMonitor] Disk check failed:', e)
    );

    // Scale UP
    if (avgUsage > this.scaleUpThreshold && runningCount < config.docker.maxWorkers) {
      console.warn(`[HealthMonitor] Scale UP triggered: avg usage ${avgUsage.toFixed(1)}% > threshold ${this.scaleUpThreshold}%`);
      // Trigger scale up via orchestrator — emit event or call back
      this.onScaleNeeded?.('up', { avgCpuPercent, avgMemoryPercent, runningCount });
      this.lastScaleAction = now;
      return;
    }

    // Scale DOWN — only if idle (no active tasks) and below threshold
    if (avgUsage < this.scaleDownThreshold && runningCount > 1) {
      // Check if workers are idle (no recent heartbeats/progress means no active tasks)
      const workers = this.registry.listActive();
      const idleWorkers = workers.filter((w) => {
        const idleMinutes = (now - w.lastProgress) / 60_000;
        return idleMinutes > this.idleTimeoutMinutes && w.status === 'RUNNING';
      });

      if (idleWorkers.length > 0) {
        console.warn(`[HealthMonitor] Scale DOWN triggered: avg usage ${avgUsage.toFixed(1)}% < threshold ${this.scaleDownThreshold}%, ${idleWorkers.length} idle workers`);
        this.onScaleNeeded?.('down', { avgCpuPercent, avgMemoryPercent, runningCount, idleWorkerCount: idleWorkers.length });
        this.lastScaleAction = now;
      }
    }
  }

  /**
   * Check host disk space — alert if > 80% used.
   */
  private async _checkDiskSpace(): Promise<void> {
    try {
      // Use `df -h` to get disk usage on Linux host
      const { execSync } = await import('child_process');
      const output = execSync('df -h / --output=percent,size | tail -1', { timeout: 5000 })
        .toString()
        .trim();

      const parts = output.split(/\s+/);
      const percentStr = parts[0]?.replace('%', '');
      if (!percentStr) return;

      const percentUsed = parseInt(percentStr, 10);
      if (isNaN(percentUsed)) return;

      if (percentUsed >= 80) {
        console.error(`[HealthMonitor] DISK LOW: ${percentUsed}% used`);
        await alertManager.alertDiskLow(percentUsed, `Host disk / is ${percentUsed}% full. Total: ${parts[1] || 'unknown'}.`);
      }
    } catch (error) {
      // df might not be available on all systems — skip silently
      console.debug('[HealthMonitor] Disk check not available:', error);
    }
  }

  /**
   * Callback hook for scale actions — set by the orchestrator.
   */
  public onScaleNeeded?: (direction: 'up' | 'down', context: {
    avgCpuPercent: number;
    avgMemoryPercent: number;
    runningCount: number;
    idleWorkerCount?: number;
  }) => void;
}
