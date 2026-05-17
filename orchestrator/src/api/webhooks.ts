// SECURITY: admin-only routes (`/matrix` slash commands, `/workers/:ticketId/recover`)
// require ADMIN_API_TOKEN via the `requireAdmin` middleware. The Plane webhook
// (`/plane`) is guarded by `verifyPlaneSignature` when PLANE_WEBHOOK_SECRET is set.
// Worker→orchestrator routes (`/blocked`, `/completed`, `/worker-message`,
// `/health/*`, `/checkpoint`, `/worker-inbox/*`) require WORKER_INTERNAL_TOKEN
// when set; until then they remain open for transitional deployments.

import { Router, Request, Response, RequestHandler } from 'express';
import { DockerService } from '../core/docker';
import { WorkerRegistry } from '../core/registry';
import { matrixService } from '../core/matrix';
import { HealthMonitor } from '../core/health-monitor';
import { getRoleSpec } from '../agents/init';
import { config } from '../config';
import { priorityQueue, Priority, QueuedTask, normalizePriority } from '../core/priority-queue';
import { scanTaskDescription } from '../core/security/prompt-filter';
import { getAuditStore } from '../core/security/audit-store';
import { natsService, NatsService } from '../core/nats';
import { makeRequireAdmin, makeRequireWorkerToken, makeVerifyPlaneSignature } from './middleware';

function mirrorToNats(
  registry: WorkerRegistry,
  ticketId: string,
  kind: 'event' | 'heartbeat',
  payload: Record<string, unknown>,
): void {
  if (!natsService.isEnabled()) return;
  const worker = registry.lookupByTicket(ticketId);
  const role = worker?.role || 'unknown';
  const subject = NatsService.workerSubject(role, ticketId, kind);
  natsService.publish(subject, { ticketId, role, ...payload, ts: Date.now() }).catch(() => undefined);
}

const TICKET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,63}$/;

// Cap admin-question timeout at 1h. Workers should not be able to keep a
// pending question alive indefinitely (memory + UX).
const MAX_QUESTION_TIMEOUT_SECONDS = 3600;

function isValidTicketId(value: unknown): value is string {
  return typeof value === 'string' && TICKET_ID_PATTERN.test(value);
}

