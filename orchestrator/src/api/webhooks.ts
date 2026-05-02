import { Router, Request, Response } from 'express';
import { DockerService } from '../core/docker';
import { WorkerRegistry } from '../core/registry';
import { RevoltService, revoltService } from '../core/revolt';

export function webhooksRouter(registry: WorkerRegistry, docker: DockerService): Router {
  const router = Router();

  // Handle Plane webhook - triggers worker provisioning
  router.post('/plane', async (req: Request, res: Response) => {
    const ticket_id: string = req.body.ticket_id || req.body.ticketId;

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    const { status, role } = req.body;

    console.log(`[Webhook] Plane webhook received: ticket=${ticket_id}, status=${status}, role=${role}`);

    // Idempotency check - STRICT RULE #3
    if (registry.lookupByTicket(ticket_id)) {
      console.warn(`[Webhook] Ticket ${ticket_id} is already being processed. Ignoring webhook.`);
      return res.status(200).json({ message: 'Already processing', ticket_id });
    }

    // Only process TODO tickets
    if (status && status.toUpperCase() !== 'TODO') {
      console.log(`[Webhook] Ticket ${ticket_id} status is ${status}, skipping.`);
      return res.status(200).json({ message: 'Not a TODO ticket', ticket_id });
    }

    // Register BEFORE provisioning - STRICT RULE #3
    registry.register(ticket_id, 'BOOTING');

    try {
      // Spin up ephemeral worker
      const containerId = await docker.spawnWorker(ticket_id, role || 'default');
      registry.update(ticket_id, { containerId, status: 'RUNNING' });
      console.log(`[Webhook] Worker spawned successfully for ticket ${ticket_id}, container=${containerId}`);
      res.status(200).json({ message: 'Worker spawned', ticket_id, container_id: containerId });
    } catch (error) {
      registry.remove(ticket_id);
      console.error(`[Webhook] Failed to spawn worker for ticket ${ticket_id}:`, error);
      res.status(500).json({ error: 'Failed to spawn worker', details: String(error) });
    }
  });

  // Handle blocked notification from worker
  router.post('/blocked', async (req: Request, res: Response) => {
    const { ticket_id, reason } = req.body;

    console.log(`[Webhook] Blocked notification received: ticket=${ticket_id}, reason=${reason}`);

    if (!ticket_id) {
      return res.status(400).json({ error: 'ticket_id is required' });
    }

    // Send alert to Revolt admin
    await revoltService.notifyBlocked(ticket_id, reason, 'worker');

    res.status(200).json({ message: 'Admin notified', ticket_id });
  });

  // Handle Revolt /unblock command
  router.post('/revolt', async (req: Request, res: Response) => {
    const revolt = new RevoltService();
    const commandData = revolt.parseCommand(req.body);

    if (!commandData) {
      return res.status(400).json({ error: 'Invalid command format' });
    }

    const { command, args } = commandData;
    const ticket_id = args[0];

    console.log(`[Webhook] Revolt command received: ${command}, args=${args}`);

    if (command === '/unblock' && ticket_id) {
      console.log(`[Revolt] Received /unblock for ticket ${ticket_id}`);
      registry.updateStatus(ticket_id, 'PENDING');
      
      try {
        await docker.restartWorker(ticket_id);
        res.status(200).json({ message: 'Worker restarted', ticket_id });
      } catch (error) {
        console.error(`[Revolt] Failed to restart worker:`, error);
        res.status(500).json({ error: 'Failed to restart worker' });
      }
    } else {
      res.status(400).json({ error: 'Invalid command' });
    }
  });

  return router;
}