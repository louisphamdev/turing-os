import { Router, Request, Response } from 'express';
import { DockerService } from '../core/docker';
import { WorkerRegistry } from '../core/registry';
import { matrixService } from '../core/matrix';
import { HealthMonitor } from '../core/health-monitor';
import { getRoleSpec } from '../agents/init';
import { config } from '../config';
import { priorityQueue, Priority, QueuedTask } from '../core/priority-queue';
import { scanTaskDescription } from '../core/security/prompt-filter';

export function webhooksRouter(
  registry: WorkerRegistry,
  docker: DockerService,
  healthMonitor: HealthMonitor
): Router {
  const router = Router();

  // ─── Taiga Webhook — Triggers worker provisioning ─────────────────────
  router.post('/taiga', async (req: Request, res: Response) => {
    const ticket_id: string = req.body.ticket_id || req.body.ticketId;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    const { status, role, priority } = req.body;
    const taskPriority: Priority = (priority as Priority) || 'P2';
    console.log(`[Webhook] Taiga: ticket=${ticket_id}, status=${status}, role=${role || 'default'}, priority=${taskPriority}`);

    // Prompt Injection Filter Check
    const description = req.body.description || req.body.subject || '';
    const scanResult = scanTaskDescription(description);
    if (!scanResult.isSafe) {
      console.warn(`[Security] Blocked malicious ticket ${ticket_id}: ${scanResult.reason}`);
      await matrixService.sendDM(config.matrix.adminUserId || '', `🚨 **Security Alert**\nBlocked Taiga ticket \`${ticket_id}\` due to suspected Prompt Injection.\nReason: ${scanResult.reason}`);
      return res.status(403).json({ error: 'Blocked for security policy violation' });
    }

    // Idempotency check — STRICT RULE #3
    if (registry.lookupByTicket(ticket_id) || priorityQueue.hasTask(ticket_id)) {
      console.warn(`[Webhook] Ticket ${ticket_id} already being processed. Ignoring.`);
      return res.status(200).json({ message: 'Already processing', ticket_id });
    }

    // Only process TODO tickets
    if (status && status.toUpperCase() !== 'TODO') {
      console.log(`[Webhook] Ticket ${ticket_id} status is ${status}, skipping.`);
      return res.status(200).json({ message: 'Not a TODO ticket', ticket_id });
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
  router.post('/blocked', async (req: Request, res: Response) => {
    const { ticket_id, reason } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    console.log(`[Webhook] Blocked: ticket=${ticket_id}, reason=${reason}`);

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
  router.post('/completed', async (req: Request, res: Response) => {
    const { ticket_id, summary } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    console.log(`[Webhook] Completed: ticket=${ticket_id}, summary=${summary}`);

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
  router.post('/worker-message', async (req: Request, res: Response) => {
    const { ticket_id, message, message_type } = req.body;
    const timeoutSeconds = parsePositiveInt(req.body.timeout_seconds) ?? 300;

    if (!ticket_id || !message) {
      return res.status(400).json({ error: 'ticket_id and message are required' });
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

  // ─── Worker inbox — Worker polls for admin messages ────────────────────
  // Worker calls this to get messages that admin sent in the Matrix room
  router.get('/worker-inbox/:ticketId', (req: Request, res: Response) => {
    const { ticketId } = req.params as { ticketId: string };
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
  });

  // ─── Worker inbox peek (non-destructive) ───────────────────────────────
  router.get('/worker-inbox/:ticketId/peek', (req: Request, res: Response) => {
    const { ticketId } = req.params as { ticketId: string };
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

  // ─── Matrix /unblock command (legacy webhook endpoint) ─────────────────
  router.post('/matrix', async (req: Request, res: Response) => {
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
  router.post('/health/heartbeat', (req: Request, res: Response) => {
    const { ticket_id, status, progress } = req.body;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    healthMonitor.onHeartbeat(ticket_id, { status, progress });
    res.status(200).json({ ack: true, timestamp: Date.now() });
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