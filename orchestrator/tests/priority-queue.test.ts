jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
  })),
}));

import { PriorityQueue } from '../src/core/priority-queue';

describe('PriorityQueue', () => {
  let queue: PriorityQueue;

  beforeEach(() => {
    queue = new PriorityQueue();
  });

  it('should enqueue tasks and dequeue them in priority order', () => {
    queue.enqueue({ ticketId: 'T1', role: 'default', priority: 'P3' });
    queue.enqueue({ ticketId: 'T2', role: 'default', priority: 'P1' });
    queue.enqueue({ ticketId: 'T3', role: 'default', priority: 'P2' });
    queue.enqueue({ ticketId: 'T4', role: 'default', priority: 'P0' });

    expect(queue.dequeue()?.ticketId).toBe('T4'); // P0
    expect(queue.dequeue()?.ticketId).toBe('T2'); // P1
    expect(queue.dequeue()?.ticketId).toBe('T3'); // P2
    expect(queue.dequeue()?.ticketId).toBe('T1'); // P3
  });

  it('should maintain FIFO order within the same priority', () => {
    queue.enqueue({ ticketId: 'T1', role: 'default', priority: 'P2' });
    queue.enqueue({ ticketId: 'T2', role: 'default', priority: 'P2' });
    queue.enqueue({ ticketId: 'T3', role: 'default', priority: 'P2' });

    expect(queue.dequeue()?.ticketId).toBe('T1');
    expect(queue.dequeue()?.ticketId).toBe('T2');
    expect(queue.dequeue()?.ticketId).toBe('T3');
  });

  it('should interrupt a lower priority task with a P0 task', async () => {
    // Current task is P2
    expect(queue.shouldInterrupt('P2', 'P0')).toBe(true);
    expect(queue.shouldInterrupt('P2', 'P1')).toBe(false);
  });
});
