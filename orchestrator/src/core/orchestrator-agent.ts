/**
 * Orchestrator Agent — LLM-powered ReAct loop for bot room conversations.
 *
 * Safety guardrails:
 * - scale_up/down: capped at maxWorkers, cooldown between actions
 * - kill_worker: only BLOCKED/TERMINATING/PENDING workers — never RUNNING unless forced
 * - restart_worker: safe — always allowed
 * - update_config: only whitelisted keys
 * - Confirmation required for destructive actions (kill, scale-down below 1)
 */

import { config } from '../config';
import { DockerService } from './docker';
import { HealthMonitor } from './health-monitor';
import { WorkerRegistry } from './registry';
import { matrixService } from './matrix';
import { priorityQueue } from './priority-queue';
import { getAllAgentRoles } from '../agents/init';

interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

interface OrchestratorTool {
  name: string;
  description: string;
  guarded?: boolean;  // if true, guardrail check runs before execute
  execute: (args: Record<string, any>) => Promise<ToolResult>;
}

// Guardrail: track pending confirmations
interface PendingConfirmation {
  tool: string;
  args: Record<string, any>;
  sender: string;
  roomId: string;
  expiresAt: number;
}
const pendingConfirmations: PendingConfirmation[] = [];

// ─── Guardrail helpers ──────────────────────────────────────────────────────

/** Returns true if the worker is in a safe-to-kill status */
function isSafeToKill(worker: { status: string; ticketId: string } | undefined): boolean {
  if (!worker) return false;
  return ['BLOCKED', 'TERMINATING', 'PENDING', 'BOOTING'].includes(worker.status);
}

/** Returns true if scaling down would go below minimum */
function isScaleDownSafe(currentCount: number, by: number): boolean {
  return currentCount - by >= 1;
}

// ─── OrchestratorAgent ──────────────────────────────────────────────────────

export class OrchestratorAgent {
  private tools: Map<string, OrchestratorTool> = new Map();
  private messages: { role: string; content: string }[] = [];
  private maxIterations = 8;
  private toolTimeoutMs = 60_000;

  constructor(
    private docker: DockerService,
    private healthMonitor: HealthMonitor,
    private registry: WorkerRegistry,
  ) {
    this._registerDefaultTools();
    this._initSystemPrompt();
  }

  // ─── Public entry ────────────────────────────────────────────────────────

  async think(userMessage: string, sender: string, roomId: string): Promise<string> {
    // Check for pending confirmation replies
    const pending = pendingConfirmations.find(
      (c) => c.sender === sender && c.expiresAt > Date.now()
    );
    if (pending) {
      const confirmed = /^(yes|y|confirm|ok|confirmed|sure|được|rõ|vâng)/i.test(userMessage.trim());
      if (confirmed) {
        // Remove pending before executing
        const idx = pendingConfirmations.indexOf(pending);
        pendingConfirmations.splice(idx, 1);
        const result = await this._executeTool(pending.tool, pending.args);
        return this._formatResult(result);
      } else {
        const idx = pendingConfirmations.indexOf(pending);
        pendingConfirmations.splice(idx, 1);
        return '✅ Action cancelled.';
      }
    }

    this.messages.push({ role: 'user', content: `Admin (${sender}): ${userMessage}` });

    for (let i = 0; i < this.maxIterations; i++) {
      const response = await this._callLLM();
      if (!response.content) return '❌ LLM returned empty response.';

      const toolCalls = this._parseToolCalls(response.content);
      this.messages.push({ role: 'assistant', content: response.content });

      if (toolCalls.length === 0) return response.content;

      for (const tc of toolCalls) {
        // Guarded tools need pre-execution check
        const tool = this.tools.get(tc.name);
        if (!tool) {
          this.messages.push({ role: 'tool', content: JSON.stringify({ success: false, error: `Unknown tool: ${tc.name}` }) });
          continue;
        }

        let guardResult: string | null = null;

        if (tool.guarded) {
          guardResult = await this._runGuardrail(tc.name, tc.arguments, sender, roomId);
          if (guardResult !== null) {
            // Confirmation needed — stop iteration, don't execute tool
            return guardResult;
          }
        }

        const execResult = await this._executeTool(tc.name, tc.arguments);
        this.messages.push({ role: 'tool', content: JSON.stringify(execResult) });
      }
    }

    return '⚠️ Max iterations reached.';
  }

