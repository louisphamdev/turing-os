import * as fs from 'fs';
import { PriorityQueue, QueuedTask } from './priority-queue';
import { WorkerRegistry } from './registry';
import { ActiveWorker } from './docker';
import { config } from '../config';

export interface PMState {
  pmTicketId: string;
  pmContainerId: string;
  pmStartTime: number;
  queueState: {
    queue: QueuedTask[];
    runningTask: QueuedTask | null;
    pausedTasks: [string, QueuedTask][];
  };
  timestamp: number;
}

/**
 * PM State Manager — persists PM state to JSON for failover.
 * 
 * On PM crash: Orchestrator reads saved state, spawns new PM,
 * and injects queue context so PM can resume dispatching immediately.
 */
export class PMStateManager {
  private persistPath: string;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private priorityQueue: PriorityQueue;
  private registry: WorkerRegistry;

  constructor(priorityQueue: PriorityQueue, registry: WorkerRegistry) {
    this.persistPath = process.env.PM_STATE_PATH || '/tmp/turing-pm-state.json';
    this.priorityQueue = priorityQueue;
    this.registry = registry;
  }

  /**
   * Start auto-persist every 30 seconds
   */
  startAutoPersist(): void {
    this.persistTimer = setInterval(() => {
      this.saveState();
    }, 30000);
    console.log('[PMState] Auto-persist started (30s interval)');
  }

  /**
   * Save current PM state to disk
   */
  saveState(): void {
    try {
      const pmWorker = this._getPMWorker();
      const state: PMState = {
        pmTicketId: pmWorker?.ticketId || '',
        pmContainerId: pmWorker?.containerId || '',
        pmStartTime: pmWorker?.startTime || Date.now(),
        queueState: {
          queue: this.priorityQueue.getQueuedTasks(),
          runningTask: this.priorityQueue.getRunningTask(),
          pausedTasks: this.priorityQueue.getPausedTasks().map(t => [t.ticketId, t] as [string, QueuedTask]),
        },
        timestamp: Date.now(),
      };

      const data = JSON.stringify(state, null, 2);
      fs.writeFileSync(this.persistPath, data, 'utf-8');
      console.log(`[PMState] Saved state to ${this.persistPath} (queue: ${state.queueState.queue.length} queued)`);
    } catch (error) {
      console.warn(`[PMState] Failed to save state: ${error}`);
    }
  }

  /**
   * Load PM state from disk (called on startup to check for failover)
   */
  loadState(): PMState | null {
    try {
      if (!fs.existsSync(this.persistPath)) {
        return null;
      }
      const data = fs.readFileSync(this.persistPath, 'utf-8');
      const state: PMState = JSON.parse(data);
      console.log(`[PMState] Loaded state from ${this.persistPath} (saved at ${new Date(state.timestamp).toISOString()})`);
      return state;
    } catch (error) {
      console.warn(`[PMState] Failed to load state: ${error}`);
      return null;
    }
  }

  /**
   * Check if PM state is stale (older than 2 minutes = possible PM death)
   */
  isStateStale(): boolean {
    const state = this.loadState();
    if (!state) return false;
    const staleMs = 2 * 60 * 1000; // 2 minutes
    return Date.now() - state.timestamp > staleMs;
  }

  /**
   * Get the saved PM worker info
   */
  getSavedPMInfo(): { ticketId: string; containerId: string } | null {
    const state = this.loadState();
    if (!state || !state.pmTicketId) return null;
    return {
      ticketId: state.pmTicketId,
      containerId: state.pmContainerId,
    };
  }

  /**
   * Clear saved PM state (called after successful failover)
   */
  clearState(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        fs.unlinkSync(this.persistPath);
        console.log('[PMState] Cleared saved state');
      }
    } catch (error) {
      console.warn(`[PMState] Failed to clear state: ${error}`);
    }
  }

  /**
   * Inject saved queue state into priority queue (called when new PM starts)
   */
  injectQueueState(): void {
    const state = this.loadState();
    if (!state) {
      console.log('[PMState] No saved state to inject');
      return;
    }

    // Restore queue tasks
    for (const task of state.queueState.queue) {
      // Only re-enqueue if not already in queue/running
      if (!this.priorityQueue.hasTask(task.ticketId)) {
        this.priorityQueue.enqueue({
          ticketId: task.ticketId,
          role: task.role,
          priority: task.priority,
        });
      }
    }

    console.log(`[PMState] Injected ${state.queueState.queue.length} queued tasks into priority queue`);
  }

  private _getPMWorker(): ActiveWorker | undefined {
    // Find worker with role 'pm'
    return this.registry.listActive().find(w => w.role === 'pm');
  }

  /**
   * Stop auto-persist (on shutdown)
   */
  stopAutoPersist(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.saveState(); // Final save on shutdown
  }
}
