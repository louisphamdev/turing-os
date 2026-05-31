jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  })),
}));

import { WorkerRegistry } from '../src/core/registry';
import { ActiveWorker } from '../src/core/docker';

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;

  beforeEach(() => {
    registry = new WorkerRegistry('/tmp/turing-test-registry.json');
    // Clear the file before each test
    try {
      const fs = require('fs');
      if (fs.existsSync('/tmp/turing-test-registry.json')) {
        fs.unlinkSync('/tmp/turing-test-registry.json');
      }
    } catch {}
  });

  afterEach(() => {
    registry.destroy();
  });

  it('should register a worker and look it up by ticket', () => {
    registry.register('TICKET-001', 'RUNNING', 'software-engineer', '!room:abc');
    const worker = registry.lookupByTicket('TICKET-001');
    expect(worker).toBeDefined();
    expect(worker!.ticketId).toBe('TICKET-001');
    expect(worker!.role).toBe('software-engineer');
    expect(worker!.status).toBe('RUNNING');
    expect(worker!.roomId).toBe('!room:abc');
  });

  it('should update worker fields', () => {
    registry.register('TICKET-002', 'BOOTING', 'qa');
    registry.update('TICKET-002', {
      containerId: 'abc123',
      status: 'RUNNING',
    });
    const worker = registry.lookupByTicket('TICKET-002');
    expect(worker!.containerId).toBe('abc123');
    expect(worker!.status).toBe('RUNNING');
  });

  it('should update worker status', () => {
    registry.register('TICKET-003', 'RUNNING', 'devops');
    registry.updateStatus('TICKET-003', 'BLOCKED');
    const worker = registry.lookupByTicket('TICKET-003');
    expect(worker!.status).toBe('BLOCKED');
  });

  it('should remove a worker', () => {
    registry.register('TICKET-004', 'RUNNING', 'data');
    registry.remove('TICKET-004');
    expect(registry.lookupByTicket('TICKET-004')).toBeUndefined();
  });

  it('should list all active workers', () => {
    registry.register('T1', 'RUNNING', 'se');
    registry.register('T2', 'RUNNING', 'qa');
    registry.register('T3', 'BLOCKED', 'devops');
    const all = registry.listActive();
    expect(all.length).toBe(3);
  });

  it('should list workers by status', () => {
    registry.register('T1', 'RUNNING', 'se');
    registry.register('T2', 'BLOCKED', 'qa');
    registry.register('T3', 'BLOCKED', 'devops');
    const blocked = registry.listByStatus('BLOCKED');
    expect(blocked.length).toBe(2);
    expect(blocked.every((w) => w.status === 'BLOCKED')).toBe(true);
  });

  it('should count workers', () => {
    expect(registry.count()).toBe(0);
    registry.register('T1', 'RUNNING', 'se');
    registry.register('T2', 'RUNNING', 'qa');
    expect(registry.count()).toBe(2);
  });

  it('should lookup by container ID', () => {
    registry.register('T1', 'RUNNING', 'se');
    registry.update('T1', { containerId: 'container-abc' });
    const worker = registry.lookupByContainer('container-abc');
    expect(worker!.ticketId).toBe('T1');
  });

  it('should find stuck workers', () => {
    registry.register('T1', 'RUNNING', 'se');
    // Simulate old heartbeat
    registry.update('T1', {
      lastHeartbeat: Date.now() - 20 * 60 * 1000, // 20 min ago
    });
    const stuck = registry.getStuckWorkers(10 * 60 * 1000); // 10 min threshold
    expect(stuck.length).toBe(1);
    expect(stuck[0].ticketId).toBe('T1');
  });

  it('should update heartbeat', () => {
    registry.register('T1', 'RUNNING', 'se');
    const before = registry.lookupByTicket('T1')!.lastHeartbeat;
    // Advance time
    registry.updateHeartbeat('T1');
    const after = registry.lookupByTicket('T1')!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('should update progress', () => {
    registry.register('T1', 'RUNNING', 'se');
    const before = registry.lookupByTicket('T1')!.lastProgress;
    registry.updateProgress('T1');
    const after = registry.lookupByTicket('T1')!.lastProgress;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('should not update unknown ticket', () => {
    // Should not throw
    registry.update('UNKNOWN', { status: 'RUNNING' });
    registry.updateStatus('UNKNOWN', 'BLOCKED');
    registry.updateHeartbeat('UNKNOWN');
    registry.updateProgress('UNKNOWN');
    registry.remove('UNKNOWN');
  });

  it('should reconcile with Docker — remove unknown containers', async () => {
    registry.register('T1', 'RUNNING', 'se');
    registry.update('T1', { containerId: 'container-1' });
    registry.register('T2', 'RUNNING', 'qa');
    registry.update('T2', { containerId: 'container-2' });

    // Only container-1 is running in Docker
    await registry.reconcileWithDocker(['container-1']);

    // T1 should remain, T2 should be removed (container not running)
    expect(registry.lookupByTicket('T1')).toBeDefined();
    expect(registry.lookupByTicket('T2')).toBeUndefined();
  });

  it('should reconcile with Docker — keep STOPPED workers even without a live container', async () => {
    // Ephemeral model: a STOPPED worker legitimately has no container
    // (auto-removed on stop). It must NOT be pruned — startWorker() recreates it.
    registry.register('STOPPED-1', 'STOPPED', 'se', '!room:abc');
    registry.update('STOPPED-1', { containerId: 'old-container-gone' });

    // No containers are running in Docker at all.
    await registry.reconcileWithDocker([]);

    const worker = registry.lookupByTicket('STOPPED-1');
    expect(worker).toBeDefined();
    expect(worker!.status).toBe('STOPPED');
    // role/roomId preserved so startWorker() can recreate from them
    expect(worker!.role).toBe('se');
    expect(worker!.roomId).toBe('!room:abc');
  });
});
