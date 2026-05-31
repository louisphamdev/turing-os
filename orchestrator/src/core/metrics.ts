/**
 * Metrics — a tiny hand-rolled Prometheus exposition module.
 *
 * Deliberately NOT using `prom-client`: we want zero new npm deps right
 * before a commit (no package-lock churn, no extra vuln-scan surface). The
 * registry only needs to support what /metrics actually exposes:
 *
 *   - Counters: monotonic, accumulated in-process (gateway requests/errors).
 *   - Gauges:   sampled at scrape time from live state (workers by status,
 *               priority-queue depth) — these are NOT stored here, they are
 *               read straight from the singletons in renderMetrics().
 *
 * Label cardinality is kept intentionally low so the time-series count stays
 * bounded: service ∈ llm|plane|bookstack|matrix, statusClass ∈ 2xx|4xx|5xx.
 */

import type { WorkerRegistry } from './registry';
import type { ActiveWorker } from './docker';
import type { PriorityQueue } from './priority-queue';

export type GatewayService = 'llm' | 'plane' | 'bookstack' | 'matrix';
export type StatusClass = '2xx' | '4xx' | '5xx';

/** Worker statuses we surface as gauge series (mirrors ActiveWorker['status']). */
const WORKER_STATUSES: ActiveWorker['status'][] = [
  'BOOTING',
  'RUNNING',
  'BLOCKED',
  'TERMINATING',
  'PENDING',
  'STOPPED',
];

/**
 * In-process counter store, keyed by a stable serialization of the metric's
 * label set. Counters are monotonic — they only ever increase (or reset to 0
 * on process restart, which Prometheus handles via the counter reset rules).
 */
class CounterVec {
  private readonly values = new Map<string, number>();

  /** Increment the series identified by `labels` by `amount` (default 1). */
  inc(labels: Record<string, string>, amount = 1): void {
    const key = serializeLabels(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  /** Snapshot of every accumulated series as [parsedLabels, value] pairs. */
  entries(): Array<{ labels: Record<string, string>; value: number }> {
    const out: Array<{ labels: Record<string, string>; value: number }> = [];
    for (const [key, value] of this.values) {
      out.push({ labels: deserializeLabels(key), value });
    }
    return out;
  }

  /** Test/maintenance helper — wipe all accumulated counters. */
  reset(): void {
    this.values.clear();
  }
}

// ─── In-process counters ───────────────────────────────────────────────────

const gatewayRequests = new CounterVec();
const gatewayErrors = new CounterVec();

/**
 * Record a completed gateway request. Infallible: metrics must NEVER break a
 * request, so all bookkeeping is wrapped and any error is swallowed.
 */
export function incGatewayRequest(service: string, statusClass: string): void {
  try {
    gatewayRequests.inc({ service, status_class: statusClass });
  } catch {
    // metrics are best-effort — never propagate
  }
}

/** Record a gateway error (proxy threw / upstream failed). Infallible. */
export function incGatewayError(service: string): void {
  try {
    gatewayErrors.inc({ service });
  } catch {
    // metrics are best-effort — never propagate
  }
}

/**
 * Map an HTTP status code to its low-cardinality class. Anything outside the
 * 2xx/4xx/5xx ranges (1xx/3xx) is bucketed into the nearest meaningful class
 * so we never explode label cardinality.
 */
export function statusClassOf(statusCode: number): StatusClass {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  return '2xx';
}

/** Reset all in-process counters. Test-only helper. */
export function _resetMetrics(): void {
  gatewayRequests.reset();
  gatewayErrors.reset();
}

// ─── Prometheus text rendering ───────────────────────────────────────────────

/**
 * Escape a label VALUE per the Prometheus text exposition format: backslash,
 * double-quote and newline must be escaped. (Label names/metric names are
 * controlled constants here, so they need no escaping.)
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render a label set into the `{a="b",c="d"}` suffix (empty string if none). */
function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const inner = keys
    .map((k) => `${k}="${escapeLabelValue(labels[k])}"`)
    .join(',');
  return `{${inner}}`;
}

/**
 * Serialize a label set to a stable map key. Keys are sorted so {a,b} and
 * {b,a} collapse to the same series. Uses control-char separators that can't
 * appear in our (low-cardinality, ascii) label values.
 */
function serializeLabels(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}\x1f${labels[k]}`)
    .join('\x1e');
}

function deserializeLabels(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === '') return out;
  for (const pair of key.split('\x1e')) {
    const idx = pair.indexOf('\x1f');
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

export interface RenderMetricsOptions {
  /** Live worker registry — workers-by-status gauge is sampled from this. */
  registry: Pick<WorkerRegistry, 'listActive'>;
  /** Live priority queue — queue-depth gauge is sampled from getSummary(). */
  priorityQueue: Pick<PriorityQueue, 'getSummary'>;
}

/**
 * Render the full Prometheus text exposition (format version 0.0.4).
 *
 * Counters are read from the in-process accumulators; gauges are sampled at
 * call time from the live registry/queue so they always reflect current state.
 */
export function renderMetrics(opts: RenderMetricsOptions): string {
  const lines: string[] = [];

  // ── Counter: gateway requests ──────────────────────────────────────────
  lines.push('# HELP turing_gateway_requests_total Total gateway proxy requests by service and HTTP status class.');
  lines.push('# TYPE turing_gateway_requests_total counter');
  for (const { labels, value } of gatewayRequests.entries()) {
    lines.push(`turing_gateway_requests_total${renderLabels(labels)} ${value}`);
  }

  // ── Counter: gateway errors ────────────────────────────────────────────
  lines.push('# HELP turing_gateway_errors_total Total gateway proxy errors by service.');
  lines.push('# TYPE turing_gateway_errors_total counter');
  for (const { labels, value } of gatewayErrors.entries()) {
    lines.push(`turing_gateway_errors_total${renderLabels(labels)} ${value}`);
  }

  // ── Gauge: workers by status (sampled now) ─────────────────────────────
  lines.push('# HELP turing_workers Number of registered workers by lifecycle status.');
  lines.push('# TYPE turing_workers gauge');
  const byStatus: Record<string, number> = {};
  for (const s of WORKER_STATUSES) byStatus[s] = 0;
  try {
    for (const worker of opts.registry.listActive()) {
      byStatus[worker.status] = (byStatus[worker.status] ?? 0) + 1;
    }
  } catch {
    // registry unavailable — emit zeros rather than failing the scrape
  }
  for (const s of WORKER_STATUSES) {
    lines.push(`turing_workers${renderLabels({ status: s })} ${byStatus[s]}`);
  }

  // ── Gauge: priority-queue depth (sampled now) ──────────────────────────
  lines.push('# HELP turing_queue_tasks Priority-queue task counts by state.');
  lines.push('# TYPE turing_queue_tasks gauge');
  let running = 0;
  let queued = 0;
  let paused = 0;
  try {
    const summary = opts.priorityQueue.getSummary();
    running = summary.running ? 1 : 0;
    queued = summary.queued;
    paused = summary.paused;
  } catch {
    // queue unavailable — emit zeros rather than failing the scrape
  }
  lines.push(`turing_queue_tasks${renderLabels({ state: 'running' })} ${running}`);
  lines.push(`turing_queue_tasks${renderLabels({ state: 'queued' })} ${queued}`);
  lines.push(`turing_queue_tasks${renderLabels({ state: 'paused' })} ${paused}`);

  // Prometheus text format requires a trailing newline.
  return lines.join('\n') + '\n';
}