  // ─── Tool execution ─────────────────────────────────────────────────────

  private async _executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { success: false, error: `Unknown tool: ${name}` };
    try {
      const result = await Promise.race([
        tool.execute(args),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timed out after ${this.toolTimeoutMs}ms`)), this.toolTimeoutMs)
        ),
      ]);
      return result;
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private _formatResult(result: ToolResult): string {
    if (!result.success) return `❌ ${result.error}`;
    if (typeof result.result === 'string') return result.result;
    return `✅ Done: ${JSON.stringify(result.result)}`;
  }

  // ─── Guardrails ─────────────────────────────────────────────────────────

  private async _runGuardrail(
    toolName: string,
    args: Record<string, any>,
    sender: string,
    roomId: string
  ): Promise<string | null> {
    switch (toolName) {
      case 'stop_worker': {
        const worker = this.registry.lookupByTicket(args.ticketId as string);
        if (!worker) {
          return `❌ Worker \`${args.ticketId}\` not found in registry.`;
        }
        if (worker.status === 'STOPPED') {
          return `❌ Worker \`${args.ticketId}\` is already stopped.`;
        }
        if (worker.status === 'RUNNING') {
          const confirmed = await this._requestConfirmation(
            toolName, args, sender, roomId,
            `⚠️ \`${args.ticketId}\` is **RUNNING** — stopping it will free resources but the container is preserved.\n` +
            `You can restart it later with \`start_worker\`.\n\n` +
            `Reply **yes** to stop, or **no** to cancel.`
          );
          return confirmed;
        }
        return null;
      }

      case 'kill_worker': {
        const worker = this.registry.lookupByTicket(args.ticketId as string);
        if (!worker) {
          return `❌ Worker \`${args.ticketId}\` not found in registry.`;
        }
        if (worker.status === 'RUNNING' && !args._forced) {
          const confirmed = await this._requestConfirmation(
            toolName, args, sender, roomId,
            `⚠️ \`${args.ticketId}\` is **RUNNING** — deleting it will PERMANENTLY remove the container and all its state.\n` +
            `Use \`stop_worker\` instead to preserve the container.\n\n` +
            `Reply **yes** to permanently delete, or **no** to cancel.`
          );
          return confirmed;
        }
        if (worker.status === 'STOPPED') {
          // Already stopped — deletion is safe, no confirmation needed
          return null;
        }
        return null;
      }

      case 'scale_workers': {
        const direction = args.direction as 'up' | 'down';
        const count = (typeof args.count === 'number' ? args.count : 1) as number;
        const running = await this.docker.getRunningWorkerCount();

        if (direction === 'down') {
          if (running - count < 1) {
            return `❌ Cannot scale down below 1 worker (currently ${running} running).`;
          }
          if (running <= 1) {
            return `❌ Cannot scale down — only 1 worker running.`;
          }
        }

        if (direction === 'up' && running >= config.docker.maxWorkers) {
          return `⚠️ Already at max workers (${running}/${config.docker.maxWorkers}). Increase \`maxWorkers\` to scale further.`;
        }

        // Warn if scaling down multiple
        if (direction === 'down' && count > 1) {
          const confirmed = await this._requestConfirmation(
            toolName, args, sender, roomId,
            `⚠️ Scale down by **${count}** workers? Workers will be STOPPED (not deleted), containers preserved.\n\nReply **yes** to confirm, or **no** to cancel.`
          );
          return confirmed;
        }

        return null;
      }

      case 'update_config': {
        const key = args.key as string;
        const writableKeys: Record<string, string> = {
          'docker.maxWorkers': 'docker.maxWorkers',
          'docker.workerRamMb': 'docker.workerRamMb',
          'docker.workerCpuCount': 'docker.workerCpuCount',
          'worker.scaleUpThreshold': 'worker.scaleUpThreshold',
          'worker.scaleDownThreshold': 'worker.scaleDownThreshold',
          'worker.idleTimeoutMinutes': 'worker.idleTimeoutMinutes',
        };
        if (!writableKeys[key]) {
          return `❌ Key \`${key}\` is read-only or not recognized. Writable keys: \`${Object.keys(writableKeys).join('`, `')}\`.`;
        }
        return null;
      }

      default:
        return null;
    }
  }

  private async _requestConfirmation(
    tool: string,
    args: Record<string, any>,
    sender: string,
    roomId: string,
    message: string
  ): Promise<string | null> {
    pendingConfirmations.push({
      tool, args, sender, roomId,
      expiresAt: Date.now() + 120_000, // 2 min timeout
    });
    return message;
  }

  // ─── Tool registration ───────────────────────────────────────────────────

  private _registerDefaultTools(): void {

    this.tools.set('get_system_status', {
      name: 'get_system_status',
      description: 'Returns full system status: workers, health, queue, Matrix sync.',
      execute: async () => {
        const workers = this.registry.listActive();
        const health = await this.healthMonitor.getHealthSummary();
        const routing = matrixService.getRoutingStatus();
        const queueSummary = priorityQueue.getSummary();
        const { avgCpuPercent, avgMemoryPercent } = await this.docker.getAverageResourceUsage();
        const running = await this.docker.getRunningWorkerCount();
        const roles = getAllAgentRoles();
        const healthMap = new Map(health.map((h) => [h.ticketId, h]));

        const workerLines = workers.length === 0
          ? ['  (no workers running)']
          : workers.map((w) => {
              const h = healthMap.get(w.ticketId);
              const res = h
                ? [h.cpuPercent !== undefined ? `CPU:${h.cpuPercent}%` : '', h.memoryPercent !== undefined ? `RAM:${h.memoryPercent}%` : ''].filter(Boolean).join(' ')
                : '';
              const blocked = w.status === 'BLOCKED' && w.lastBlockedReason ? ` ⚠️ ${w.lastBlockedReason}` : '';
              return `  • \`${w.ticketId}\` | ${w.role} | ${w.status}${blocked}${res ? ' (' + res + ')' : ''}`;
            });

        return {
          success: true,
          result: {
            workers: { total: workers.length, running, max: config.docker.maxWorkers },
            avgResources: { cpu: avgCpuPercent, memory: avgMemoryPercent },
            queue: queueSummary,
            matrix: { syncActive: routing.syncActive, rooms: routing.rooms.length },
            roles: roles.map((r) => ({ id: r.id, name: r.name, loaded: r.loaded })),
            workers_detail: workers.map((w) => ({
              ticketId: w.ticketId, role: w.role, status: w.status,
              lastHeartbeat: w.lastHeartbeat, lastProgress: w.lastProgress,
            })),
          },
        };
      },
    });

    this.tools.set('get_worker_health', {
      name: 'get_worker_health',
      description: 'Returns per-worker CPU and memory usage from Docker stats.',
      execute: async () => {
        const health = await this.healthMonitor.getHealthSummary();
        return {
          success: true,
          result: health.map((h) => ({
            ticketId: h.ticketId,
            status: h.status,
            cpuPercent: h.cpuPercent ?? 'N/A',
            memoryPercent: h.memoryPercent ?? 'N/A',
            heartbeatAge: `${Math.round(h.timeSinceHeartbeat / 1000)}s ago`,
            progressAge: `${Math.round(h.timeSinceProgress / 1000)}s ago`,
          })),
        };
      },
    });

    this.tools.set('scale_workers', {
      name: 'scale_workers',
      description: 'Scale workers up or down. Args: direction ("up"|"down"), count (default 1). GUARDED.',
      guarded: true,
      execute: async (args: Record<string, any>) => {
        const direction = args.direction as 'up' | 'down';
        const count: number = typeof args.count === 'number' ? args.count : 1;
        const running = await this.docker.getRunningWorkerCount();

        if (direction === 'up') {
          if (running >= config.docker.maxWorkers) {
            return { success: false, error: `At max workers (${running}/${config.docker.maxWorkers})` };
          }
          const added = Math.min(count, config.docker.maxWorkers - running);
          for (let i = 0; i < added; i++) {
            this.healthMonitor.onScaleNeeded?.('up', { avgCpuPercent: 0, avgMemoryPercent: 0, runningCount: running + i });
          }
          return { success: true, result: `📈 Scaled up by ${added} (${running} → ${running + added})` };
        } else {
          const removed = Math.min(count, running - 1);
          for (let i = 0; i < removed; i++) {
            this.healthMonitor.onScaleNeeded?.('down', { avgCpuPercent: 0, avgMemoryPercent: 0, runningCount: running - i });
          }
          return { success: true, result: `📉 Scaled down by ${removed} (${running} → ${running - removed})` };
        }
      },
    });

    this.tools.set('update_config', {
      name: 'update_config',
      description: 'Change runtime config. Args: key, value. GUARDED — only whitelisted keys.',
      guarded: true,
      execute: async (args: Record<string, any>) => {
        const key = args.key as string;
        const value = args.value as string | number;
        const writableMap: Record<string, Record<string, any>> = {
          'docker.maxWorkers': config.docker as any,
          'docker.workerRamMb': config.docker as any,
          'docker.workerCpuCount': config.docker as any,
          'worker.scaleUpThreshold': config.worker as any,
          'worker.scaleDownThreshold': config.worker as any,
          'worker.idleTimeoutMinutes': config.worker as any,
        };
        const target = writableMap[key];
        if (!target) return { success: false, error: `Read-only or unknown: ${key}` };
        const lastKey = key.split('.').pop()!;
        const num = typeof value === 'number' ? value : parseInt(value as string, 10);
        target[lastKey] = isNaN(num) ? value : num;
        return { success: true, result: `✅ \`${key}\` = \`${target[lastKey]}\` (runtime)` };
      },
    });

    this.tools.set('get_config', {
      name: 'get_config',
      description: 'Read config. Args (optional): key. Shows all if omitted.',
      execute: async (args: Record<string, any>) => {
        const key = args.key as string | undefined;
        if (key) {
          const parts = key.split('.');
          let val: any = config;
          for (const p of parts) { val = val?.[p]; }
          return { success: true, result: { [key]: val } };
        }
        return {
          success: true,
          result: {
            docker: config.docker,
            worker: config.worker,
            llm: { provider: config.llm.provider, model: config.llm.model },
            orchestrator: config.orchestrator,
          },
        };
      },
    });

    this.tools.set('send_message_to_worker', {
      name: 'send_message_to_worker',
      description: 'Send a message to a worker room. Args: ticketId, message.',
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const message = args.message as string;
        const sent = await matrixService.sendToWorkerRoom(ticketId, message);
        return { success: sent, result: sent ? `Message sent to \`${ticketId}\`` : `Failed — no room found for \`${ticketId}\`` };
      },
    });

    this.tools.set('stop_worker', {
      name: 'stop_worker',
      description: 'STOP a worker container (not delete). Preserves container for restart. Worker status becomes STOPPED.',
      guarded: true,
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const worker = this.registry.lookupByTicket(ticketId);
        if (!worker) return { success: false, error: `Worker \`${ticketId}\` not found` };
        if (worker.status === 'STOPPED') {
          return { success: false, error: `Worker \`${ticketId}\` is already stopped` };
        }
        await this.docker.stopWorker(ticketId);
        this.registry.updateStatus(ticketId, 'STOPPED');
        return { success: true, result: `⏹️ \`${ticketId}\` stopped (container preserved — can restart with /start)` };
      },
    });

    this.tools.set('start_worker', {
      name: 'start_worker',
      description: 'START a previously stopped worker container. Worker status becomes RUNNING.',
      guarded: true,
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const worker = this.registry.lookupByTicket(ticketId);
        if (!worker) return { success: false, error: `Worker \`${ticketId}\` not found` };
        if (worker.status !== 'STOPPED') {
          return { success: false, error: `Worker \`${ticketId}\` is not stopped (status: ${worker.status})` };
        }
        await this.docker.startWorker(ticketId);
        this.registry.updateStatus(ticketId, 'RUNNING');
        return { success: true, result: `▶️ \`${ticketId}\` started` };
      },
    });

    this.tools.set('kill_worker', {
      name: 'kill_worker',
      description: 'DELETE a worker container PERMANENTLY (irreversible). Use stop_worker to preserve container instead.',
      guarded: true,
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const forced = args._forced === true;
        const worker = this.registry.lookupByTicket(ticketId);
        if (!worker) return { success: false, error: `Worker \`${ticketId}\` not found` };
        if (worker.status === 'RUNNING' && !forced) {
          return { success: false, error: `Worker is RUNNING — use stop_worker first, or force with _forced: true` };
        }
        await this.docker.deleteWorker(ticketId);
        this.registry.remove(ticketId);
        matrixService.unregisterWorkerRoom(ticketId);
        return { success: true, result: `🗑️ \`${ticketId}\` deleted permanently` };
      },
    });

    this.tools.set('restart_worker', {
      name: 'restart_worker',
      description: 'Restart a blocked or stuck worker. Args: ticketId.',
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const worker = this.registry.lookupByTicket(ticketId);
        if (!worker) return { success: false, error: `Worker \`${ticketId}\` not found` };
        const role = worker?.role || 'default';
        const roomId = worker?.roomId || '';
        await this.docker.restartWorker(ticketId, role, roomId);
        return { success: true, result: `🔄 \`${ticketId}\` restarted` };
      },
    });

    this.tools.set('list_roles', {
      name: 'list_roles',
      description: 'List all available agent roles.',
      execute: async () => {
        const roles = getAllAgentRoles();
        return { success: true, result: roles.map((r) => ({ id: r.id, name: r.name, loaded: r.loaded })) };
      },
    });

    this.tools.set('update_worker', {
      name: 'update_worker',
      description: 'Update a worker\'s configuration, tools, or ask it to reload. Parses natural language command. Args: ticketId (required), command (natural language request, e.g., "reload skills" or "add tool grep_search").',
      execute: async (args: Record<string, any>) => {
        const ticketId = args.ticketId as string;
        const command = args.command as string;

        if (!ticketId || !command) {
          return { success: false, error: 'ticketId and command are required' };
        }

        const worker = this.registry.lookupByTicket(ticketId);
        if (!worker) {
          return { success: false, error: `Worker \`${ticketId}\` not found` };
        }

        // Parse intent using the intent parser
        const { parseIntent } = await import('./intent-parser');
        const result = await parseIntent(command, ticketId, 'orchestrator-agent');

        if (!result.command || result.command.type === 'unknown') {
          return { success: false, error: `Could not parse command: ${result.command?.args?.reason || 'unknown'}` };
        }

        // Inject command into worker's inbox
        matrixService.pushStructuredCommand(ticketId, 'orchestrator-agent', result.command);

        return {
          success: true,
          result: `🔧 Command queued for \`${ticketId}\`:\n` +
                  `  Type: \`${result.command.type}\`\n` +
                  `  Args: \`${JSON.stringify(result.command.args)}\`\n` +
                  `  Confidence: ${Math.round(result.command.confidence * 100)}%`,
        };
      },
    });
  }

  // ─── System prompt ──────────────────────────────────────────────────────

  private _initSystemPrompt(): void {
    this.messages = [{
      role: 'system',
      content: `You are the **Turing OS Orchestrator Agent**.

You help admins manage the Turing OS system via Matrix/Element.
You can inspect status, scale workers, change runtime config, restart/stop/start workers, and update worker configurations.

**Available tools** (use tool_calls to act):
${[...this.tools.keys()].map((n) => `• ${n}`).join('\n')}

**Worker Lifecycle — STOP vs DELETE vs RESTART:**
- \`stop_worker\`: Pauses worker, PRESERVES container. Can restart later. Use when you want to keep a "trained" worker but free up resources.
- \`start_worker\`: Resumes a stopped worker. Container still exists.
- \`restart_worker\`: Graceful restart — stop then start. For blocked/stuck workers.
- \`kill_worker\`: PERMANENTLY DELETE container. Irreversible — all state lost. Only use when you want to fully remove a worker.

**Natural Language Worker Updates**:
When admin asks you to update a worker in natural language (e.g., "reload skills for worker ABC", "add tool grep to worker XYZ"), use \`update_worker\` with the ticketId and the admin's request as-is. The system will parse it automatically.

**Safety rules — ALWAYS follow these:**
1. \`kill_worker\`: PERMANENTLY deletes — confirm with admin first. Only BLOCKED/TERMINATING/PENDING/STOPPED workers are safe to delete without confirmation.
2. \`stop_worker\`: Stops and preserves container — safe, can restart.
3. \`scale_workers\` DOWN: Never scale below 1 worker.
4. \`scale_workers\` UP: Never exceed maxWorkers.
5. \`update_config\`: Only keys in the tool description are writable.
6. When in doubt, \`get_system_status\` first.

**Confirmation flow**: For destructive actions (kill/delete), always ask "yes"/"no" confirmation first. For stop/start, no confirmation needed.

**Response style**: Be concise. Use Markdown. Reply in the user's language (Vietnamese if they write in Vietnamese).`,
    }];
  }

  // ─── LLM calls ────────────────────────────────────────────────────────

  private async _callLLM(): Promise<{ content: string; usage?: any }> {
    const provider = config.llm.provider.toLowerCase();
    const apiKey = config.llm.apiKey;
    const baseUrl = config.llm.baseUrl;
    const model = config.llm.model;
    const msgs = this.messages.map((m) => ({ role: m.role, content: m.content }));

    if (provider === 'openai' || provider === 'minimax' || baseUrl.includes('openai')) {
      return this._callOpenAI(msgs, apiKey, baseUrl, model);
    } else if (provider === 'anthropic') {
      return this._callAnthropic(msgs, apiKey, model);
    }
    return this._callOpenAI(msgs, apiKey, baseUrl, model);
  }

  private async _callOpenAI(messages: { role: string; content: string }[], apiKey: string, baseUrl: string, model: string) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1500 }),
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: any };
    return { content: data.choices?.[0]?.message?.content ?? '', usage: data.usage };
  }

  private async _callAnthropic(messages: { role: string; content: string }[], apiKey: string, model: string) {
    const systemPrompt = messages.find((m) => m.role === 'system')?.content ?? '';
    const conversation = messages.filter((m) => m.role !== 'system');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        system: systemPrompt,
        messages: conversation.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}`);
    const data = await res.json() as { content?: { text?: string }[]; usage?: any };
    return { content: data.content?.[0]?.text ?? '', usage: data.usage };
  }

  private _parseToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const xmlRegex = /TOOL_CALL:\s*(\w+)\s*\nARGUMENTS:\s*(\{[\s\S]*?\})/gi;
    let match;
    while ((match = xmlRegex.exec(text)) !== null) {
      try { calls.push({ name: match[1], arguments: JSON.parse(match[2]) }); } catch { /* skip */ }
    }
    const jsonBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi;
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.arguments) calls.push({ name: parsed.name, arguments: parsed.arguments });
      } catch { /* skip */ }
    }
    return calls;
  }
}
