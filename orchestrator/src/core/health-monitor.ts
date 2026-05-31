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
import { ActiveWorker, DockerService } from './docker';
import { matrixService } from './matrix';
import { alertManager } from './alert-manager';
import { PMStateManager } from './pm-state';

export type HealthStatus = 'healthy' | 'warning' | 'stuck' | 'dead';

/**
 * Choose which worker to terminate on scale-down.
 *
 * Selection rules (P2-8):
 *   1. Only RUNNING workers are candidates.
 *   2. A worker is a candidate ONLY if it is actually IDLE — i.e. it has made
 *      no progress AND received no heartbeat within `idleMs`. A worker that is
 *      actively making progress (recent `lastProgress`) is NEVER selected, even
 *      if its heartbeat is briefly stale.
 *   3. Among idle candidates we pick the MOST idle: the largest "idle age",
 *      measured as time since `lastProgress`, falling back to `lastHeartbeat`
 *      when they differ (we use the more recent of the two as the activity
 *      signal, so a worker that recently heartbeat but hasn't reported progress
 *      is treated as more-active than one silent on both).
 *   4. We never scale below `minWorkers` RUNNING workers — if doing so would
 *      drop the running count to/below the floor, no victim is returned.
 *
 * Returns the victim worker, or `null` when there is nothing safe to stop.
 */
