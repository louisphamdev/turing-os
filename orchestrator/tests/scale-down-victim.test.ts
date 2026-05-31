import { selectScaleDownVictim } from '../src/core/health-monitor';
import { ActiveWorker } from '../src/core/docker';

/**
 * Unit tests for the scale-down victim selection (Task P2-8).
 *
 * The OLD behaviour terminated the OLDEST RUNNING worker by startTime, which
 * could kill a busy long-running task. The new helper must instead pick the
 * MOST-IDLE worker, never one that is actively making progress, and never drop
 * below MIN_WORKERS.
 */
describe('selectScaleDownVictim', () => {
  const NOW = 1_000_000_000_000; // fixed "now" for deterministic tests
  const MIN = 60_000; // 1 minute idle threshold
  const FLOOR = 1; // MIN_WORKERS default

  // Helper to build a worker with sensible defaults.
  const w = (over: Partial<ActiveWorker>): ActiveWorker => ({
    containerId: 'c-' + (over.ticketId || 'x'),
    ticketId: 'T',
    role: 'se',
    roomId: '!room',
    startTime: NOW - 10 * 60_000,
    status: 'RUNNING',
    lastHeartbeat: NOW,
    lastProgress: NOW,
    ...over,
  });

  it('selects the MOST-idle worker, NOT the oldest', () => {
    const workers: ActiveWorker[] = [
      // Oldest by startTime but actively progressing — must NOT be chosen.
      w({ ticketId: 'OLDEST', startTime: NOW - 60 * 60_000, lastProgress: NOW, lastHeartbeat: NOW }),
      // Newer but most idle — this is the right victim.
      w({ ticketId: 'IDLE-LONG', startTime: NOW - 5 * 60_000, lastProgress: NOW - 30 * 60_000, lastHeartbeat: NOW - 30 * 60_000 }),
      // Idle but less so than IDLE-LONG.
      w({ ticketId: 'IDLE-SHORT', startTime: NOW - 4 * 60_000, lastProgress: NOW - 5 * 60_000, lastHeartbeat: NOW - 5 * 60_000 }),
    ];
    const victim = selectScaleDownVictim(workers, NOW, MIN, FLOOR);
    expect(victim).not.toBeNull();
    expect(victim!.ticketId).toBe('IDLE-LONG');
  });

  it('never selects an actively-progressing worker', () => {
    const workers: ActiveWorker[] = [
      // Stale heartbeat but VERY recent progress → actively working, off-limits.
      w({ ticketId: 'PROGRESSING', lastProgress: NOW - 1_000, lastHeartbeat: NOW - 30 * 60_000 }),
      // Truly idle on both signals.
      w({ ticketId: 'IDLE', lastProgress: NOW - 20 * 60_000, lastHeartbeat: NOW - 20 * 60_000 }),
    ];
    const victim = selectScaleDownVictim(workers, NOW, MIN, FLOOR);
    expect(victim!.ticketId).toBe('IDLE');
  });

  it('treats a recent heartbeat as activity even when progress is stale', () => {
    const workers: ActiveWorker[] = [
      // No progress for a while, but heartbeat is fresh → not idle.
      w({ ticketId: 'HEARTBEATING', lastProgress: NOW - 30 * 60_000, lastHeartbeat: NOW - 1_000 }),
      w({ ticketId: 'IDLE', lastProgress: NOW - 10 * 60_000, lastHeartbeat: NOW - 10 * 60_000 }),
    ];
    const victim = selectScaleDownVictim(workers, NOW, MIN, FLOOR);
    expect(victim!.ticketId).toBe('IDLE');
  });

  it('returns null when no worker has been idle past the threshold', () => {
    const workers: ActiveWorker[] = [
      w({ ticketId: 'A', lastProgress: NOW - 10_000, lastHeartbeat: NOW - 10_000 }),
      w({ ticketId: 'B', lastProgress: NOW - 20_000, lastHeartbeat: NOW - 20_000 }),
    ];
    // idle threshold is 60s; both are < 60s idle.
    expect(selectScaleDownVictim(workers, NOW, MIN, FLOOR)).toBeNull();
  });

  it('respects MIN_WORKERS — does not scale below the floor', () => {
    // Two idle workers, but floor is 2 → stopping one would breach it.
    const workers: ActiveWorker[] = [
      w({ ticketId: 'A', lastProgress: NOW - 30 * 60_000, lastHeartbeat: NOW - 30 * 60_000 }),
      w({ ticketId: 'B', lastProgress: NOW - 40 * 60_000, lastHeartbeat: NOW - 40 * 60_000 }),
    ];
    expect(selectScaleDownVictim(workers, NOW, MIN, 2)).toBeNull();
    // With floor 1, the most-idle (B) is stoppable.
    const victim = selectScaleDownVictim(workers, NOW, MIN, 1);
    expect(victim!.ticketId).toBe('B');
  });

  it('returns null at the MIN_WORKERS floor even if the worker is idle', () => {
    const workers: ActiveWorker[] = [
      w({ ticketId: 'ONLY', lastProgress: NOW - 60 * 60_000, lastHeartbeat: NOW - 60 * 60_000 }),
    ];
    // 1 running worker, floor 1 → cannot stop it.
    expect(selectScaleDownVictim(workers, NOW, MIN, 1)).toBeNull();
  });

  it('only considers RUNNING workers as candidates', () => {
    const workers: ActiveWorker[] = [
      // Most idle, but STOPPED → not a candidate (and not counted toward floor).
      w({ ticketId: 'STOPPED-IDLE', status: 'STOPPED', lastProgress: NOW - 90 * 60_000, lastHeartbeat: NOW - 90 * 60_000 }),
      w({ ticketId: 'RUN-1', status: 'RUNNING', lastProgress: NOW - 10 * 60_000, lastHeartbeat: NOW - 10 * 60_000 }),
      w({ ticketId: 'RUN-2', status: 'RUNNING', lastProgress: NOW - 20 * 60_000, lastHeartbeat: NOW - 20 * 60_000 }),
    ];
    const victim = selectScaleDownVictim(workers, NOW, MIN, FLOOR);
    expect(victim!.ticketId).toBe('RUN-2');
  });

  it('returns null for an empty worker list', () => {
    expect(selectScaleDownVictim([], NOW, MIN, FLOOR)).toBeNull();
  });

  it('breaks ties deterministically by ticketId', () => {
    const workers: ActiveWorker[] = [
      w({ ticketId: 'ZEBRA', lastProgress: NOW - 30 * 60_000, lastHeartbeat: NOW - 30 * 60_000 }),
      w({ ticketId: 'ALPHA', lastProgress: NOW - 30 * 60_000, lastHeartbeat: NOW - 30 * 60_000 }),
      // Active one, never chosen.
      w({ ticketId: 'BUSY', lastProgress: NOW, lastHeartbeat: NOW }),
    ];
    const victim = selectScaleDownVictim(workers, NOW, MIN, FLOOR);
    expect(victim!.ticketId).toBe('ALPHA');
  });
});
