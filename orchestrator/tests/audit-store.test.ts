jest.mock('redis', () => ({
  createClient: jest.fn(() => {
    const listStore: Record<string, string[]> = {};
    return {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      lPush: jest.fn(async (key: string, value: string) => {
        listStore[key] = listStore[key] || [];
        listStore[key].unshift(value);
        return listStore[key].length;
      }),
      lTrim: jest.fn(async (key: string, _start: number, stop: number) => {
        if (listStore[key]) listStore[key] = listStore[key].slice(0, stop + 1);
        return 'OK';
      }),
      lRange: jest.fn(async (key: string, start: number, stop: number) => {
        const arr = listStore[key] || [];
        return arr.slice(start, stop + 1);
      }),
      expire: jest.fn(async () => 1),
      // Below are not used by AuditStore but other singletons may share the mock.
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
    };
  }),
}));

import { AuditStore } from '../src/core/security/audit-store';

async function settle(): Promise<void> {
  // Allow the constructor's async _connect to finish.
  await new Promise((r) => setImmediate(r));
}

describe('AuditStore', () => {
  it('records and tails entries through Redis', async () => {
    const store = new AuditStore({ maxLen: 50, ttlSeconds: 60 });
    await settle();

    await store.record('prompt-filter', { ticketId: 'T-1', reason: 'rm -rf' });
    await store.record('prompt-filter', { ticketId: 'T-2', reason: 'fork bomb' });

    const tail = await store.tail('prompt-filter', 5);
    expect(tail).toHaveLength(2);
    // LPUSH puts newest first.
    expect(tail[0].payload).toEqual({ ticketId: 'T-2', reason: 'fork bomb' });
    expect(tail[1].payload).toEqual({ ticketId: 'T-1', reason: 'rm -rf' });
  });

  it('returns empty list for unknown channel', async () => {
    const store = new AuditStore();
    await settle();
    const tail = await store.tail('nope', 10);
    expect(tail).toEqual([]);
  });

  it('caps results to requested count', async () => {
    const store = new AuditStore();
    await settle();
    for (let i = 0; i < 10; i++) {
      await store.record('gateway', { i });
    }
    const tail = await store.tail('gateway', 3);
    expect(tail).toHaveLength(3);
  });
});
