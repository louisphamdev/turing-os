import Docker from 'dockerode';
import { config } from '../config';
import { getCredentialVault } from './credential-vault';
import { getConsumerTokenManager } from './consumer-token';
import { getRBACService, Role } from './rbac';
// Type-only import — erased at compile time, so it does not create a runtime
// circular dependency with registry.ts (which imports ActiveWorker from here).
import type { WorkerRegistry } from './registry';

export interface ActiveWorker {
  containerId: string;
  ticketId: string;
  role: string;
  roomId: string;
  startTime: number;
  status: 'BOOTING' | 'RUNNING' | 'BLOCKED' | 'TERMINATING' | 'PENDING' | 'STOPPED';
  lastHeartbeat: number;
  lastProgress: number;
  lastBlockedReason?: string;
  consumerToken?: string;
  tokenId?: string;
  // Checkpoint tracking
  lastCheckpointTime?: number;
  lastCheckpointIteration?: number;
  checkpointCount?: number;
}

export class DockerService {
  private docker: Docker;
  private secretsCache: Map<string, { value: string; fetchedAt: number }> = new Map();
  private static readonly SECRETS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  // Optional back-reference to the registry so startWorker() can recreate an
  // ephemeral worker from its stored role/roomId. Injected from index.ts.
  private registry?: WorkerRegistry;

  constructor(registry?: WorkerRegistry) {
    this.registry = registry;
    const socketPath = config.docker.host;
    this.docker = new Docker(
      socketPath.startsWith('unix') || socketPath.startsWith('/')
        ? { socketPath: socketPath.replace('unix://', '') }
        : { socketPath }
    );
    // Gateway is now mandatory. Legacy direct-key mode has been removed —
    // workers must run with a consumer token and route external calls
    // through the orchestrator gateway proxy. See `.claude/rules/architecture.md`.
  }

