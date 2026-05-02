import Docker from 'dockerode';
import dotenv from 'dotenv';

dotenv.config();

export interface ActiveWorker {
  containerId: string;
  ticketId: string;
  startTime: number;
  status: 'BOOTING' | 'RUNNING' | 'TERMINATING';
}

export class DockerService {
  private docker: Docker;

  constructor() {
    const socketPath = process.env.DOCKER_HOST || '/var/run/docker.sock';
    this.docker = new Docker(socketPath.includes('unix') ? { socketPath } : { socketPath });
  }

  async spawnWorker(ticketId: string, role: string): Promise<string> {
    // Note: LLM_API_KEY is passed at runtime from host, NOT baked into image
    const apiKey = process.env.LLM_API_KEY;
    const imageName = process.env.WORKER_IMAGE || 'turing-worker-base:latest';
    const provider = process.env.LLM_PROVIDER || 'openai';
    
    // CONTEXT7_API_KEY is retrieved from BookStack secret storage at spawn time
    // This key is required for workers to research unfamiliar technologies
    const context7ApiKey = await this._getSecretFromBookStack('context7-api-key');
    
    if (!apiKey) {
      throw new Error('LLM_API_KEY not configured in environment');
    }

    const container = await this.docker.createContainer({
      Image: imageName,
      Env: [
        `TICKET_ID=${ticketId}`,
        `ROLE=${role}`,
        `LLM_API_KEY=${apiKey}`,
        `LLM_PROVIDER=${provider}`,
        `PLANE_API_URL=${process.env.PLANE_API_URL}`,
        `PLANE_API_KEY=${process.env.PLANE_API_KEY}`,
        `PLANE_WORKSPACE_ID=${process.env.PLANE_WORKSPACE_ID}`,
        `CONTEXT7_API_KEY=${context7ApiKey || ''}`
      ],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: 'turing-os_turing_network'
      },
      Labels: {
        'turing-worker': 'true',
        'ticket-id': ticketId
      }
    });

    await container.start();
    console.log(`[Docker] Spawned worker container ${container.id} for ticket ${ticketId}`);
    return container.id;
  }
  
  private async _getSecretFromBookStack(secretKey: string): Promise<string | null> {
    /**
     * Retrieve secret from BookStack secrets page.
     * BookStack stores secrets under a dedicated secrets page.
     */
    const bookstackUrl = process.env.BOOKSTACK_URL || 'http://bookstack:3001';
    const bookstackToken = process.env.BOOKSTACK_API_TOKEN;
    
    if (!bookstackToken) {
      console.warn(`[Docker] BookStack token not configured - ${secretKey} will not be available to workers`);
      return null;
    }
    
    try {
      // Search for secrets page
      const searchResponse = await fetch(`${bookstackUrl}/api/search?query=secrets&count=1`, {
        headers: {
          'Authorization': `Token ${bookstackToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!searchResponse.ok) {
        console.warn(`[Docker] Failed to search BookStack secrets`);
        return null;
      }
      
      const searchData = await searchResponse.json();
      const secretsPage = searchData.data?.[0];
      
      if (!secretsPage || secretsPage.type !== 'page') {
        console.warn(`[Docker] No secrets page found in BookStack`);
        return null;
      }
      
      // Get page content to find the specific secret
      const pageResponse = await fetch(`${bookstackUrl}/api/pages/${secretsPage.id}`, {
        headers: {
          'Authorization': `Token ${bookstackToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!pageResponse.ok) {
        console.warn(`[Docker] Failed to fetch secrets page`);
        return null;
      }
      
      const pageData = await pageResponse.json();
      const pageContent = pageData?.html || pageData?.content || '';
      
      // Parse secret from page content (format: KEY=VALUE per line)
      const secretPattern = new RegExp(`${secretKey}=(.+)`, 'i');
      const match = pageContent.match(secretPattern);
      
      if (match && match[1]) {
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

  async restartWorker(ticketId: string): Promise<void> {
    await this.killWorker(ticketId);
    await this.spawnWorker(ticketId, 'default');
  }

  async killWorker(ticketId: string): Promise<void> {
    const containers = await this.docker.listContainers({
      filters: { label: [`ticket-id=${ticketId}`] }
    });

    for (const c of containers) {
      console.log(`[Docker] Killing container ${c.id} for ticket ${ticketId}`);
      await this.docker.getContainer(c.id).kill();
    }
  }

  async killZombies(): Promise<void> {
    const timeout = (parseInt(process.env.WORKER_TIMEOUT_MINUTES || '15')) * 60 * 1000;
    const containers = await this.docker.listContainers({
      filters: { label: ['turing-worker=true'] }
    });

    let killed = 0;
    for (const c of containers) {
      const age = Date.now() - new Date(c.created).getTime();
      if (age > timeout) {
        console.warn(`[Docker] Killing zombie container ${c.id} (age: ${Math.round(age / 60000)}min)`);
        await this.docker.getContainer(c.id).kill();
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`[Docker] Killed ${killed} zombie container(s)`);
    }
  }
}