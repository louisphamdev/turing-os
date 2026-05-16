import * as crypto from 'crypto';
import express from 'express';
import { webhooksRouter } from './api/webhooks';
import { DockerService } from './core/docker';
import { WorkerRegistry } from './core/registry';
import { HealthMonitor } from './core/health-monitor';
import { alertManager } from './core/alert-manager';
import { config, logConfigSummary } from './config';
import { initAgentRoles, getAllAgentRoles } from './agents/init';
import { matrixService } from './core/matrix';
import { priorityQueue } from './core/priority-queue';
import { parseIntent, isWorkerDirectedMessage, WorkerCommand } from './core/intent-parser';
import { OrchestratorAgent } from './core/orchestrator-agent';
import { getProxyHandler } from './core/gateway/proxy-handler';
import { getCredentialVault } from './core/credential-vault';
import { getConsumerTokenManager } from './core/consumer-token';
import { getRBACService } from './core/rbac';
import { PMStateManager } from './core/pm-state';

// ─── Bootstrap ───────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║        TURING OS — Orchestrator v1.0         ║');
console.log('╚══════════════════════════════════════════════╝');
console.log('');

logConfigSummary();
initAgentRoles();

const registry = new WorkerRegistry();
const docker = new DockerService();
const healthMonitor = new HealthMonitor(registry, docker);

const pmStateManager = new PMStateManager(priorityQueue, registry);
pmStateManager.startAutoPersist();
healthMonitor.setPMStateManager(pmStateManager);

const savedPM = pmStateManager.getSavedPMInfo();
if (savedPM && pmStateManager.isStateStale()) {
  console.warn(`[PMFailover] Detected stale PM state (ticket: ${savedPM.ticketId}). Queue will be restored on next PM spawn.`);
}

// ─── Matrix Message Handler — all messages go to LLM (OrchestratorAgent) ─────

/**
 * ALL admin messages are handled by the LLM-powered OrchestratorAgent.
 * Slash commands like /status, /scale are parsed naturally by the LLM.
 * Worker room messages are forwarded to the LLM for routing.
 */
async function handleMatrixMessage(
  roomId: string,
  sender: string,
  content: string
): Promise<void> {
  // All messages go to the LLM-powered OrchestratorAgent
  // (MatrixService already filters own messages in _handleRoomEvent)
  await handleBotMessage(roomId, sender, content);
}

matrixService.setMessageHandler(handleMatrixMessage);

const orchestratorAgent = new OrchestratorAgent(docker, healthMonitor, registry);

async function handleBotMessage(roomId: string, sender: string, content: string): Promise<void> {
  console.log(`[OrchestratorAgent] ${sender}: ${content.substring(0, 80)}`);
  try {
    const reply = await orchestratorAgent.think(content, sender, roomId);
    await matrixService.sendToRoom(roomId, reply);
  } catch (err) {
    console.error('[OrchestratorAgent] Error:', err);
    await matrixService.sendToRoom(roomId, `⚠️ Agent error: ${err}`);
  }
}

const autoStartRoles = config.orchestrator.autoStartRoles;
if (autoStartRoles.length > 0) {
  console.log(`[Orchestrator] Auto-start enabled for roles: ${autoStartRoles.join(', ')}`);
}

healthMonitor.start();

docker.startEventMonitor((containerId, ticketId, action, details) => {
  if (action === 'oom') {
    alertManager.alertDockerEvent(ticketId, 'OOM', details).catch(() => {});
  } else if (action === 'die') {
    console.warn(`[DockerEvent] Worker ${ticketId} died (container: ${containerId.substring(0, 12)}). HealthMonitor will handle respawn.`);
  }
});