  async spawnWorker(ticketId: string, role: string, roomId: string = ''): Promise<string> {
    console.log(`[Docker] spawnWorker called: ticketId=${ticketId}, role=${role}, roomId=${roomId}`);
    const imageName = config.docker.workerImage;

    // Check max workers limit
    const runningContainers = await this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
    });
    if (runningContainers.length >= config.docker.maxWorkers) {
      throw new Error(
        `Max workers limit reached (${config.docker.maxWorkers}). ` +
        `Currently running: ${runningContainers.length}`
      );
    }

    // Use ticketId in container name to avoid collisions when multiple workers share the same role
    const safeTicketId = ticketId.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const containerName = `turing-worker-${role}-${safeTicketId}`;

    // Build environment variables
    const envVars: string[] = [
      `TICKET_ID=${ticketId}`,
      `ROLE=${role}`,
      `BOOKSTACK_URL=${config.bookstack.url}`,
      `ORCHESTRATOR_URL=${config.orchestrator.url}`,
      `SYNAPSE_API_URL=${config.matrix.apiUrl}`,
      `MATRIX_ROOM_ID=${roomId || ''}`,
      `WORKSPACE_PATH=/workspace`,
      // Plane is the only StateBackend now.
      `STATE_BACKEND=${process.env.STATE_BACKEND || 'plane'}`,
      `PLANE_API_URL=${config.plane.apiUrl}`,
      `PLANE_WORKSPACE_SLUG=${config.plane.workspace}`,
      `PLANE_PROJECT_ID=${config.plane.projectId}`,
      `NATS_URL=${process.env.NATS_URL || 'nats://nats:4222'}`,
      `WORKER_NATS_SUBSCRIBE=${process.env.WORKER_NATS_SUBSCRIBE || 'true'}`,
    ];

    // Shared secret for worker → orchestrator webhooks. Forwarded only when
    // set on the orchestrator side; workers then send it on every request.
    if (process.env.WORKER_INTERNAL_TOKEN) {
      envVars.push(`WORKER_INTERNAL_TOKEN=${process.env.WORKER_INTERNAL_TOKEN}`);
    }

    // Gateway-only mode (mandatory). Inject a per-worker consumer token;
    // no raw API keys cross the container boundary.
    const tokenManager = getConsumerTokenManager();
    const rbac = getRBACService();
    const vault = getCredentialVault();

    const workerId = containerName;

    const permissions = rbac.getPermissionsForRole(role as Role);
    const rateLimit = rbac.getRateLimitForRole(role as Role);
    const expiresIn = rbac.getTokenExpiryForRole(role as Role);

    const { token, expiresAt, tokenId } = tokenManager.generateToken({
      workerId,
      role: role as Role,
      permissions,
      rateLimit,
      expiresIn,
      metadata: {
        ticketId,
        description: `Worker for ticket ${ticketId}`,
      },
    });

    await this._ensureVaultCredentials(vault);

    const gatewayUrl = process.env.GATEWAY_URL || `http://orchestrator:${config.port}`;

    envVars.push(
      `GATEWAY_URL=${gatewayUrl}`,
      `CONSUMER_TOKEN=${token}`,
      `GATEWAY_ENABLED=true`,
    );

    console.log(`[Docker] Spawning worker ${workerId} with consumer token (expires: ${expiresAt.toISOString()})`);

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageName,
      Env: envVars,
      HostConfig: {
        AutoRemove: true,
        Memory: config.docker.workerRamMb * 1024 * 1024,
        NanoCpus: config.docker.workerCpuCount * 1_000_000_000,
        Binds: ['worker_workspace:/workspace'],
        // Least-privilege hardening (Task P2-1). The base-worker image already
        // runs as non-root `USER worker`; these flags add capability + privilege
        // containment on top. A Python HTTP/file-IO agent needs no Linux caps,
        // and no-new-privileges blocks escalation via setuid binaries.
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        // TODO(P2): ReadonlyRootfs + tmpfs /tmp after live-stack verification
        // (worker writes /tmp checkpoints, pip caches, etc., so this needs a
        // tmpfs mount + live testing before it can be enabled safely).
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [config.docker.networkName]: {},
        }
      },
      Labels: {
        'turing-worker': 'true',
        'ticket-id': ticketId,
        'worker-role': role,
        'gateway-mode': 'true',
        'consumer-token-id': tokenId,
        'com.docker.compose.project': 'turing-os',
        'com.docker.compose.service': 'worker',
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'ps aux | grep "[s]rc/index.py" || exit 1'],
        Interval: 30000000000, // 30s
        Timeout: 10000000000,  // 10s
        Retries: 3,
      },
    });

    await container.start();
    console.log(`[Docker] Spawned worker container ${containerName} for ticket ${ticketId} (role: ${role})`);

    return container.id;
  }

  private async _getSecretCached(secretKey: string): Promise<string | null> {
    const cached = this.secretsCache.get(secretKey);
    if (cached && Date.now() - cached.fetchedAt < DockerService.SECRETS_CACHE_TTL) {
      return cached.value;
    }

    const value = await this._getSecretFromWiki(secretKey);
    if (value) {
      this.secretsCache.set(secretKey, { value, fetchedAt: Date.now() });
    }
    return value;
  }

  private async _getSecretFromWiki(secretKey: string): Promise<string | null> {
    const bookstackUrl = config.bookstack.url;
    const bookstackToken = config.bookstack.apiToken;

    if (!bookstackToken) {
      console.warn(`[Docker] BookStack token not configured - ${secretKey} will not be available`);
      return null;
    }

    try {
      // BookStack API - first get list of pages
      const listResponse = await fetch(`${bookstackUrl}/api/pages`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bookstackToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!listResponse.ok) {
        console.warn(`[Docker] Failed to list BookStack pages: HTTP ${listResponse.status}`);
        return null;
      }

      const listData: any = await listResponse.json();
      const pages = listData?.data || [];

      // Search for secrets page by title
      const secretsPage = pages.find((p: any) =>
        p.name?.toLowerCase().includes('secrets') ||
        p.slug?.toLowerCase().includes('secrets')
      );

      if (!secretsPage) {
        console.warn(`[Docker] No secrets page found in BookStack`);
        return null;
      }

      // Now fetch the secrets page content
      const contentResponse = await fetch(`${bookstackUrl}/api/pages/${secretsPage.id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${bookstackToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!contentResponse.ok) {
        console.warn(`[Docker] Failed to fetch BookStack page content: HTTP ${contentResponse.status}`);
        return null;
      }

      const contentData: any = await contentResponse.json();
      const pageContent = contentData?.html || contentData?.markdown || '';

      // Parse secrets from content (expecting KEY=VALUE format, one per line)
      const secretPattern = new RegExp(`^${secretKey}=(.+)$`, 'im');
      const match = pageContent.match(secretPattern);

      if (match?.[1]) {
        console.log(`[Docker] Retrieved ${secretKey} from BookStack`);
        return match[1].trim();
      }

      console.warn(`[Docker] Secret ${secretKey} not found in BookStack secrets page`);
      return null;
    } catch (error) {
      console.warn(`[Docker] Error retrieving secret from BookStack: ${error}`);
      return null;
    }
  }

  /**
   * Ensure vault has credentials imported from environment
   * This is called when gateway mode starts to populate the vault
   */
  private async _ensureVaultCredentials(vault: any): Promise<void> {
    // Check if vault already has credentials
    const existing = vault.listCredentials();
    
    if (existing.length > 0) {
      console.log(`[Docker] Vault already has ${existing.length} credentials`);
      return;
    }

    // Import from environment variables
    console.log(`[Docker] Importing credentials from environment to vault...`);
    
    const imported = await vault.importFromEnvironment();
    console.log(`[Docker] Imported ${imported} credentials to vault`);
  }

  async restartWorker(ticketId: string, _role: string = 'default', _roomId: string = ''): Promise<boolean> {
    // stopWorker tears the (auto-removed) container down; startWorker then
    // recreates a fresh ephemeral worker from the registry's role/roomId.
    // The role/roomId args are kept for backwards-compat with callers but are
    // sourced authoritatively from the registry inside startWorker().
    await this.stopWorker(ticketId);
    const started = await this.startWorker(ticketId);
    return started;
  }

  /**
   * Gracefully STOP a worker container (SIGTERM).
   *
   * NOTE: workers run with HostConfig.AutoRemove=true, so Docker DELETES the
   * container as soon as it stops — nothing is "preserved" at the container
   * level. Workers are ephemeral by design: agent state lives in checkpoints
   * and the workspace lives in the persistent `worker_workspace` named volume.
   * A subsequent startWorker() therefore RECREATES a fresh worker (which
   * restores its state from the checkpoint + volume) rather than resuming the
   * same container.
   */
  async stopWorker(ticketId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      filters: { label: [`ticket-id=${ticketId}`] },
    });

    for (const c of containers) {
      console.log(`[Docker] Stopping container ${c.Id.substring(0, 12)} for ticket ${ticketId}`);
      try {
        await this.docker.getContainer(c.Id).stop({ t: 30 });
      } catch (error: any) {
        if (!error.message?.includes('is not running') && !error.message?.includes('already')) {
          throw error;
        }
        console.log(`[Docker] Container ${c.Id.substring(0, 12)} already stopped for ticket ${ticketId}`);
      }
    }
  }

  /**
   * START a worker for the given ticket.
   *
   * Because workers are ephemeral (HostConfig.AutoRemove=true), a stopped
   * worker's container is normally already gone. This method therefore:
   *   - If a container for the ticket STILL EXISTS (e.g. stopped but not yet
   *     reaped by Docker) → `.start()` it.
   *   - If NO container exists → RECREATE a fresh worker via spawnWorker(),
   *     reading role/roomId from the registry. spawnWorker generates a new
   *     consumer token and (re)maps the Matrix room as needed, so we reuse it
   *     rather than duplicating spawn logic. The fresh worker restores its
   *     state from the checkpoint + the persistent `worker_workspace` volume.
   *
   * @returns true if a container is now running/created, false otherwise
   *          (e.g. the registry has no entry so role/roomId are unknown).
   */
  async startWorker(ticketId: string): Promise<boolean> {
    const containers = await this.docker.listContainers({
      filters: { label: [`ticket-id=${ticketId}`] },
      all: true,  // Include stopped-but-not-yet-removed containers
    });

    if (containers.length > 0) {
      let startedAny = false;
      for (const c of containers) {
        if (c.State === 'running') {
          startedAny = true;
          continue;
        }
        console.log(`[Docker] Starting existing stopped container ${c.Id.substring(0, 12)} for ticket ${ticketId}`);
        try {
          await this.docker.getContainer(c.Id).start();
          startedAny = true;
        } catch (error: any) {
          if (error.message?.includes('already')) {
            startedAny = true;
          } else {
            throw error;
          }
        }
      }
      return startedAny;
    }

    // No container exists — the ephemeral worker was auto-removed on stop.
    // Recreate a fresh one from the registry's role/roomId.
    const worker = this.registry?.lookupByTicket(ticketId);
    if (!worker || !worker.role) {
      console.warn(`[Docker] Cannot recreate worker for ticket ${ticketId}: no registry entry / role`);
      return false;
    }

    console.log(`[Docker] No container for ticket ${ticketId}; recreating fresh worker (role: ${worker.role})`);
    await this.spawnWorker(ticketId, worker.role, worker.roomId || '');
    return true;
  }

  /**
   * DELETE a worker container completely (force kill + remove).
   * This is irreversible — all container state is lost.
   * Use this when admin explicitly wants to remove a worker permanently.
   */
  async deleteWorker(ticketId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      filters: { label: [`ticket-id=${ticketId}`] },
      all: true,  // Include stopped containers so we can remove them too
    });

    for (const c of containers) {
      console.log(`[Docker] Deleting container ${c.Id.substring(0, 12)} for ticket ${ticketId} (state: ${c.State})`);
      try {
        // First try graceful stop (in case it's still running)
        if (c.State === 'running') {
          await this.docker.getContainer(c.Id).stop({ t: 10 });
        }
      } catch (error: any) {
        // Ignore "not running" errors
        if (!error.message?.includes('is not running') && !error.message?.includes('already')) {
          console.warn(`[Docker] stop before delete failed for ${c.Id.substring(0, 12)}: ${error.message}`);
        }
      }
      try {
        // Then remove the container
        await this.docker.getContainer(c.Id).remove({ v: true, force: true });
      } catch (error: any) {
        if (error.message?.includes('no such container')) {
          // Already gone, that's fine
          console.log(`[Docker] Container ${c.Id.substring(0, 12)} already removed`);
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Legacy alias for deleteWorker. Kills AND removes the container.
   * @deprecated Use stopWorker() to pause, or deleteWorker() to permanently remove.
   */
  async killWorker(ticketId: string): Promise<void> {
    return this.deleteWorker(ticketId);
  }

  async killZombies(): Promise<void> {
    const timeout = config.docker.timeoutMinutes * 60 * 1000;
    const containers = await this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
      all: true,  // Include stopped containers so we can delete them
    });

    let killed = 0;
    for (const c of containers) {
      const age = Date.now() - new Date(c.Created * 1000).getTime();
      if (age > timeout) {
        const ticketId = c.Labels?.['ticket-id'] || 'unknown';
        console.warn(`[Docker] Deleting zombie container ${c.Id.substring(0, 12)} (ticket: ${ticketId}, age: ${Math.round(age / 60000)}min, state: ${c.State})`);
        try {
          // Delete: stop (if running) then remove
          await this.deleteWorker(ticketId);
          killed++;
        } catch (error: any) {
          console.error(`[Docker] Failed to delete zombie ${c.Id.substring(0, 12)}: ${error.message}`);
        }
      }
    }
    if (killed > 0) {
      console.log(`[Docker] Deleted ${killed} zombie container(s)`);
    }
  }

  /**
   * List ALL worker containers (including stopped ones).
   * Use this to see workers that were stopped but not deleted.
   */
  async listAllWorkerContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
      all: true,
    });
  }

  async listWorkerContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
    });
  }

  /**
   * List ALL containers (worker + infrastructure) — used by Doctor
   * to discover all containers for log inspection and diagnostics.
   */
  async listAllContainers(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all: true });
  }

  /**
   * Get container logs (stdout + stderr) for a given container.
   * Used by HealthMonitor when Doctor diagnoses a failed worker.
   */
  async getContainerLogs(containerName: string, tail: number = 100): Promise<string> {
    try {
      const container = this.docker.getContainer(containerName);
      const logsBuffer = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      // container.logs() returns a Buffer in non-stream mode
      return logsBuffer.toString('utf-8');
    } catch (error) {
      console.warn(`[Docker] getContainerLogs failed for ${containerName}: ${error}`);
      return '';
    }
  }

  /**
   * Get real-time CPU/RAM stats for all worker containers.
   * Returns a map of containerId → stats (CPU % and RAM usage in bytes).
   */
  async getContainerStats(): Promise<Map<string, { cpuPercent: number; memoryUsage: number; memoryLimit: number }>> {
    const containers = await this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
    });

    const statsMap = new Map<string, { cpuPercent: number; memoryUsage: number; memoryLimit: number }>();

    await Promise.allSettled(
      containers.map(async (c) => {
        try {
          const stats = await this.docker.getContainer(c.Id).stats({ stream: false }) as any;
          // CPU percent: (cpuDelta / systemDelta) * 100
          const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0)
            - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
          const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0)
            - (stats.precpu_stats?.system_cpu_usage ?? 0);
          const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * 100 * (stats.cpu_stats?.online_cpus ?? 1) : 0;

          const memoryUsage = stats.memory_stats?.usage ?? 0;
          const memoryLimit = stats.memory_stats?.limit ?? 1;

          statsMap.set(c.Id, { cpuPercent, memoryUsage, memoryLimit });
        } catch {
          // Container may have exited; skip stats
        }
      })
    );

    return statsMap;
  }

  /**
   * Get average resource usage across all worker containers.
   */
  async getAverageResourceUsage(): Promise<{ avgCpuPercent: number; avgMemoryPercent: number }> {
    const stats = await this.getContainerStats();
    if (stats.size === 0) {
      return { avgCpuPercent: 0, avgMemoryPercent: 0 };
    }

    let totalCpu = 0;
    let totalMemory = 0;

    for (const s of stats.values()) {
      totalCpu += s.cpuPercent;
      totalMemory += (s.memoryUsage / s.memoryLimit) * 100;
    }

    return {
      avgCpuPercent: totalCpu / stats.size,
      avgMemoryPercent: totalMemory / stats.size,
    };
  }

  /**
   * Count currently running worker containers.
   */
  async getRunningWorkerCount(): Promise<number> {
    const containers = await this.docker.listContainers({
      filters: { label: ['turing-worker=true'] },
    });
    return containers.length;
  }

  // ─── Docker Event Monitor (OOM, die, restart detection) ────────────────

  private eventStream: any = null;
  private onDockerEventCallback?: (
    containerId: string,
    ticketId: string,
    event: string,
    details: string
  ) => void;

  /**
   * Start listening for Docker container events (die, oom, restart).
   * Call this once after DockerService is constructed.
   * @param callback Called for each relevant turing-worker event
   */
  startEventMonitor(
    callback: (containerId: string, ticketId: string, event: string, details: string) => void
  ): void {
    this.onDockerEventCallback = callback;

    const startStream = () => {
      try {
        this.docker.getEvents(
          {
            filters: {
              type: ['container'],
              event: ['die', 'oom', 'restart', 'start', 'destroy'],
            },
          },
          (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
            if (err) {
              console.error('[Docker] Event stream error:', err.message);
              setTimeout(startStream, 10_000);
              return;
            }
            if (!stream) {
              console.error('[Docker] Event stream is null — retrying in 10s');
              setTimeout(startStream, 10_000);
              return;
            }
            this.eventStream = stream;

            stream.on('data', (chunk: Buffer) => {
              try {
                const lines = chunk.toString().trim().split('\n');
                for (const line of lines) {
                  if (!line.trim()) continue;
                  const evt: any = JSON.parse(line);
                  this._handleDockerEvent(evt);
                }
              } catch {
                // Malformed event — ignore
              }
            });

            stream.on('error', (err: Error) => {
              console.error('[Docker] Event stream error:', err.message);
              setTimeout(startStream, 10_000);
            });

            stream.on('close', () => {
              console.warn('[Docker] Event stream closed — reconnecting in 10s');
              setTimeout(startStream, 10_000);
            });
          }
        );
        console.log('[Docker] Event monitor started (listening for die/oom/restart)');
      } catch (err) {
        console.error('[Docker] Failed to start event monitor:', err);
        setTimeout(startStream, 10_000);
      }
    };

    startStream();
  }

  stopEventMonitor(): void {
    if (this.eventStream) {
      try {
        this.eventStream.destroy();
      } catch {
        // ignore
      }
      this.eventStream = null;
    }
  }

  private async _handleDockerEvent(event: {
    Type?: string;
    Action?: string;
    Actor?: { ID?: string; Attributes?: Record<string, string> };
    time?: number;
  }): Promise<void> {
    if (event.Type !== 'container') return;

    const action = event.Action || '';
    const containerId = event.Actor?.ID || '';

    // Only care about turing-worker containers
    const ticketId = event.Actor?.Attributes?.['ticket-id'] || '';
    if (!ticketId) return;

    // Map Docker event to a readable label
    const eventLabel =
      action === 'oom' ? 'OOM (Out of Memory)'
      : action === 'die' ? 'container died'
      : action === 'restart' ? 'container restarted'
      : action === 'start' ? 'container started'
      : action;

    const ts = event.time ? new Date(event.time * 1000).toISOString() : new Date().toISOString();
    const details = `Event: ${eventLabel} at ${ts}. Container: ${containerId.substring(0, 12)}`;

    console.warn(`[Docker] Worker event: ${ticketId} → ${eventLabel}`);

    if (this.onDockerEventCallback) {
      this.onDockerEventCallback(containerId, ticketId, action, details);
    }
  }
}
