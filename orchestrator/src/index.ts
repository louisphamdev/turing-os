import express from 'express';
import { webhooksRouter } from './api/webhooks';
import { dockerService, DockerService } from './core/docker';
import { WorkerRegistry } from './core/registry';

// Initialize registry and docker service
const registry = new WorkerRegistry();
const docker = new DockerService();

// Start zombie killer cron (every 5 minutes)
setInterval(() => {
  docker.killZombies().catch(console.error);
}, 5 * 60 * 1000);

const app = express();

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    workers: registry.listActive().length
  });
});

// Mount webhooks router
app.use('/webhooks', webhooksRouter(registry, docker));

// Worker management endpoints
app.get('/workers', (req, res) => {
  res.json(registry.listActive());
});

app.delete('/workers/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  try {
    await docker.killWorker(ticketId);
    registry.remove(ticketId);
    res.json({ message: 'Worker terminated', ticketId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to terminate worker' });
  }
});

const PORT = parseInt(process.env.PORT || '3000');
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Orchestrator] Listening on port ${PORT}`);
  console.log(`[Orchestrator] Zombie killer running every 5 minutes`);
});

// Export for testing
export { app, registry, docker };