healthMonitor.onScaleNeeded = async (direction) => {
  if (direction === 'up') {
    const workers = registry.listActive();
    const busyTicketIds = new Set(workers.map((w) => w.ticketId));
    const availableRole = autoStartRoles.find((role) => {
      const tid = `init-${role}`;
      return !busyTicketIds.has(tid);
    });
    if (!availableRole) {
      console.warn('[Scale] No available role to scale up');
      return;
    }
    const ticketId = `init-${availableRole}`;
    try {
      const roomId = await matrixService.createWorkerRoom(availableRole, ticketId);
      const containerId = await docker.spawnWorker(ticketId, availableRole, roomId || '');
      if (roomId) matrixService.registerWorkerRoom(ticketId, roomId);
      registry.register(ticketId, 'RUNNING', availableRole, roomId || '');
      registry.update(ticketId, { containerId });
      console.log(`[Scale] ↑ Spawned worker ${availableRole} (${containerId.substring(0, 12)})`);
    } catch (err) {
      console.error('[Scale] Failed to spawn worker on scale up:', err);
    }
  } else if (direction === 'down') {
    const workers = registry.listActive()
      .filter((w) => w.status === 'RUNNING')
      .sort((a, b) => a.startTime - b.startTime);
    if (workers.length === 0) {
      console.warn('[Scale] No idle workers to scale down');
      return;
    }
    const victim = workers[0];
    try {
      await docker.stopWorker(victim.ticketId);
      registry.updateStatus(victim.ticketId, 'STOPPED');
      console.log(`[Scale] ⏹️ Stopped idle worker ${victim.ticketId} (container preserved)`);
    } catch (err) {
      console.error('[Scale] Failed to stop worker on scale down:', err);
    }
  }
};

const zombieInterval = config.docker.zombieCheckIntervalMinutes * 60 * 1000;
const zombieTimer = setInterval(() => {
  docker.killZombies().catch((err) =>
    console.error('[Orchestrator] Zombie killer error:', err)
  );
}, zombieInterval);

const allRoles = getAllAgentRoles();
for (const role of allRoles) {
  const ticketId = `init-${role.id}`;
  if (!registry.lookupByTicket(ticketId)) {
    registry.register(ticketId, 'PENDING', role.id);
    console.log(`[Orchestrator] Registered role: ${role.id} (status: PENDING)`);
  }
}

console.log(`[Orchestrator] AUTO_START_ROLES = "${autoStartRoles.join(',')}"`);
if (autoStartRoles.length > 0) {
  console.log(`[Orchestrator] Starting auto-start sequence for ${autoStartRoles.length} roles...`);
  setTimeout(async () => {
    let startedCount = 0;
    for (const role of autoStartRoles) {
      const ticketId = `init-${role}`;
      const existing = registry.lookupByTicket(ticketId);
      if (!existing || existing.status === 'PENDING') {
        try {
          if (existing) {
            registry.update(ticketId, { status: 'BOOTING' });
          } else {
            registry.register(ticketId, 'BOOTING', role);
          }
          const roomId = await matrixService.createWorkerRoom(role, ticketId);
          const containerId = await docker.spawnWorker(ticketId, role, roomId || '');
          if (roomId) {
            matrixService.registerWorkerRoom(ticketId, roomId);
          }
          registry.update(ticketId, { containerId, status: 'RUNNING' });
          console.log(`[Orchestrator] ✓ Auto-started ${role} worker (${containerId.substring(0, 12)})`);
          startedCount++;
        } catch (err) {
          console.error(`[Orchestrator] Failed to auto-start ${role}:`, err);
          registry.update(ticketId, { status: 'TERMINATING' });
        }
      }
    }
    console.log(`[Orchestrator] ✓ Agent roles: ${allRoles.length} loaded (${startedCount} auto-started)`);
    matrixService.startListening().catch((err) => {
      console.error('[Orchestrator] Failed to start Matrix listener:', err);
    });
    setTimeout(async () => {
      try {
        const botRoom = await matrixService.createWorkerRoom('orchestrator', 'bot');
        if (botRoom) {
          matrixService.registerBotRoom(botRoom);
          await matrixService.sendToRoom(botRoom,
            '🤖 **Turing OS Orchestrator Agent**\n\n' +
            'Hello! I\'m your orchestrator agent. Ask me anything about the system — ' +
            'workers, scale, config, health, or anything else.\n\n' +
            'Try: "how many workers are running?" or "show runtime config"');
        }
      } catch (err) {
        console.error('[Orchestrator] Failed to create bot room:', err);
      }
    }, 5000);
  }, 2000);
}