export function selectScaleDownVictim(
  workers: ActiveWorker[],
  now: number,
  idleMs: number,
  minWorkers: number,
): ActiveWorker | null {
  const running = workers.filter((w) => w.status === 'RUNNING');

  // Honor the floor: stopping a worker must not drop us to/below minWorkers.
  if (running.length <= minWorkers) {
    return null;
  }

  // "Idle age" = time since the worker last showed ANY sign of activity.
  // We treat the most-recent of lastProgress / lastHeartbeat as that signal so
  // an actively-progressing (or recently-heartbeating) worker is never idle.
  const idleAge = (w: ActiveWorker): number =>
    now - Math.max(w.lastProgress, w.lastHeartbeat);

  const idleCandidates = running.filter((w) => idleAge(w) > idleMs);
  if (idleCandidates.length === 0) {
    return null;
  }

  // Most idle first (largest idle age). Stable tie-break on ticketId so the
  // choice is deterministic.
  idleCandidates.sort((a, b) => {
    const diff = idleAge(b) - idleAge(a);
    if (diff !== 0) return diff;
    return a.ticketId.localeCompare(b.ticketId);
  });

  return idleCandidates[0];
}

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
  private readonly minWorkers = config.worker.minWorkers;                   // never scale below this

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
    this.checkTimer.unref?.();

    this.resourceCheckTimer = setInterval(() => {
      this.checkResources().catch((err) =>
        console.error('[HealthMonitor] Resource check failed:', err)
      );
    }, this.resourceCheckInterval);
    this.resourceCheckTimer.unref?.();

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

  /**
   * Handle a dead worker — recovery hierarchy:
   * 
   *   1. Doctor First — spawn Doctor to diagnose WHY worker died
   *      └─ Doctor can identify root cause (OOM, crash loop, dependency issue)
   *      └─ If fixable: Doctor applies fix, then respawn with checkpoint
   *   
   *   2. Checkpoint Recovery — only if Doctor couldn't fix
   *      └─ Worker checkpoint exists → respawn + restore from checkpoint
   *      └─ No checkpoint → fresh spawn (acceptable loss)
   *   
   *   3. Flapping Detection — 3+ deaths in 60min = STOP, let human investigate
   */
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

      // ─── PM role detection (needed before Doctor call for PM-specific path) ───
      const isPM = role === 'pm';

      // ─── STEP 1: Doctor Diagnosis (BEFORE respawn) ──────────────────────
      // Doctor investigates WHY the worker died — INCLUDING PM deaths.
      // Doctor has PM-specific tools (check_pm_health, check_pm_queue_state,
      // check_pm_failover_readiness) to diagnose PM failures.
      // For PM deaths, Doctor will classify as PM_FAILURE (P0) and suggest
      // restart_pm / check_pm_logs fix scripts.
      let doctorResult: { fix_applied: boolean; diagnosis: string } = { fix_applied: false, diagnosis: '' };

      try {
        doctorResult = await this._invokeDoctorForWorkerDeath(ticketId, role);
      } catch (doctorErr) {
        console.warn(`[HealthMonitor] Doctor diagnosis failed (will proceed without it): ${doctorErr}`);
      }

      // Send alert via AlertManager
      await alertManager.alertWorkerDead(
        ticketId,
        role,
        `3+ missed heartbeats. Doctor: ${doctorResult.diagnosis || 'not consulted'}`
      );

      // ─── STEP 2: Checkpoint-aware Respawn ───────────────────────────────
      // isPM was computed above — use it directly to avoid recomputing from registry

      // If Doctor identified a fix, notify that fix was applied
      if (doctorResult.fix_applied) {
        await matrixService.notifyWorkerKilled(
          ticketId,
          `Worker died (3+ HBs). Doctor applied fix: ${doctorResult.diagnosis}. ` +
          `Respawning with checkpoint recovery...`
        );
      } else if (isPM && this.pmStateManager) {
        console.log(`[HealthMonitor] PM death detected — saving queue state before respawn`);
        await this.pmStateManager.saveState();
        await matrixService.sendDM(config.matrix.adminUserId || '',
          `🔄 **PM Failover**\nPM worker \`${ticketId}\` died (3+ missed heartbeats).\n` +
          `Doctor: ${doctorResult.diagnosis || 'no diagnosis'}.\n` +
          `Saving queue state → will respawn PM with queue restored.`
        );
      } else {
        const deathNote = doctorResult.diagnosis
          ? `Worker died (3+ HBs). Doctor could not fix: ${doctorResult.diagnosis}`
          : `Worker died (3+ HBs). No checkpoint or Doctor fix available.`;
        await matrixService.notifyWorkerKilled(ticketId, deathNote + ' Respawning fresh...');
      }

      // ─── PM Failover ──────────────────────────────────────────────────
      if (isPM && this.pmStateManager) {
        setTimeout(() => {
          this.pmStateManager!.injectQueueState();
          console.log(`[HealthMonitor] PM queue state injected after respawn`);
        }, 5000);
      }

      // ─── STEP 3: Respawn Worker ───────────────────────────────────────
      // New worker will automatically load checkpoint if available (see worker checkpoint flow)
      console.log(`[HealthMonitor] Respawning worker for ticket ${ticketId} (role: ${role})`);
      const containerId = await this.docker.spawnWorker(ticketId, role, roomId);
      this.registry.register(ticketId, 'RUNNING', role, roomId);
      this.registry.update(ticketId, { containerId });

      // ─── STEP 4: Notify Recovery Complete ──────────────────────────────
      if (isPM) {
        await matrixService.notifyWorkerKilled(
          ticketId,
          `PM respawned with queue state restored (container: ${containerId.substring(0, 12)})`
        );
      } else if (doctorResult.fix_applied) {
        await matrixService.notifyWorkerKilled(
          ticketId,
          `Worker respawned successfully (container: ${containerId.substring(0, 12)}). ` +
          `Doctor fix applied: ${doctorResult.diagnosis}`
        );
      } else {
        await matrixService.notifyWorkerKilled(
          ticketId,
          `Worker respawned successfully (container: ${containerId.substring(0, 12)}). ` +
          `Will resume from checkpoint if available.`
        );
      }
    } catch (error) {
      console.error(`[HealthMonitor] Failed to handle dead worker ${ticketId}:`, error);
    }
  }

  /**
   * Invoke Doctor to diagnose why a worker died.
   * 
   * Doctor is the Crown Jewel — it identifies root cause so the same
   * death doesn't happen again after respawn.
   * 
   * Recovery Priority:
   *   1. Doctor fix → apply fix → respawn with checkpoint (FAST)
   *   2. Doctor can't fix → respawn with checkpoint anyway (work preserved)
   *   3. No checkpoint → fresh spawn (acceptable loss)
   */
  private async _invokeDoctorForWorkerDeath(ticketId: string, workerRole: string): Promise<{ fix_applied: boolean; diagnosis: string }> {
    console.log(`[HealthMonitor] Consulting Doctor for worker death: ${ticketId} (role: ${workerRole})`);

    // Spawn a temporary Doctor worker to investigate
    const doctorTicketId = `DOCTOR-${ticketId}-${Date.now()}`;
    const doctorRoomId = await matrixService.createWorkerRoom('doctor', doctorTicketId);

    try {
      // Spawn Doctor container
      const doctorContainerId = await this.docker.spawnWorker(doctorTicketId, 'doctor', doctorRoomId || '');
      console.log(`[HealthMonitor] Doctor spawned: ${doctorContainerId.substring(0, 12)} for diagnosis`);

      // Give Doctor time to start and run diagnosis (max 2 minutes)
      await new Promise<void>((resolve) => setTimeout(resolve, 120_000));

      // Check if Doctor completed — look at checkpoint or container logs
      const doctorDiagnosis = await this._getDoctorDiagnosis(doctorTicketId, ticketId);

      // Kill Doctor container after diagnosis
      try { await this.docker.stopWorker(doctorTicketId); } catch { /* ignore */ }
      try { matrixService.unregisterWorkerRoom(doctorTicketId); } catch { /* ignore */ }

      if (doctorDiagnosis.fix_applied) {
        console.log(`[HealthMonitor] Doctor applied fix for ${ticketId}: ${doctorDiagnosis.diagnosis}`);
        return doctorDiagnosis;
      } else {
        console.log(`[HealthMonitor] Doctor could not fix ${ticketId}: ${doctorDiagnosis.diagnosis}`);
        return doctorDiagnosis;
      }
    } catch (error) {
      console.error(`[HealthMonitor] Doctor diagnosis error for ${ticketId}: ${error}`);
      // Doctor failed — don't block recovery, just note it
      return { fix_applied: false, diagnosis: `Doctor error: ${error}` };
    }
  }

  /**
   * Get Doctor's diagnosis result by reading Doctor's checkpoint file.
   * Doctor saves its findings to the shared checkpoint volume.
   */
  private async _getDoctorDiagnosis(doctorTicketId: string, _originalTicketId: string): Promise<{ fix_applied: boolean; diagnosis: string }> {
    // Doctor writes diagnosis to a well-known path on the shared volume
    const doctorDiagnosisPath = `/tmp/worker-checkpoint-${doctorTicketId}.json`;
    
    try {
      // Try to read Doctor's checkpoint — it contains the diagnosis result
      // The checkpoint manager saves this when Doctor runs its pipeline
      // For now, we'll check if the container has logged anything useful
      
      const containers = await this.docker.listAllWorkerContainers();
      const doctorContainer = containers.find((c) =>
        c.Labels?.['ticket-id'] === doctorTicketId
      );

      if (doctorContainer && doctorContainer.State === 'exited') {
        // Doctor exited — check its exit code
        // Exit code 0 = fix applied, Exit code 1 = could not fix, Exit code 2 = error
        if (doctorContainer.Status?.includes('Exited (0)')) {
          return { fix_applied: true, diagnosis: 'Doctor successfully diagnosed and applied fix' };
        } else if (doctorContainer.Status?.includes('Exited (1)')) {
          return { fix_applied: false, diagnosis: 'Doctor could not determine root cause' };
        } else {
          return { fix_applied: false, diagnosis: `Doctor exited with status: ${doctorContainer.Status}` };
        }
      }
    } catch {
      // Container check failed — assume no diagnosis
    }

    // Fallback: no diagnosis available yet or Doctor still running
    return { fix_applied: false, diagnosis: 'Doctor diagnosis not yet available' };
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

    // Scale DOWN — only if there is an actually-idle worker we can safely stop
    // without dropping below minWorkers, and we're below the usage threshold.
    if (avgUsage < this.scaleDownThreshold && runningCount > this.minWorkers) {
      // Pick the most-idle RUNNING worker (never one actively making progress).
      // selectScaleDownVictim also enforces the minWorkers floor.
      const idleMs = this.idleTimeoutMinutes * 60_000;
      const victim = selectScaleDownVictim(this.registry.listActive(), now, idleMs, this.minWorkers);

      if (victim) {
        console.warn(`[HealthMonitor] Scale DOWN triggered: avg usage ${avgUsage.toFixed(1)}% < threshold ${this.scaleDownThreshold}%, most-idle worker ${victim.ticketId}`);
        this.onScaleNeeded?.('down', {
          avgCpuPercent,
          avgMemoryPercent,
          runningCount,
          idleTicketId: victim.ticketId,
        });
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
    /** On scale-down: the ticketId of the most-idle worker chosen to stop. */
    idleTicketId?: string;
  }) => void;
}
