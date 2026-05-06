import Docker from 'dockerode';
import { config, llmProviderRequiresApiKey } from '../config';
import { matrixService } from './matrix';
import { getCredentialVault } from './credential-vault';
import { getConsumerTokenManager } from './consumer-token';
import { getRBACService, Role } from './rbac';

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
  private gatewayEnabled: boolean;

  constructor() {
    const socketPath = config.docker.host;
    this.docker = new Docker(
      socketPath.startsWith('unix') || socketPath.startsWith('/')
        ? { socketPath: socketPath.replace('unix://', '') }
        : { socketPath }
    );
    // Check if gateway mode is enabled
    this.gatewayEnabled = process.env.GATEWAY_ENABLED !== 'false';
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
      `TAIGA_API_URL=${config.taiga.apiUrl}`,
      `TAIGA_PROJECT_SLUG=${config.taiga.projectSlug}`,
      `BOOKSTACK_URL=${config.bookstack.url}`,
      `ORCHESTRATOR_URL=${config.orchestrator.url}`,
      `SYNAPSE_API_URL=${config.matrix.apiUrl}`,
      `MATRIX_ROOM_ID=${roomId || ''}`,
      `WORKSPACE_PATH=/workspace`,
    ];

    // Gateway mode: inject consumer token instead of real API keys
    if (this.gatewayEnabled) {
      const tokenManager = getConsumerTokenManager();
      const rbac = getRBACService();
      const vault = getCredentialVault();

      // Get worker ID from container name
      const workerId = containerName;

      // Generate consumer token with role-based permissions
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

      // Ensure vault has credentials (import from environment if needed)
      await this._ensureVaultCredentials(vault);

      // Gateway URL for worker to use
      const gatewayUrl = process.env.GATEWAY_URL || `http://orchestrator:${config.port}`;

      envVars.push(
        `GATEWAY_URL=${gatewayUrl}`,
        `CONSUMER_TOKEN=${token}`,
        `GATEWAY_ENABLED=true`,
      );

      console.log(`[Docker] Gateway mode: spawned worker ${workerId} with consumer token (expires: ${expiresAt.toISOString()})`);

      // Store token info for later reference
      const container = await this.docker.createContainer({
        name: containerName,
        Image: imageName,
        Env: envVars,
        HostConfig: {
          AutoRemove: true,
          Memory: config.docker.workerRamMb * 1024 * 1024,
          NanoCpus: config.docker.workerCpuCount * 1_000_000_000,
          Binds: ['worker_workspace:/workspace'],
        },
        NetworkingConfig: {
          EndpointsConfig: {
            'turing-os_taiga_network': {},
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
          'com.docker.compose.project.working_dir': process.cwd(),
        },
        Healthcheck: {
          Test: ['CMD-SHELL', 'ps aux | grep "[p]ython main.py" || exit 1'],
          Interval: 30000000000, // 30s
          Timeout: 10000000000,  // 10s
          Retries: 3,
        },
      });

      await container.start();
      console.log(`[Docker] Spawned gateway-mode worker container ${containerName} for ticket ${ticketId} (role: ${role})`);

      return container.id;
    }

    // Legacy mode: pass real API keys directly (for migration/development)
    console.log(`[Docker] Legacy mode: spawning worker with direct API keys (GATEWAY_ENABLED=false)`);

    const apiKey = config.llm.apiKey;
    const provider = config.llm.provider;

    // Retrieve Context7 API key from Wiki (with caching)
    const context7ApiKey = await this._getSecretCached('context7-api-key');

    if (llmProviderRequiresApiKey(provider) && !apiKey) {
      throw new Error('LLM_API_KEY not configured in environment');
    }

    envVars.push(
      `LLM_API_KEY=${apiKey}`,
      `LLM_PROVIDER=${provider}`,
      `LLM_MODEL=${config.llm.model}`,
      `LLM_BASE_URL=${config.llm.baseUrl}`,
      `TAIGA_API_KEY=${config.taiga.apiKey}`,
      `BOOKSTACK_TOKEN=${config.bookstack.apiToken}`,
      `CONTEXT7_API_KEY=${context7ApiKey || config.context7.apiKey || ''}`,
      `MATRIX_BOT_TOKEN=${config.matrix.botToken}`,
      `GATEWAY_ENABLED=false`,
    );

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageName,
      Env: envVars,
      HostConfig: {
        AutoRemove: true,
        Memory: config.docker.workerRamMb * 1024 * 1024,
        NanoCpus: config.docker.workerCpuCount * 1_000_000_000,
        Binds: ['worker_workspace:/workspace'],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          'turing-os_taiga_network': {},
          [config.docker.networkName]: {},
        }
      },
      Labels: {
        'turing-worker': 'true',
        'ticket-id': ticketId,
        'worker-role': role,
        'gateway-mode': 'false',
        'com.docker.compose.project': 'turing-os',
        'com.docker.compose.service': 'worker',
        'com.docker.compose.project.working_dir': process.cwd(),
      },
      Healthcheck: {
        Test: ['CMD-SHELL', 'ps aux | grep "[p]ython main.py" || exit 1'],
        Interval: 30000000000, // 30s
        Timeout: 10000000000,  // 10s
        Retries: 3,
      },
    });

    await container.start();
    console.log(`[Docker] Spawned legacy-mode worker container ${containerName} for ticket ${ticketId} (role: ${role})`);

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

  async restartWorker(ticketId: string, role: string = 'default', roomId: string = ''): Promise<void> {
    await this.stopWorker(ticketId);
    await this.startWorker(ticketId);
  }

  /**
   * Gracefully STOP a worker container (SIGTERM) without removing it.
   * The container stays in Docker's "stopped" state and can be started again later.
   * This preserves all container state, volumes, and learned data.
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
   * START a previously stopped worker container.
   * Only works for containers that were stopped (not removed).
   * Container must still exist in Docker.
   */
  async startWorker(ticketId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      filters: { label: [`ticket-id=${ticketId}`] },
      all: true,  // Include stopped containers
    });

    for (const c of containers) {
      if (c.State !== 'running') {
        console.log(`[Docker] Starting stopped container ${c.Id.substring(0, 12)} for ticket ${ticketId}`);
        try {
          await this.docker.getContainer(c.Id).start();
        } catch (error: any) {
          if (!error.message?.includes('already')) {
            throw error;
          }
        }
      }
    }
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