// ─── Express App ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    console.log(`[HTTP] ${req.method} ${req.path}`);
  }
  next();
});

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
if (!ADMIN_API_TOKEN) {
  console.warn('[Orchestrator] ADMIN_API_TOKEN is not set. Admin-only endpoints will refuse every request.');
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!ADMIN_API_TOKEN) {
    res.status(503).json({ error: 'ADMIN_API_TOKEN not configured on this orchestrator' });
    return;
  }
  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || provided.length !== ADMIN_API_TOKEN.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_API_TOKEN));
    if (!ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', async (_req, res) => {
  const workers = registry.listActive();
  const routing = matrixService.getRoutingStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    workers: {
      total: workers.length,
      running: workers.filter((w) => w.status === 'RUNNING').length,
      stopped: workers.filter((w) => w.status === 'STOPPED').length,
      blocked: workers.filter((w) => w.status === 'BLOCKED').length,
      booting: workers.filter((w) => w.status === 'BOOTING').length,
    },
    health: (await healthMonitor.getHealthSummary()).map((h) => ({
      ticketId: h.ticketId,
      status: h.status,
      heartbeatAge: `${Math.round(h.timeSinceHeartbeat / 1000)}s`,
    })),
    matrix: {
      syncActive: routing.syncActive,
      roomsMapped: routing.rooms.length,
      pendingInbox: routing.inboxes.reduce((s, i) => s + i.pending, 0),
    },
    config: {
      executionMode: config.worker.executionMode,
      maxWorkers: config.docker.maxWorkers,
      zombieTimeout: `${config.docker.timeoutMinutes}min`,
    },
    agents: getAllAgentRoles().map((r) => ({
      id: r.id,
      name: r.name,
      loaded: r.loaded,
    })),
  });
});

if (process.env.GATEWAY_ENABLED !== 'false') {
  const proxyHandler = getProxyHandler();
  app.all('/gateway/llm/*', async (req, res) => {
    req.url = req.url.replace('/gateway/llm', '/gateway/llm');
    await proxyHandler.handleRequest(req, res);
  });
  app.all('/gateway/taiga/*', async (req, res) => {
    await proxyHandler.handleRequest(req, res);
  });
  app.all('/gateway/bookstack/*', async (req, res) => {
    await proxyHandler.handleRequest(req, res);
  });
  app.all('/gateway/matrix/*', async (req, res) => {
    await proxyHandler.handleRequest(req, res);
  });
  app.get('/gateway/health', (_req, res) => {
    const vault = getCredentialVault();
    const tokenManager = getConsumerTokenManager();
    const rbac = getRBACService();
    res.json({
      status: 'ok',
      gatewayEnabled: true,
      credentials: vault.listCredentials().length,
      activeTokens: tokenManager.listTokens().length,
      roles: rbac.getAllRoles(),
    });
  });
  app.get('/gateway/tokens', requireAdmin, (_req, res) => {
    res.json(getConsumerTokenManager().listTokens());
  });
  app.post('/gateway/tokens/revoke/:tokenId', requireAdmin, (req, res) => {
    const tokenId = String(req.params.tokenId);
    const revoked = getConsumerTokenManager().revokeToken(tokenId);
    res.json({ revoked, tokenId });
  });
  app.get('/gateway/credentials', requireAdmin, (_req, res) => {
    res.json(getCredentialVault().listCredentials());
  });
  app.post('/gateway/credentials/import', requireAdmin, async (_req, res) => {
    const count = await getCredentialVault().importFromEnvironment();
    res.json({ imported: count });
  });
  app.post('/gateway/credentials/rotate/:id', requireAdmin, async (_req, res) => {
    res.status(501).json({ error: 'Auto-rotation not implemented yet' });
  });
  app.get('/gateway/audit/stats', requireAdmin, async (req, res) => {
    const { AuditLogger } = await import('./core/gateway/audit-logger');
    const stats = await AuditLogger.getInstance().getStats();
    res.json(stats);
  });
  console.log('[Orchestrator] ✓ Gateway proxy enabled (GATEWAY_ENABLED=true)');
} else {
  app.get('/gateway/health', (_req, res) => {
    res.json({ status: 'disabled', gatewayEnabled: false });
  });
  console.log('[Orchestrator] Gateway proxy disabled (GATEWAY_ENABLED=false)');
}

