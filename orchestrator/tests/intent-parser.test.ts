import { isWorkerDirectedMessage } from '../src/core/intent-parser';

describe('isWorkerDirectedMessage', () => {
  it('should return true for messages explicitly addressing the worker', () => {
    const result = isWorkerDirectedMessage('worker ABC123, run tests');
    expect(result.isDirected).toBe(true);
    expect(result.ticketId).toBe('ABC123');
  });

  it('should handle different formats', () => {
    expect(isWorkerDirectedMessage('hey worker T-42: please restart').isDirected).toBe(true);
    expect(isWorkerDirectedMessage('worker T-42 please restart').isDirected).toBe(true);
    expect(isWorkerDirectedMessage('worker: do this').isDirected).toBe(true); // Matches action words or worker pattern
  });

  it('should return false for regular messages', () => {
    expect(isWorkerDirectedMessage('I think we should refactor this part').isDirected).toBe(false);
    expect(isWorkerDirectedMessage('Hello team!').isDirected).toBe(false);
  });
});
