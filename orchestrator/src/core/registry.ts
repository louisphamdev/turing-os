import { ActiveWorker } from './docker';

export class WorkerRegistry {
  private registry: Map<string, ActiveWorker> = new Map();

  register(ticketId: string, status: 'BOOTING' | 'RUNNING' | 'TERMINATING'): void {
    this.registry.set(ticketId, {
      ticketId,
      containerId: '', // Will be updated when container starts
      startTime: Date.now(),
      status
    });
    console.log(`[Registry] Registered ticket ${ticketId} with status ${status}`);
  }

  update(ticketId: string, updates: Partial<ActiveWorker>): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      Object.assign(worker, updates);
      console.log(`[Registry] Updated ticket ${ticketId}:`, updates);
    }
  }

  updateStatus(ticketId: string, status: 'BOOTING' | 'RUNNING' | 'TERMINATING' | 'PENDING'): void {
    const worker = this.registry.get(ticketId);
    if (worker) {
      worker.status = status as any;
      console.log(`[Registry] Status update for ticket ${ticketId}: ${status}`);
    }
  }

  lookupByTicket(ticketId: string): ActiveWorker | undefined {
    return this.registry.get(ticketId);
  }

  remove(ticketId: string): void {
    this.registry.delete(ticketId);
    console.log(`[Registry] Removed ticket ${ticketId}`);
  }

  listActive(): ActiveWorker[] {
    return Array.from(this.registry.values());
  }
}