app.use('/webhooks', webhooksRouter(registry, docker, healthMonitor));

app.get('/workers', (_req, res) => {
  res.json(registry.listActive());
});

app.get('/workers/:ticketId', (req, res) => {
  const worker = registry.lookupByTicket(req.params.ticketId);
  if (!worker) {
    return res.status(404).json({ error: 'Worker not found' });
  }
  res.json(worker);
});

app.post('/workers/:ticketId/stop', async (req, res) => {
  const { ticketId } = req.params;
  try {
    await docker.stopWorker(ticketId);
    registry.updateStatus(ticketId, 'STOPPED');
    res.json({ message: 'Worker stopped (container preserved, can be restarted)', ticketId });
  } catch (error) {
    res.status(500).json({ error: `Failed to stop worker: ${error}` });
  }
});

app.post('/workers/:ticketId/start', async (req, res) => {
  const { ticketId } = req.params;
  try {
    const worker = registry.lookupByTicket(ticketId);
    if (!worker) {
      res.status(404).json({ error: `Worker ${ticketId} not found in registry` });
      return;
    }
    await docker.startWorker(ticketId);
    registry.updateStatus(ticketId, 'RUNNING');
    res.json({ message: 'Worker started', ticketId });
  } catch (error) {
    res.status(500).json({ error: `Failed to start worker: ${error}` });
  }
});

app.delete('/workers/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  try {
    await docker.deleteWorker(ticketId);
    registry.remove(ticketId);
    matrixService.unregisterWorkerRoom(ticketId);
    res.json({ message: 'Worker deleted permanently', ticketId });
  } catch (error) {
    res.status(500).json({ error: `Failed to delete worker: ${error}` });
  }
});

// ─── Container Discovery (for Doctor agent) ────────────────────────────────

/**
 * GET /containers
 * Returns ALL Docker containers (workers + infrastructure) with their
 * role classifications, so Doctor knows what exists to inspect.
 *
 * Query params:
 *   role=<role>      — filter by role (e.g. doctor, devops, qa)
 *   state=<state>    — filter by state (running, exited, paused)
 *   includeLogs=<n>  — attach last N log lines per container (default: 0)
 */
