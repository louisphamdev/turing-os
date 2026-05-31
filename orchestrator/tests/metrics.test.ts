/**
 * Unit tests for the hand-rolled Prometheus metrics module.
 *
 * Hermetic: the registry and priority-queue are plain mocks (no Redis, no
 * Docker), so we only exercise the metrics rendering + in-process counters.
 */

import {
  incGatewayRequest,
  incGatewayError,
  statusClassOf,
  renderMetrics,
  _resetMetrics,
  RenderMetricsOptions,
} from '../src/core/metrics';

// Build a fake registry whose listActive() returns workers with the given
// statuses, and a fake priority queue with the given summary.
function makeOpts(
  statuses: string[],
  summary: { running: boolean; queued: number; paused: number }
): RenderMetricsOptions {
  return {
    registry: {
      listActive: () => statuses.map((status, i) => ({ ticketId: `T${i}`, status })) as any,
    },
    priorityQueue: {
      getSummary: () => ({
        running: summary.running ? ({ ticketId: 'R1' } as any) : null,
        queued: summary.queued,
        paused: summary.paused,
        byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      }),
    },
  };
}

const EMPTY_OPTS = makeOpts([], { running: false, queued: 0, paused: 0 });

describe('metrics module', () => {
  beforeEach(() => {
    _resetMetrics();
  });

  describe('statusClassOf', () => {
    it('buckets codes into 2xx/4xx/5xx', () => {
      expect(statusClassOf(200)).toBe('2xx');
      expect(statusClassOf(201)).toBe('2xx');
      expect(statusClassOf(301)).toBe('2xx'); // 3xx folds down to 2xx bucket
      expect(statusClassOf(404)).toBe('4xx');
      expect(statusClassOf(429)).toBe('4xx');
      expect(statusClassOf(500)).toBe('5xx');
      expect(statusClassOf(503)).toBe('5xx');
    });
  });

  describe('counters', () => {
    it('renders valid counter lines with _total and correct # TYPE headers', () => {
      incGatewayRequest('llm', '2xx');
      incGatewayRequest('plane', '4xx');
      incGatewayError('plane');

      const out = renderMetrics(EMPTY_OPTS);

      expect(out).toContain('# TYPE turing_gateway_requests_total counter');
      expect(out).toContain('# HELP turing_gateway_requests_total');
      expect(out).toContain('turing_gateway_requests_total{service="llm",status_class="2xx"} 1');
      expect(out).toContain('turing_gateway_requests_total{service="plane",status_class="4xx"} 1');

      expect(out).toContain('# TYPE turing_gateway_errors_total counter');
      expect(out).toContain('turing_gateway_errors_total{service="plane"} 1');
    });

    it('counters are monotonic — repeated increments accumulate', () => {
      incGatewayRequest('llm', '2xx');
      incGatewayRequest('llm', '2xx');
      incGatewayRequest('llm', '2xx');
      incGatewayError('llm');
      incGatewayError('llm');

      const out = renderMetrics(EMPTY_OPTS);
      expect(out).toContain('turing_gateway_requests_total{service="llm",status_class="2xx"} 3');
      expect(out).toContain('turing_gateway_errors_total{service="llm"} 2');
    });

    it('keeps distinct label sets as distinct series', () => {
      incGatewayRequest('llm', '2xx');
      incGatewayRequest('llm', '5xx');

      const out = renderMetrics(EMPTY_OPTS);
      expect(out).toContain('turing_gateway_requests_total{service="llm",status_class="2xx"} 1');
      expect(out).toContain('turing_gateway_requests_total{service="llm",status_class="5xx"} 1');
    });

    it('increment helpers never throw (infallible)', () => {
      expect(() => incGatewayRequest('llm', '2xx')).not.toThrow();
      expect(() => incGatewayError('llm')).not.toThrow();
    });
  });

  describe('gauges sampled at render time', () => {
    it('reflects workers-by-status from a mocked registry', () => {
      const opts = makeOpts(
        ['RUNNING', 'RUNNING', 'STOPPED', 'BLOCKED'],
        { running: false, queued: 0, paused: 0 }
      );
      const out = renderMetrics(opts);

      expect(out).toContain('# TYPE turing_workers gauge');
      expect(out).toContain('turing_workers{status="RUNNING"} 2');
      expect(out).toContain('turing_workers{status="STOPPED"} 1');
      expect(out).toContain('turing_workers{status="BLOCKED"} 1');
      // Statuses with no workers still emit a 0 series.
      expect(out).toContain('turing_workers{status="PENDING"} 0');
      expect(out).toContain('turing_workers{status="BOOTING"} 0');
      expect(out).toContain('turing_workers{status="TERMINATING"} 0');
    });

    it('reflects priority-queue depth from a mocked summary', () => {
      const opts = makeOpts([], { running: true, queued: 5, paused: 2 });
      const out = renderMetrics(opts);

      expect(out).toContain('# TYPE turing_queue_tasks gauge');
      expect(out).toContain('turing_queue_tasks{state="running"} 1');
      expect(out).toContain('turing_queue_tasks{state="queued"} 5');
      expect(out).toContain('turing_queue_tasks{state="paused"} 2');
    });

    it('emits running=0 when no task is running', () => {
      const opts = makeOpts([], { running: false, queued: 0, paused: 0 });
      const out = renderMetrics(opts);
      expect(out).toContain('turing_queue_tasks{state="running"} 0');
    });

    it('gauges are re-sampled on each render (not cached)', () => {
      let statuses = ['RUNNING'];
      const opts: RenderMetricsOptions = {
        registry: { listActive: () => statuses.map((status) => ({ status })) as any },
        priorityQueue: EMPTY_OPTS.priorityQueue,
      };

      expect(renderMetrics(opts)).toContain('turing_workers{status="RUNNING"} 1');
      statuses = ['RUNNING', 'RUNNING'];
      expect(renderMetrics(opts)).toContain('turing_workers{status="RUNNING"} 2');
    });

    it('does not throw when registry/queue access fails (emits zeros)', () => {
      const opts: RenderMetricsOptions = {
        registry: {
          listActive: () => {
            throw new Error('registry down');
          },
        },
        priorityQueue: {
          getSummary: () => {
            throw new Error('queue down');
          },
        },
      };
      let out = '';
      expect(() => {
        out = renderMetrics(opts);
      }).not.toThrow();
      expect(out).toContain('turing_workers{status="RUNNING"} 0');
      expect(out).toContain('turing_queue_tasks{state="queued"} 0');
    });
  });

  describe('label escaping', () => {
    it('escapes backslash, double-quote and newline in label values', () => {
      incGatewayRequest('we"ird\\svc\nname', '2xx');
      const out = renderMetrics(EMPTY_OPTS);
      // " -> \"   \ -> \\   newline -> \n  (literal backslash+n in the text)
      expect(out).toContain('service="we\\"ird\\\\svc\\nname"');
    });
  });

  describe('exposition format', () => {
    it('ends with a trailing newline', () => {
      expect(renderMetrics(EMPTY_OPTS).endsWith('\n')).toBe(true);
    });

    it('emits a HELP and TYPE line for every metric family even when empty', () => {
      const out = renderMetrics(EMPTY_OPTS);
      for (const name of [
        'turing_gateway_requests_total',
        'turing_gateway_errors_total',
        'turing_workers',
        'turing_queue_tasks',
      ]) {
        expect(out).toContain(`# HELP ${name}`);
        expect(out).toContain(`# TYPE ${name}`);
      }
    });
  });
});
