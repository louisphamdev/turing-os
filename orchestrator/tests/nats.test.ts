jest.mock('nats', () => ({
  connect: jest.fn(),
  JSONCodec: () => ({ encode: (v: unknown) => Buffer.from(JSON.stringify(v)), decode: (b: Buffer) => JSON.parse(b.toString()) }),
  RetentionPolicy: { Workqueue: 'workqueue', Limits: 'limits' },
}));

import { NatsService } from '../src/core/nats';

describe('NatsService.workerSubject', () => {
  it('builds canonical worker subject', () => {
    expect(NatsService.workerSubject('software-engineer', 'TASK-001', 'event'))
      .toBe('turing.worker.software-engineer.TASK-001.event');
  });

  it('sanitises role and ticket', () => {
    expect(NatsService.workerSubject('Software Engineer!', 'task/with spaces', 'inbox'))
      .toBe('turing.worker.software-engineer-.task-with-spaces.inbox');
  });

  it('falls back to "unknown" for empty inputs', () => {
    expect(NatsService.workerSubject('', '', 'heartbeat'))
      .toBe('turing.worker.unknown.unknown.heartbeat');
  });
});

describe('NatsService default state', () => {
  it('respects NATS_ENABLED=false (default)', () => {
    const svc = new NatsService({ enabled: false });
    expect(svc.isEnabled()).toBe(false);
    expect(svc.isConnected()).toBe(false);
  });

  it('publish() is a no-op when disabled', async () => {
    const svc = new NatsService({ enabled: false });
    await expect(svc.publish('turing.worker.x.y.event', { hello: 'world' })).resolves.toBe(false);
  });
});
