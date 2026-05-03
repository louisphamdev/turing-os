import { createClient } from 'redis';
import { config } from '../config';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface QueuedTask {
  ticketId: string;
  role: string;
  priority: Priority;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'blocked';
  enqueuedAt: number;
  startedAt?: number;
  pausedAt?: number;
  pausedTaskId?: string; // For P0: which task was paused to run this
}

export class PriorityQueue {
  private queue: QueuedTask[] = [];
  private runningTask: QueuedTask | null = null;
  private pausedTasks: Map<string, QueuedTask> = new Map(); // ticketId → paused task
  private maxP0InterruptsPerHour = 5;
  private p0InterruptTimestamps: number[] = [];
  
  private redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  private isRedisConnected = false;

  constructor() {
    this.redisClient.on('error', (err) => console.warn('[PriorityQueue:Redis] Error', err));
    this.redisClient.on('connect', () => {
      console.log('[PriorityQueue:Redis] Connected');
      this.isRedisConnected = true;
      this._loadFromRedis().catch(console.error);
    });
    this.redisClient.connect().catch(() => {
      console.warn('[PriorityQueue:Redis] Initial connect failed, will retry');
    });
  }

  private async _saveToRedis() {
    if (!this.isRedisConnected) return;
    try {
      const state = {
        queue: this.queue,
        runningTask: this.runningTask,
        pausedTasks: Array.from(this.pausedTasks.entries()),
      };
      await this.redisClient.set('turing_os_priority_queue', JSON.stringify(state));
    } catch (err) {
      console.warn('[PriorityQueue:Redis] Save failed', err);
    }
  }

  private async _loadFromRedis() {
    try {
      const data = await this.redisClient.get('turing_os_priority_queue');
      if (data) {
        const state = JSON.parse(data);
        this.queue = state.queue || [];
        this.runningTask = state.runningTask || null;
        this.pausedTasks = new Map(state.pausedTasks || []);
        console.log(`[PriorityQueue:Redis] Restored state (queued: ${this.queue.length})`);
      }
    } catch (err) {
      console.warn('[PriorityQueue:Redis] Load failed', err);
    }
  }