app.get('/containers', async (req, res) => {
  try {
    const { role, state, includeLogs } = req.query;
    const all = await docker.listAllContainers();

    const rolePatterns: [string, RegExp][] = [
      ['orchestrator', /orchestrat/i],
      ['doctor',       /doctor/i],
      ['devops',       /devops/i],
      ['qa',           /(^|[-_])qa[-_]/i],
      ['se',           /(^|[-_])se[-_]|software.engineer/i],
      ['po',           /(^|[-_])po[-_]/i],
      ['pm',           /(^|[-_])pm[-_]/i],
      ['hr',           /(^|[-_])hr[-_]/i],
      ['data',         /(^|[-_])data[-_]/i],
      ['network',      /network/i],
      ['security',     /security/i],
      ['taiga',        /taiga/i],
      ['wiki',         /wiki/i],
      ['synapse',      /synapse|matrix/i],
      ['redis',        /redis/i],
      ['postgres',     /postgres/i],
      ['nginx',        /nginx/i],
      ['rabbitmq',     /rabbitmq/i],
    ];

    const classify = (name: string, image: string): string => {
      const haystack = `${name} ${image}`.toLowerCase();
      for (const [r, re] of rolePatterns) {
        if (re.test(haystack)) return r;
      }
      return 'infrastructure';
    };

    let containers = all.map((c) => {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const role = classify(name, c.Image);
      return {
        id: c.Id,
        name,
        image: c.Image,
        role,
        state: c.State,
        status: c.Status,
        created: c.Created,
        labels: c.Labels || {},
      };
    });

    if (role) {
      containers = containers.filter((x) => x.role === role);
    }
    if (state) {
      containers = containers.filter((x) => x.state === state);
    }

    // Attach recent logs if requested (lightweight — last N lines, errors only).
    // Uses Dockerode container.logs() via DockerService to avoid shell injection.
    if (includeLogs) {
      const n = Math.min(parseInt(String(includeLogs), 10) || 20, 100);
      await Promise.allSettled(
        containers.map(async (c) => {
          try {
            const raw = await docker.getContainerLogs(c.id, n);
            const tail = raw.slice(-2000);
            const errorLines = tail
              .split('\n')
              .filter((l) => /\b(ERROR|FATAL|WARN|WARNING)\b/i.test(l))
              .slice(-n);
            (c as any).recent_errors = errorLines.slice(-10);
          } catch {
            (c as any).recent_errors = [];
          }
        })
      );
    }

    res.json({
      total: containers.length,
      containers,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to list containers: ${error}` });
  }
});

/**
 * GET /containers/:name/logs
 * Returns logs for a specific container — used by Doctor to deep-dive
 * into any worker or infrastructure container.
 *
 * Query params:
 *   lines=<n>   — number of log lines (default: 50, max: 500)
 *   errorsOnly  — if "true", return only ERROR/WARN lines
 */
app.get('/containers/:name/logs', async (req, res) => {
  try {
    const { name } = req.params;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid container name' });
    }
    const lines = Math.min(parseInt(req.query.lines as string, 10) || 50, 500);
    const errorsOnly = req.query.errorsOnly === 'true';

    const raw = await docker.getContainerLogs(name, lines);
    if (!raw) {
      return res.status(404).json({ error: 'Container not found or log access failed' });
    }
    const allLines = raw.split('\n').filter((l) => l.trim());

    let entries = allLines.map((line) => {
      const m = line.match(/^(\S+\s+\S+?)\s+(\w+)\s+(.*)$/);
      if (m) {
        return { timestamp: m[1], level: m[2].toUpperCase(), message: m[3].trim() };
      }
      let level = 'INFO';
      if (/\b(ERROR|FATAL|CRITICAL)\b/i.test(line)) level = 'ERROR';
      else if (/\b(WARN|WARNING)\b/i.test(line)) level = 'WARN';
      return { timestamp: '', level, message: line.trim() };
    });

    if (errorsOnly) {
      entries = entries.filter((e) => e.level === 'ERROR' || e.level === 'WARN');
    }

    res.json({
      container: name,
      total: entries.length,
      entries,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to get logs: ${error}` });
  }
});

app.get('/health/ping', (_req, res) => {
  res.json({ pong: true, ts: Date.now(), uptime: process.uptime() });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Orchestrator] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const PORT = config.port;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`[Orchestrator] ✓ Listening on port ${PORT}`);
  console.log(`[Orchestrator] ✓ Health monitor running (every 60s)`);
  console.log(`[Orchestrator] ✓ Zombie killer running (every ${config.docker.zombieCheckIntervalMinutes}min)`);
  console.log(`[Orchestrator] ✓ Agent roles: ${getAllAgentRoles().length} loaded`);
  console.log(`[Orchestrator] ✓ Matrix bidirectional comm: enabled`);
  console.log('');
});

function shutdown(signal: string): void {
  console.log(`\n[Orchestrator] Received ${signal}, shutting down gracefully...`);
  matrixService.stopListening();
  healthMonitor.stop();
  clearInterval(zombieTimer);
  registry.destroy();
  server.close(() => {
    console.log('[Orchestrator] Server closed. Goodbye!');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[Orchestrator] Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, registry, docker, healthMonitor };