export function webhooksRouter(
  registry: WorkerRegistry,
  docker: DockerService,
  healthMonitor: HealthMonitor
): Router {
  const router = Router();
  const requireAdmin: RequestHandler = makeRequireAdmin();
  const requireWorker: RequestHandler = makeRequireWorkerToken();
  const verifyPlaneSig: RequestHandler = makeVerifyPlaneSignature();

  // ─── Plane Webhook — Triggers worker provisioning ─────────────────────
  router.post('/plane', verifyPlaneSig, async (req: Request, res: Response) => {
    const ticket_id: string = req.body.ticket_id || req.body.ticketId;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id must be 1–64 chars of [a-zA-Z0-9_.-]' });
    }

    const { status, state, role, priority } = req.body;
    const taskPriority: Priority = normalizePriority(priority);
    console.log(`[Webhook] Plane: ticket=${ticket_id}, status=${status}, role=${role || 'default'}, priority=${taskPriority}`);

    // Prompt Injection Filter Check
    const description = req.body.description || req.body.subject || '';
    const scanResult = scanTaskDescription(description, { ticketId: ticket_id, source: 'plane' });
    if (!scanResult.isSafe) {
      console.warn(`[Security] Blocked malicious ticket ${ticket_id}: ${scanResult.reason}`);
      await matrixService.sendDM(config.matrix.adminUserId || '', `🚨 **Security Alert**\nBlocked Plane ticket \`${ticket_id}\` due to suspected Prompt Injection.\nReason: ${scanResult.reason}`);
      return res.status(403).json({ error: 'Blocked for security policy violation' });
    }

    // Idempotency check — STRICT RULE #3
    if (registry.lookupByTicket(ticket_id) || priorityQueue.hasTask(ticket_id)) {
      console.warn(`[Webhook] Ticket ${ticket_id} already being processed. Ignoring.`);
      return res.status(200).json({ message: 'Already processing', ticket_id });
    }

    // Decide whether this ticket is in the "ready-to-pick-up" state.
    // Plane sends either a string slug (legacy / external callers) or a
    // structured `state` object with `group` and `name`. Backlog / unstarted
    // groups are treated as actionable; anything else is skipped.
    if (!isPickupReady(status, state)) {
      console.log(`[Webhook] Ticket ${ticket_id} not in a pickup-ready state (status=${status}, state=${JSON.stringify(state)}), skipping.`);
      return res.status(200).json({ message: 'Not a pickup-ready ticket', ticket_id });
    }

    const workerRole = role || 'software-engineer';

    // Check if we should interrupt current running task (P0 only)
    const runningTask = priorityQueue.getRunningTask();
    if (runningTask && priorityQueue.shouldInterrupt(runningTask.priority, taskPriority)) {
      console.log(`[Webhook] P0 interrupt triggered: pausing ${runningTask.ticketId} to run ${ticket_id}`);

      // Enqueue the P0 task
      const p0Task = priorityQueue.enqueue({
        ticketId: ticket_id,
        role: workerRole,
        priority: taskPriority,
      });

      // Register in registry
      registry.register(ticket_id, 'BOOTING', workerRole);

      try {
        // Pause current task
        await docker.killWorker(runningTask.ticketId);
        registry.updateStatus(runningTask.ticketId, 'PENDING');

        // Create Matrix room for the P0 worker
        const roomId = await matrixService.createWorkerRoom(workerRole, ticket_id);
        const containerId = await docker.spawnWorker(ticket_id, workerRole, roomId || '');

        // Register room→worker mapping
        if (roomId) {
          matrixService.registerWorkerRoom(ticket_id, roomId);
        }

        // Start P0 task in queue
        priorityQueue.startTask(p0Task);
        registry.update(ticket_id, { containerId, status: 'RUNNING' });

        // Notify about the interrupt
        await matrixService.sendToRoom(
          matrixService.getWorkerRoomId(runningTask.ticketId) || '',
          `⚠️ **P0 Interrupt**: Task \`${runningTask.ticketId}\` paused for emergency task \`${ticket_id}\`. Will resume after P0 completes.`
        );

        console.log(`[Webhook] P0 worker spawned: ticket=${ticket_id}, container=${containerId.substring(0, 12)}`);
        return res.status(200).json({ message: 'P0 interrupt: worker spawned', ticket_id, container_id: containerId, interrupted: runningTask.ticketId });
      } catch (error) {
        registry.remove(ticket_id);
        priorityQueue.remove(ticket_id);
        console.error(`[Webhook] Failed to spawn P0 worker for ticket ${ticket_id}:`, error);
        return res.status(500).json({ error: 'Failed to spawn P0 worker', details: String(error) });
      }
    }

    // Normal flow: enqueue or spawn immediately if no running task
    if (!runningTask && priorityQueue.getQueuedTasks().length === 0) {
      // No tasks running, spawn immediately
      registry.register(ticket_id, 'BOOTING', workerRole);

      try {
        const roomId = await matrixService.createWorkerRoom(workerRole, ticket_id);
        const containerId = await docker.spawnWorker(ticket_id, workerRole, roomId || '');

        if (roomId) {
          matrixService.registerWorkerRoom(ticket_id, roomId);
        }

        const task = priorityQueue.enqueue({
          ticketId: ticket_id,
          role: workerRole,
          priority: taskPriority,
        });
        priorityQueue.startTask(task);

        registry.update(ticket_id, { containerId, status: 'RUNNING' });
        console.log(`[Webhook] Worker spawned: ticket=${ticket_id}, container=${containerId.substring(0, 12)}`);
        res.status(200).json({ message: 'Worker spawned', ticket_id, container_id: containerId });
      } catch (error) {
        registry.remove(ticket_id);
        console.error(`[Webhook] Failed to spawn worker for ticket ${ticket_id}:`, error);
        res.status(500).json({ error: 'Failed to spawn worker', details: String(error) });
      }
    } else {
      // Queue the task
      priorityQueue.enqueue({
        ticketId: ticket_id,
        role: workerRole,
        priority: taskPriority,
      });

      registry.register(ticket_id, 'PENDING', workerRole);
      console.log(`[Webhook] Task queued: ticket=${ticket_id}, priority=${taskPriority}, queue position=${priorityQueue.getQueuedTasks().length}`);
      res.status(200).json({ message: 'Task queued', ticket_id, priority: taskPriority, queue_position: priorityQueue.getQueuedTasks().length });
    }
  });

  // ─── Blocked notification from worker ──────────────────────────────────
  router.post('/blocked', requireWorker, async (req: Request, res: Response) => {
    const { ticket_id, reason } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id format invalid' });
    }

    console.log(`[Webhook] Blocked: ticket=${ticket_id}, reason=${reason}`);

    mirrorToNats(registry, ticket_id, 'event', { kind: 'blocked', reason: reason || null });

    // Update priority queue
    priorityQueue.blockTask(ticket_id);

    registry.updateStatus(ticket_id, 'BLOCKED');
    registry.update(ticket_id, { lastBlockedReason: reason || 'No reason provided' });
    matrixService.clearPendingQuestion(ticket_id);
    await matrixService.notifyBlocked(ticket_id, reason || 'No reason provided', 'worker');

    // Try to spawn next queued task
    await spawnNextQueuedTask(registry, docker, matrixService);

    res.status(200).json({ message: 'Admin notified', ticket_id });
  });

  // ─── Completion notification from worker ───────────────────────────────
  router.post('/completed', requireWorker, async (req: Request, res: Response) => {
    const { ticket_id, summary } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id format invalid' });
    }

    console.log(`[Webhook] Completed: ticket=${ticket_id}, summary=${summary}`);

    mirrorToNats(registry, ticket_id, 'event', { kind: 'completed', summary: summary || null });

    // Update priority queue and get next task
    const nextTask = priorityQueue.completeTask(ticket_id);

    registry.remove(ticket_id);
    matrixService.clearPendingQuestion(ticket_id);
    await matrixService.notifyCompleted(ticket_id, summary || 'Task completed');

    // Spawn next queued task if available
    if (nextTask) {
      await spawnTask(nextTask, registry, docker, matrixService);
    }

    res.status(200).json({ message: 'Completion recorded', ticket_id });
  });

  // ─── Worker → Admin message relay ──────────────────────────────────────
  // Worker sends a message that gets forwarded to its Matrix room
  router.post('/worker-message', requireWorker, async (req: Request, res: Response) => {
    const { ticket_id, message, message_type } = req.body;
    const timeoutSeconds = Math.min(
      parsePositiveInt(req.body.timeout_seconds) ?? 300,
      MAX_QUESTION_TIMEOUT_SECONDS,
    );

    if (!ticket_id || !message) {
      return res.status(400).json({ error: 'ticket_id and message are required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id format invalid' });
    }

    console.log(`[Webhook] Worker message: ticket=${ticket_id}, type=${message_type || 'info'}`);

    // Format message based on type
    let formatted = message;
    if (message_type === 'question') {
      matrixService.registerPendingQuestion(ticket_id, message, timeoutSeconds);
      formatted = `❓ **Worker Question**\n\n${message}\n\n_Reply in this room to answer._`;
    } else if (message_type === 'progress') {
      formatted = `📋 **Progress Update**\n\n${message}`;
    } else if (message_type === 'error') {
      formatted = `❌ **Worker Error**\n\n${message}`;
    }

    const sent = await matrixService.sendToWorkerRoom(ticket_id, formatted);

    if (sent) {
      res.status(200).json({ message: 'Message relayed to Matrix', ticket_id });
    } else {
      // Fallback: send DM to admin
      if (config.matrix.adminUserId) {
        await matrixService.sendDM(config.matrix.adminUserId, `[Worker ${ticket_id}] ${formatted}`);
      }
      res.status(200).json({ message: 'Message sent as DM fallback', ticket_id });
    }
  });

  // ─── Worker inbox drain (admin-bound messages) ─────────────────────────
  // Drain is destructive — messages are removed from the queue on read.
  // The canonical method is POST .../drain. The legacy GET route is kept
  // for backward-compat with running workers; it sets a Deprecation header
  // so callers know to migrate.
  const handleInboxDrain = (req: Request, res: Response) => {
    const { ticketId } = req.params as { ticketId: string };
    if (!isValidTicketId(ticketId)) {
      return res.status(400).json({ error: 'ticketId format invalid' });
    }
    const since = parseSinceTimestamp(req.query.since);
    const messages = matrixService.drainWorkerInbox(ticketId, since);

    res.status(200).json({
      ticket_id: ticketId,
      messages: messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp,
        isStructuredCommand: m.isStructuredCommand || false,
        commandType: m.commandType || null,
        commandArgs: m.commandArgs || null,
      })),
      count: messages.length,
    });
  };

  router.post('/worker-inbox/:ticketId/drain', requireWorker, handleInboxDrain);

  router.get('/worker-inbox/:ticketId', requireWorker, (req: Request, res: Response) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</webhooks/worker-inbox/:ticketId/drain>; rel="successor-version"');
    handleInboxDrain(req, res);
  });

  // ─── Worker inbox peek (non-destructive) ───────────────────────────────
  router.get('/worker-inbox/:ticketId/peek', requireWorker, (req: Request, res: Response) => {
    const { ticketId } = req.params as { ticketId: string };
    if (!isValidTicketId(ticketId)) {
      return res.status(400).json({ error: 'ticketId format invalid' });
    }
    const since = parseSinceTimestamp(req.query.since);
    const messages = matrixService.peekWorkerInbox(ticketId, since);

    res.status(200).json({
      ticket_id: ticketId,
      messages: messages.map((m) => ({
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp,
        isStructuredCommand: m.isStructuredCommand || false,
        commandType: m.commandType || null,
        commandArgs: m.commandArgs || null,
      })),
      count: messages.length,
    });
  });

  // ─── Admin structured command dispatch ─────────────────────────────────
  // Admin sends `{ target_ticket, command_type, args }`; orchestrator
  // validates against an allow-list and injects a structured command into
  // the target worker's inbox. Worker's command_executor handles it.
  const STRUCTURED_COMMAND_TYPES = new Set([
    'register_tool',
    'unregister_tool',
    'update_config',
    'set_system_prompt',
    'reload_role',
    'reload_skills',
    'inspect',
    'save_tool',
    'load_tools',
    'delete_tool',
  ]);

  router.post('/admin-command', requireAdmin, (req: Request, res: Response) => {
    const { target_ticket, command_type, args } = req.body ?? {};

    if (!target_ticket || typeof target_ticket !== 'string') {
      return res.status(400).json({ error: 'target_ticket (string) is required' });
    }
    if (!isValidTicketId(target_ticket)) {
      return res.status(400).json({ error: 'target_ticket format invalid' });
    }
    if (!command_type || typeof command_type !== 'string') {
      return res.status(400).json({ error: 'command_type (string) is required' });
    }
    if (!STRUCTURED_COMMAND_TYPES.has(command_type)) {
      return res.status(400).json({
        error: `Unknown command_type '${command_type}'`,
        allowed: Array.from(STRUCTURED_COMMAND_TYPES),
      });
    }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      return res.status(400).json({ error: 'args must be a plain object when provided' });
    }

    if (!registry.lookupByTicket(target_ticket)) {
      return res.status(404).json({ error: `target_ticket ${target_ticket} not registered` });
    }

    const sender = String((req.get('x-admin-sender') as string) || 'admin');
    matrixService.pushStructuredCommand(target_ticket, sender, {
      type: command_type,
      args: (args as Record<string, any>) || {},
    });

    console.log(`[AdminCommand] ${sender} → ${target_ticket}: ${command_type}`);
    res.status(202).json({ queued: true, target_ticket, command_type });
  });

  // ─── Matrix /unblock command (admin-only) ──────────────────────────────
  router.post('/matrix', requireAdmin, async (req: Request, res: Response) => {
    const commandData = matrixService.parseCommand(req.body);

    if (!commandData) {
      return res.status(400).json({ error: 'Invalid command format' });
    }

    const { command, args } = commandData;
    const ticket_id = args[0];

    console.log(`[Webhook] Matrix command: ${command}, args=${args.join(', ')}`);

    if (command === '/unblock' && ticket_id) {
      const worker = registry.lookupByTicket(ticket_id);
      if (!worker) {
        return res.status(404).json({ error: `Ticket ${ticket_id} not found in registry` });
      }

      registry.updateStatus(ticket_id, 'PENDING');

      try {
        await docker.restartWorker(ticket_id, worker.role, worker.roomId || '');
        registry.updateStatus(ticket_id, 'RUNNING');
        res.status(200).json({ message: 'Worker restarted', ticket_id });
      } catch (error) {
        console.error(`[Webhook] Failed to restart worker for ${ticket_id}:`, error);
        res.status(500).json({ error: 'Failed to restart worker' });
      }
    } else if (command === '/status') {
      const workers = registry.listActive();
      const health = healthMonitor.getHealthSummary();
      res.status(200).json({ workers, health });
    } else if (command === '/timeout-status') {
      res.status(200).json({
        pending_questions: matrixService.getPendingQuestions(),
        timestamp: Date.now(),
      });
    } else if (command === '/kill' && ticket_id) {
      try {
        await docker.killWorker(ticket_id);
        registry.remove(ticket_id);
        matrixService.unregisterWorkerRoom(ticket_id);
        res.status(200).json({ message: 'Worker killed', ticket_id });
      } catch (error) {
        res.status(500).json({ error: 'Failed to kill worker' });
      }
    } else {
      res.status(400).json({ error: `Unknown command: ${command}` });
    }
  });

  // ─── Matrix routing status ────────────────────────────────────────────
  router.get('/matrix/status', (_req: Request, res: Response) => {
    const routing = matrixService.getRoutingStatus();
    res.json(routing);
  });

  // ─── Pending admin-question timeout status ───────────────────────────
  router.get('/timeouts/status', (_req: Request, res: Response) => {
    res.json({
      pending_questions: matrixService.getPendingQuestions(),
      timestamp: Date.now(),
    });
  });

  // ─── Priority Queue status ────────────────────────────────────────────
  router.get('/queue/status', (_req: Request, res: Response) => {
    const summary = priorityQueue.getSummary();
    res.json({
      ...summary,
      timestamp: Date.now(),
    });
  });

  // ─── Health heartbeat from worker ──────────────────────────────────────
  router.post('/health/heartbeat', requireWorker, (req: Request, res: Response) => {
    const { ticket_id, status, progress, checkpoint_count, last_checkpoint_iteration, last_checkpoint_age } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id format invalid' });
    }

    healthMonitor.onHeartbeat(ticket_id, { status, progress });

    // Track checkpoint info in registry for PM visibility
    if (registry.lookupByTicket(ticket_id)) {
      registry.update(ticket_id, {
        lastCheckpointTime: Date.now(),
        lastCheckpointIteration: typeof last_checkpoint_iteration === 'number' ? last_checkpoint_iteration : 0,
        checkpointCount: typeof checkpoint_count === 'number' ? checkpoint_count : 0,
      });
    }

    mirrorToNats(registry, ticket_id, 'heartbeat', {
      status: status || null,
      progress: progress ?? null,
      checkpointCount: checkpoint_count ?? null,
      lastCheckpointIteration: last_checkpoint_iteration ?? null,
    });

    res.status(200).json({ ack: true, timestamp: Date.now() });
  });

  // ─── Checkpoint events from worker ─────────────────────────────────────
  router.post('/checkpoint', requireWorker, (req: Request, res: Response) => {
    const { ticket_id, role, event, iteration, save_count, timestamp } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }
    if (!isValidTicketId(ticket_id)) {
      return res.status(400).json({ error: 'ticket_id format invalid' });
    }

    console.log(`[Checkpoint] ${event} for ticket=${ticket_id} (iteration=${iteration}, saves=${save_count})`);

    // Track checkpoint in registry
    if (registry.lookupByTicket(ticket_id)) {
      registry.update(ticket_id, {
        lastCheckpointTime: Date.now(),
        lastCheckpointIteration: iteration || 0,
        checkpointCount: save_count || 0,
      });
    }

    res.status(200).json({ ack: true, event, ticket_id });
  });

  // ─── Worker recovery: restart from checkpoint ──────────────────────────
  // Admin-only because spawning a container is a privileged action.
  router.post('/workers/:ticketId/recover', requireAdmin, async (req: Request, res: Response) => {
    const ticketId = req.params.ticketId as string;
    if (!isValidTicketId(ticketId)) {
      return res.status(400).json({ error: 'ticketId format invalid' });
    }
    const worker = registry.lookupByTicket(ticketId);

    if (!worker) {
      return res.status(404).json({ error: `Worker ${ticketId} not found` });
    }

    console.log(`[Recovery] Initiating checkpoint-based recovery for ticket=${ticketId}`);

    try {
      // Stop old container if exists
      await docker.stopWorker(ticketId).catch(() => {});

      // Spawn new worker — it will load checkpoint automatically on startup
      const containerId = await docker.spawnWorker(ticketId, worker.role, worker.roomId || '');

      registry.update(ticketId, { containerId, status: 'RUNNING' });
      registry.update(ticketId, { lastCheckpointTime: Date.now() } as any);

      console.log(`[Recovery] ✓ Worker recovered for ticket=${ticketId}, container=${containerId.substring(0, 12)}`);
      res.status(200).json({
        message: 'Worker recovered from checkpoint',
        ticket_id: ticketId,
        container_id: containerId,
      });
    } catch (error) {
      console.error(`[Recovery] Failed to recover worker ${ticketId}:`, error);
      res.status(500).json({ error: `Recovery failed: ${error}` });
    }
  });

  // ─── Health status endpoint ────────────────────────────────────────────
  router.get('/health/status', (_req: Request, res: Response) => {
    const summary = healthMonitor.getHealthSummary();
    res.json({ workers: summary, timestamp: Date.now() });
  });

  // ─── Health: Get all workers health (for PM monitoring) ───────────────
  router.get('/health/all', async (_req: Request, res: Response) => {
    try {
      const summary = await healthMonitor.getHealthSummary();
      const workers = registry.listActive().map((w) => {
        const health = summary.find((h: any) => h.ticketId === w.ticketId);
        return {
          ticketId: w.ticketId,
          role: w.role,
          status: health?.status || 'unknown',
          lastHeartbeat: w.lastHeartbeat,
          lastProgress: w.lastProgress,
          timeSinceHeartbeat: health?.timeSinceHeartbeat || 0,
          timeSinceProgress: health?.timeSinceProgress || 0,
          consecutiveMisses: health?.consecutiveMisses || 0,
          cpuPercent: health?.cpuPercent,
          memoryPercent: health?.memoryPercent,
        };
      });
      res.status(200).json({
        workers,
        summary: {
          healthy: workers.filter((w: any) => w.status === 'healthy').length,
          warning: workers.filter((w: any) => w.status === 'warning').length,
          stuck: workers.filter((w: any) => w.status === 'stuck').length,
          dead: workers.filter((w: any) => w.status === 'dead').length,
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ─── Health: Get specific worker health ───────────────────────────────
  router.get('/health/worker/:ticketId', async (req: Request, res: Response) => {
    const { ticketId } = req.params as { ticketId: string };
    if (!isValidTicketId(ticketId)) {
      return res.status(400).json({ error: 'ticketId format invalid' });
    }
    const worker = registry.lookupByTicket(ticketId);
    if (!worker) {
      return res.status(404).json({ error: 'Worker not found' });
    }
    try {
      const summary = await healthMonitor.getHealthSummary();
      const health = summary.find((h: any) => h.ticketId === ticketId);
      res.status(200).json({
        ticketId: worker.ticketId,
        role: worker.role,
        status: health?.status || 'unknown',
        lastHeartbeat: worker.lastHeartbeat,
        lastProgress: worker.lastProgress,
        timeSinceHeartbeat: health?.timeSinceHeartbeat || 0,
        timeSinceProgress: health?.timeSinceProgress || 0,
        consecutiveMisses: health?.consecutiveMisses || 0,
        cpuPercent: health?.cpuPercent,
        memoryPercent: health?.memoryPercent,
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ─── Audit log — Prompt-filter and gateway channels (admin-only) ───────
  router.get('/audit/:channel', requireAdmin, async (req: Request, res: Response) => {
    const channel = String(req.params.channel || '');
    const ALLOWED = new Set(['prompt-filter', 'gateway']);
    if (!ALLOWED.has(channel)) {
      return res.status(400).json({ error: `Unknown audit channel '${channel}'`, allowed: Array.from(ALLOWED) });
    }
    const countRaw = parsePositiveInt(req.query.count) ?? 100;
    const count = Math.min(countRaw, 1000);
    try {
      const entries = await getAuditStore().tail(channel, count);
      res.json({ channel, count: entries.length, entries });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // ─── Get role spec for a worker ────────────────────────────────────────
  router.get('/roles/:roleId', (req: Request, res: Response) => {
    const { roleId } = req.params as { roleId: string };
    const spec = getRoleSpec(roleId);

    if (!spec) {
      return res.status(404).json({ error: `Role spec not found: ${roleId}` });
    }

    res.json({ roleId, spec, length: spec.length });
  });

  return router;
}

/**
 * True if the ticket payload describes a state the worker pool should
 * pick up. Accepts: missing status (assume ready), legacy "TODO"-like
 * slugs, and Plane's structured state object with group ∈ {backlog,
 * unstarted, started}.
 */
function isPickupReady(status: unknown, state: unknown): boolean {
  if (!status && !state) return true;

  if (typeof status === 'string') {
    const slug = status.toUpperCase();
    const READY_SLUGS = new Set(['TODO', 'TO-DO', 'TO_DO', 'BACKLOG', 'OPEN', 'NEW', 'READY']);
    if (READY_SLUGS.has(slug)) return true;
  }

  if (state && typeof state === 'object') {
    const group = String((state as { group?: unknown }).group || '').toLowerCase();
    if (group === 'backlog' || group === 'unstarted' || group === 'started') return true;
    const name = String((state as { name?: unknown }).name || '').toUpperCase();
    if (name === 'TODO' || name === 'OPEN' || name === 'BACKLOG') return true;
  }

  return false;
}

function parseSinceTimestamp(rawValue: unknown): number | undefined {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveInt(rawValue: unknown): number | undefined {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) && rawValue > 0 ? Math.floor(rawValue) : undefined;
  }

  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return undefined;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// ─── Helper Functions for Priority Queue ─────────────────────────────────

/**
 * Spawn a task from the priority queue
 */
async function spawnTask(
  task: QueuedTask,
  registry: WorkerRegistry,
  docker: DockerService,
  matrixSvc: typeof matrixService
): Promise<boolean> {
  console.log(`[PriorityQueue] Spawning next task: ${task.ticketId} (${task.priority})`);

  registry.register(task.ticketId, 'BOOTING', task.role);

  try {
    const roomId = await matrixSvc.createWorkerRoom(task.role, task.ticketId);
    const containerId = await docker.spawnWorker(task.ticketId, task.role, roomId || '');

    if (roomId) {
      matrixSvc.registerWorkerRoom(task.ticketId, roomId);
    }

    priorityQueue.startTask(task);
    registry.update(task.ticketId, { containerId, status: 'RUNNING' });
    console.log(`[PriorityQueue] Worker spawned: ${task.ticketId} (${containerId.substring(0, 12)})`);
    return true;
  } catch (error) {
    registry.remove(task.ticketId);
    matrixSvc.unregisterWorkerRoom(task.ticketId);
    priorityQueue.enqueue({
      ticketId: task.ticketId,
      role: task.role,
      priority: task.priority,
    });
    console.error(`[PriorityQueue] Failed to spawn worker for ${task.ticketId}:`, error);
    return false;
  }
}

/**
 * Spawn the next queued task if a worker slot is available
 */
async function spawnNextQueuedTask(
  registry: WorkerRegistry,
  docker: DockerService,
  matrixSvc: typeof matrixService
): Promise<void> {
  const nextTask = priorityQueue.dequeue();
  if (nextTask) {
    await spawnTask(nextTask, registry, docker, matrixSvc);
  }
}