  /**
   * Add a task to the priority queue
   */
  enqueue(task: Omit<QueuedTask, 'enqueuedAt' | 'status'>): QueuedTask {
    const queuedTask: QueuedTask = {
      ...task,
      enqueuedAt: Date.now(),
      status: 'queued',
    };

    // Insert in priority order (P0 first, P3 last), FIFO within same priority
    const priorityOrder: Priority[] = ['P0', 'P1', 'P2', 'P3'];
    const taskPriorityIndex = priorityOrder.indexOf(queuedTask.priority);

    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      const existingPriorityIndex = priorityOrder.indexOf(this.queue[i].priority);
      if (taskPriorityIndex < existingPriorityIndex) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, queuedTask);
    console.log(`[PriorityQueue] Enqueued ${queuedTask.ticketId} (${queuedTask.priority}) at position ${insertIndex + 1}`);
    this._saveToRedis();
    return queuedTask;
  }

  /**
   * Get the next task to run based on priority
   */
  dequeue(): QueuedTask | null {
    if (this.queue.length === 0) return null;
    const task = this.queue.shift() || null;
    this._saveToRedis();
    return task;
  }

  /**
   * Check if a P0 task should interrupt the current running task
   */
  shouldInterrupt(currentPriority: Priority, newPriority: Priority): boolean {
    if (newPriority === 'P0' && currentPriority !== 'P0') {
      // Check P0 interrupt rate limit
      const now = Date.now();
      const oneHourAgo = now - 3600000;
      this.p0InterruptTimestamps = this.p0InterruptTimestamps.filter(t => t > oneHourAgo);

      if (this.p0InterruptTimestamps.length >= this.maxP0InterruptsPerHour) {
        console.warn(`[PriorityQueue] P0 interrupt rate limit reached (${this.maxP0InterruptsPerHour}/hour). Queuing instead.`);
        return false;
      }

      return true;
    }
    return false;
  }

  /**
   * Handle P0 interrupt: pause current task, start P0
   */
  async interruptWithP0(
    p0Task: QueuedTask,
    pauseCurrentFn: (ticketId: string) => Promise<void>
  ): Promise<void> {
    if (this.runningTask) {
      console.log(`[PriorityQueue] P0 interrupt: pausing ${this.runningTask.ticketId} (${this.runningTask.priority})`);

      // Record the interrupt
      this.p0InterruptTimestamps.push(Date.now());

      // Pause current task
      this.runningTask.status = 'paused';
      this.runningTask.pausedAt = Date.now();
      this.pausedTasks.set(this.runningTask.ticketId, this.runningTask);

      await pauseCurrentFn(this.runningTask.ticketId);

      this.runningTask = null;
    }

    // Start P0 task
    this.runningTask = p0Task;
    this.runningTask.status = 'running';
    this.runningTask.startedAt = Date.now();

    console.log(`[PriorityQueue] P0 task ${p0Task.ticketId} is now running`);
    this._saveToRedis();
  }

  /**
   * Mark a task as running
   */
  startTask(task: QueuedTask): void {
    this.runningTask = task;
    task.status = 'running';
    task.startedAt = Date.now();
    this._saveToRedis();
  }

  /**
   * Mark the current task as completed and check for next queued task
   */
  completeTask(ticketId: string): QueuedTask | null {
    if (this.runningTask?.ticketId === ticketId) {
      this.runningTask.status = 'completed';
      this.runningTask = null;
    }

    // Check if there's a paused task to resume
    const pausedTask = this.pausedTasks.get(ticketId);
    if (pausedTask) {
      this.pausedTasks.delete(ticketId);
      pausedTask.status = 'queued';
      pausedTask.pausedAt = undefined;
      this.queue.unshift(pausedTask); // Resume at front of queue
      console.log(`[PriorityQueue] Resuming paused task ${ticketId}`);
    }

    this._saveToRedis();
    // Return next task from queue
    return this.dequeue();
  }

  /**
   * Mark a task as blocked
   */
  blockTask(ticketId: string): void {
    if (this.runningTask?.ticketId === ticketId) {
      this.runningTask.status = 'blocked';
      this.runningTask = null;
    }

    // Remove from queue if present
    this.queue = this.queue.filter(t => t.ticketId !== ticketId);
    this._saveToRedis();
  }

  /**
   * Get the currently running task
   */
  getRunningTask(): QueuedTask | null {
    return this.runningTask;
  }

  /**
   * Get all queued tasks
   */
  getQueuedTasks(): QueuedTask[] {
    return [...this.queue];
  }

  /**
   * Get all paused tasks
   */
  getPausedTasks(): QueuedTask[] {
    return Array.from(this.pausedTasks.values());
  }

  /**
   * Get queue summary
   */
  getSummary(): {
    running: QueuedTask | null;
    queued: number;
    paused: number;
    byPriority: Record<Priority, number>;
  } {
    const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const task of this.queue) {
      byPriority[task.priority]++;
    }

    return {
      running: this.runningTask,
      queued: this.queue.length,
      paused: this.pausedTasks.size,
      byPriority,
    };
  }

  /**
   * Check if a task is already in the queue or running
   */
  hasTask(ticketId: string): boolean {
    if (this.runningTask?.ticketId === ticketId) return true;
    return this.queue.some(t => t.ticketId === ticketId);
  }

  /**
   * Remove a task from the queue
   */
  remove(ticketId: string): boolean {
    const initialLength = this.queue.length;
    this.queue = this.queue.filter(t => t.ticketId !== ticketId);

    if (this.runningTask?.ticketId === ticketId) {
      this.runningTask = null;
    }

    this.pausedTasks.delete(ticketId);
    this._saveToRedis();

    return this.queue.length < initialLength;
  }

  /**
   * Reorder tasks within the same priority level (PO only)
   */
  reorderWithinPriority(ticketId: string, newPriority: Priority): boolean {
    const taskIndex = this.queue.findIndex(t => t.ticketId === ticketId);
    if (taskIndex === -1) return false;

    const task = this.queue[taskIndex];
    task.priority = newPriority;

    // Remove and re-insert in correct position
    this.queue.splice(taskIndex, 1);
    this.enqueue({
      ticketId: task.ticketId,
      role: task.role,
      priority: task.priority,
    });
    // enqueue already saves
    return true;
  }
}

// Singleton instance
export const priorityQueue = new PriorityQueue();
