/**
 * NatsService — phase 1 of the Matrix->NATS migration.
 *
 * Best-effort dual-publish. When NATS_ENABLED=true the service connects to
 * JetStream, ensures the project streams exist, and exposes a publish()
 * helper. All failures are logged and swallowed — Matrix remains the
 * source of truth until phase 2.
 *
 * Subject layout (see docs/migrations/matrix-to-nats.md):
 *   turing.pm.inbox                        — tasks queued for PM
 *   turing.pm.broadcast                    — PM -> all workers
 *   turing.worker.<role>.<ticket>.inbox    — direct work for a worker
 *   turing.worker.<role>.<ticket>.heartbeat
 *   turing.worker.<role>.<ticket>.event
 *   turing.orchestrator.event              — spawn/kill/health
 *   turing.audit.<service>                 — mirror of audit-logger
 */

import {
  connect,
  JSONCodec,
  NatsConnection,
  JetStreamClient,
  RetentionPolicy,
} from 'nats';

const codec = JSONCodec();

const NS_PER_HOUR = 60n * 60n * 1_000_000_000n;
const NS_PER_DAY = 24n * NS_PER_HOUR;

interface StreamSpec {
  name: string;
  subjects: string[];
  retention: RetentionPolicy;
  max_age?: bigint;
}

const STREAMS: StreamSpec[] = [
  {
    name: 'TURING_TASKS',
    subjects: ['turing.pm.inbox', 'turing.worker.*.*.inbox'],
    retention: RetentionPolicy.Workqueue,
  },
  {
    name: 'TURING_EVENTS',
    subjects: [
      'turing.pm.broadcast',
      'turing.worker.*.*.event',
      'turing.worker.*.*.heartbeat',
      'turing.orchestrator.event',
    ],
    retention: RetentionPolicy.Limits,
    max_age: 72n * NS_PER_HOUR,
  },
  {
    name: 'TURING_AUDIT',
    subjects: ['turing.audit.>'],
    retention: RetentionPolicy.Limits,
    max_age: 30n * NS_PER_DAY,
  },
];

export interface NatsConfig {
  url: string;
  enabled: boolean;
}

export class NatsService {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private connecting: Promise<void> | null = null;
  private readonly config: NatsConfig;

  constructor(config: Partial<NatsConfig> = {}) {
    this.config = {
      url: config.url ?? process.env.NATS_URL ?? 'nats://nats:4222',
      enabled: config.enabled ?? process.env.NATS_ENABLED === 'true',
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isConnected(): boolean {
    return this.nc !== null && this.js !== null;
  }

  /** Connect lazily on first call. Safe to invoke many times. */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[NATS] Disabled — dual-publish skipped (set NATS_ENABLED=true to enable)');
      return;
    }
    if (this.nc) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        console.log(`[NATS] Connecting to ${this.config.url}`);
        this.nc = await connect({
          servers: this.config.url,
          reconnect: true,
          maxReconnectAttempts: -1,
          waitOnFirstConnect: false,
        });
        this.js = this.nc.jetstream();
        await this.ensureStreams();
        console.log('[NATS] Connected; JetStream streams ready');
      } catch (err) {
        console.warn(`[NATS] Initial connect failed: ${err}. Will retry on next publish.`);
        this.nc = null;
        this.js = null;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  private async ensureStreams(): Promise<void> {
    if (!this.nc) return;
    const jsm = await this.nc.jetstreamManager();
    for (const spec of STREAMS) {
      try {
        await jsm.streams.add({
          name: spec.name,
          subjects: spec.subjects,
          retention: spec.retention,
          max_age: spec.max_age,
        } as Parameters<typeof jsm.streams.add>[0]);
        console.log(`[NATS] Stream ready: ${spec.name}`);
      } catch (err: unknown) {
        const e = err as { api_error?: { err_code?: number }; code?: string };
        const alreadyExists = e?.api_error?.err_code === 10058;
        if (!alreadyExists) {
          console.warn(`[NATS] Stream ${spec.name} setup failed: ${err}`);
        }
      }
    }
  }

  /**
   * Best-effort JSON publish. Never throws — failures are logged.
   * Returns true when the message was acked by JetStream.
   */
  async publish(subject: string, data: unknown): Promise<boolean> {
    if (!this.config.enabled) return false;
    try {
      if (!this.nc) {
        await this.start();
      }
      if (!this.js) return false;
      await this.js.publish(subject, codec.encode(data));
      return true;
    } catch (err) {
      console.warn(`[NATS] publish to ${subject} failed: ${err}`);
      return false;
    }
  }

  /** Encode a worker-scoped subject. Sanitises role/ticket so NATS accepts them. */
  static workerSubject(role: string, ticketId: string, kind: 'inbox' | 'event' | 'heartbeat'): string {
    const safeRole = role.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'unknown';
    const safeTicket = ticketId.replace(/[^a-zA-Z0-9_-]/g, '-') || 'unknown';
    return `turing.worker.${safeRole}.${safeTicket}.${kind}`;
  }

  async stop(): Promise<void> {
    if (this.nc) {
      try {
        await this.nc.drain();
      } catch {
        // ignore — process is shutting down
      }
      this.nc = null;
      this.js = null;
    }
  }
}

export const natsService = new NatsService();
