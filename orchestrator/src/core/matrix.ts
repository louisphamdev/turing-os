/**
 * Matrix Integration Module — Bidirectional Communication Hub
 *
 * The orchestrator acts as the central relay between Admin (via Element)
 * and Workers (via per-worker Matrix rooms).
 *
 * Flow:
 *   Admin (Element) → Matrix Room → Orchestrator (sync listener) → Worker
 *   Worker → Orchestrator (HTTP) → Matrix Room → Admin (Element)
 *
 * Features:
 *   - Active /sync long-poll listener for real-time message reception
 *   - Room → Worker mapping for message routing
 *   - Worker inbox queue for pending admin messages
 *   - Admin command parsing (/unblock, /status, /kill)
 *   - Notification helpers (blocked, completed, killed)
 *   - Structured command injection for natural language parsing
 */

import { config } from '../config';
import { WorkerCommand } from './intent-parser';

interface MatrixRoom {
  room_id?: string;
  error?: string;
}

interface InboxMessage {
  sender: string;
  content: string;
  timestamp: number;
  eventId: string;
  isStructuredCommand?: boolean;
  commandType?: string;
  commandArgs?: Record<string, any>;
}

interface PendingQuestion {
  ticketId: string;
  question: string;
  askedAt: number;
  timeoutSeconds: number;
  roomId: string | null;
}

// Callback type for command handling
type CommandHandler = (command: string, args: string[], roomId: string, sender: string) => Promise<void>;
// Callback type for plain message handling (admin → worker)
type MessageHandler = (roomId: string, sender: string, content: string) => Promise<void>;

export class MatrixService {
  private baseUrl: string;
  private botToken: string;
  private adminUserId: string;
  private dmRoomCache: Map<string, string> = new Map();

  // === Bidirectional Communication State ===
  // Room ID → ticketId mapping (which worker owns which room)
  private roomToWorker: Map<string, string> = new Map();
  // ticketId → Room ID (reverse mapping)
  private workerToRoom: Map<string, string> = new Map();
  // ticketId → pending messages from admin (worker inbox)
  private workerInbox: Map<string, InboxMessage[]> = new Map();
  // ticketId → active admin question currently waiting for reply
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  // Sync state for /sync long-poll
  private syncToken: string | null = null;
  private syncRunning: boolean = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  // Bot's own user ID (to filter out own messages)
  private botUserId: string | null = null;
  // External handlers
  private commandHandler: CommandHandler | null = null;
  private messageHandler: MessageHandler | null = null;

  constructor() {
    this.baseUrl = config.matrix.apiUrl;
    this.botToken = config.matrix.botToken;
    this.adminUserId = config.matrix.adminUserId;
  }

  // ─── Core HTTP ─────────────────────────────────────────────────────────

  private async _makeRequest(
    method: string,
    endpoint: string,
    data: any = null,
    retries: number = 2,
    timeoutMs: number = 30000
  ): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.botToken) {
      headers['Authorization'] = `Bearer ${this.botToken}`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          method,
          headers,
          body: data ? JSON.stringify(data) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          const error = await response.text();
          console.error(`[Matrix] API error ${response.status}: ${error}`);
          if (attempt < retries && response.status >= 500) {
            console.log(`[Matrix] Retrying (${attempt + 1}/${retries})...`);
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          return { error: `HTTP ${response.status}`, details: error };
        }

        const text = await response.text();
        return text ? JSON.parse(text) : { success: true };
      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.warn(`[Matrix] Request timed out: ${method} ${endpoint}`);
        } else {
          console.error(`[Matrix] Request failed: ${error}`);
        }
        if (attempt < retries) {
          console.log(`[Matrix] Retrying (${attempt + 1}/${retries})...`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return { error: String(error) };
      }
    }
  }

  // ─── Bot Identity ──────────────────────────────────────────────────────

  private async _resolveBotUserId(): Promise<string | null> {
    if (this.botUserId) return this.botUserId;

    const result = await this._makeRequest('GET', '/_matrix/client/r0/account/whoami');
    if (result?.user_id) {
      this.botUserId = result.user_id;
      console.log(`[Matrix] Bot user ID: ${this.botUserId}`);
    }
    return this.botUserId;
  }

  // ─── DM Room Management ────────────────────────────────────────────────

  private async _getDMRoom(userId: string): Promise<string | null> {
    const cached = this.dmRoomCache.get(userId);
    if (cached) return cached;

    const roomResult: MatrixRoom = await this._makeRequest('POST', '/_matrix/client/r0/createRoom', {
      preset: 'trusted_private_chat',
      is_direct: true,
      invite: [userId],
    });

    if (roomResult.error) {
      console.error(`[Matrix] Failed to create DM room: ${(roomResult as any).error}`);
      return null;
    }

    const roomId = roomResult.room_id;
    if (roomId) {
      this.dmRoomCache.set(userId, roomId);
    }
    return roomId || null;
  }

  // ─── Send Messages ─────────────────────────────────────────────────────

  async sendDM(userId: string, message: string): Promise<boolean> {
    if (!this.botToken) {
      console.warn(`[Matrix] Bot token not configured — cannot send DM`);
      return false;
    }

    console.log(`[Matrix] Sending DM to user ${userId}: ${message.substring(0, 80)}...`);

    const roomId = await this._getDMRoom(userId);
    if (!roomId) return false;

    return this._sendToRoom(roomId, message);
  }

  async sendToRoom(roomId: string, message: string): Promise<boolean> {
    return this._sendToRoom(roomId, message);
  }

  private async _sendToRoom(roomId: string, message: string): Promise<boolean> {
    const messageResult = await this._makeRequest(
      'PUT',
      `/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${Date.now()}`,
      {
        msgtype: 'm.text',
        body: message,
      }
    );

    if (messageResult.error) {
      console.error(`[Matrix] Failed to send message: ${messageResult.error}`);
      return false;
    }

    return true;
  }

  // ─── Worker Room Management ─────────────────────────────────────────────

  /**
   * Create a Matrix room for a worker and invite the admin.
   * Automatically registers the room→worker mapping.
   */
  async createWorkerRoom(workerRole: string, ticketId?: string): Promise<string | null> {
    const userId = this.adminUserId;

    const result: MatrixRoom = await this._makeRequest('POST', '/_matrix/client/r0/createRoom', {
      name: `Turing - ${workerRole.toUpperCase()}`,
      topic: `Worker agent: ${workerRole} | Ticket: ${ticketId || 'init'}`,
      preset: 'private_chat',
      is_direct: false,
      invite: userId ? [userId] : [],
    });

    if (result.error) {
      console.error(`[Matrix] Failed to create room for ${workerRole}:`, result.error);
      return null;
    }

    const roomId = result.room_id;
    if (roomId && ticketId) {
      this.registerWorkerRoom(ticketId, roomId);
    }

    console.log(`[Matrix] Created worker room for ${workerRole}: ${roomId}`);
    return roomId || null;
  }

  /**
   * Register a room→worker mapping for message routing
   */
  registerWorkerRoom(ticketId: string, roomId: string): void {
    this.roomToWorker.set(roomId, ticketId);
    this.workerToRoom.set(ticketId, roomId);

    const pendingQuestion = this.pendingQuestions.get(ticketId);
    if (pendingQuestion) {
      pendingQuestion.roomId = roomId;
    }

    console.log(`[Matrix] Registered room mapping: ${roomId} ↔ ${ticketId}`);
  }

  /**
   * Get the room ID for a worker
   */
  getWorkerRoomId(ticketId: string): string | null {
    return this.workerToRoom.get(ticketId) || null;
  }

  /**
   * Get the ticket ID for a room
   */
  getWorkerByRoom(roomId: string): string | null {
    return this.roomToWorker.get(roomId) || null;
  }

  /**
   * Send a message to a specific worker's Matrix room
   */
  async sendToWorkerRoom(ticketId: string, message: string): Promise<boolean> {
    const roomId = this.workerToRoom.get(ticketId);
    if (!roomId) {
      console.warn(`[Matrix] No room found for worker ${ticketId}`);
      return false;
    }
    return this._sendToRoom(roomId, message);
  }

  /**
   * Unregister a worker's room (when worker is terminated)
   */
  unregisterWorkerRoom(ticketId: string): void {
    const roomId = this.workerToRoom.get(ticketId);
    if (roomId) {
      this.roomToWorker.delete(roomId);
    }
    this.workerToRoom.delete(ticketId);
    this.workerInbox.delete(ticketId);
    this.pendingQuestions.delete(ticketId);
  }

  registerPendingQuestion(ticketId: string, question: string, timeoutSeconds: number = 300): void {
    const normalizedTimeoutSeconds = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.floor(timeoutSeconds)
      : 300;

    this.pendingQuestions.set(ticketId, {
      ticketId,
      question,
      askedAt: Date.now(),
      timeoutSeconds: normalizedTimeoutSeconds,
      roomId: this.workerToRoom.get(ticketId) || null,
    });

    console.log(`[Matrix] Pending question registered for ${ticketId} (${normalizedTimeoutSeconds}s)`);
  }

  clearPendingQuestion(ticketId: string): void {
    if (this.pendingQuestions.delete(ticketId)) {
      console.log(`[Matrix] Pending question cleared for ${ticketId}`);
    }
  }

  getPendingQuestions(): Array<PendingQuestion & {
    ageMs: number;
    remainingMs: number;
    overdue: boolean;
  }> {
    const now = Date.now();

    return Array.from(this.pendingQuestions.values()).map((question) => {
      const ageMs = now - question.askedAt;
      const remainingMs = (question.timeoutSeconds * 1000) - ageMs;

      return {
        ...question,
        ageMs,
        remainingMs,
        overdue: remainingMs < 0,
      };
    });
  }

  // ─── Worker Inbox (Admin → Worker message queue) ────────────────────────

  /**
   * Push a message into a worker's inbox
   */
  pushToWorkerInbox(ticketId: string, sender: string, content: string, eventId: string = ''): void {
    if (!this.workerInbox.has(ticketId)) {
      this.workerInbox.set(ticketId, []);
    }
    this.workerInbox.get(ticketId)!.push({
      sender,
      content,
      timestamp: Date.now(),
      eventId: eventId || `evt_${Date.now()}`,
    });
    this.clearPendingQuestion(ticketId);
    console.log(`[Matrix] Inbox: queued message for worker ${ticketId} from ${sender}`);
  }

  /**
   * Push a structured command into a worker's inbox (for natural language parsed commands)
   */
  pushStructuredCommand(ticketId: string, sender: string, command: WorkerCommand): void {
    if (!this.workerInbox.has(ticketId)) {
      this.workerInbox.set(ticketId, []);
    }

    const commandMessage = {
      sender,
      content: `[COMMAND] ${JSON.stringify(command)}`,
      timestamp: Date.now(),
      eventId: `cmd_${Date.now()}`,
      isStructuredCommand: true,
      commandType: command.type,
      commandArgs: command.args,
    };

    this.workerInbox.get(ticketId)!.push(commandMessage);
    this.clearPendingQuestion(ticketId);
    console.log(`[Matrix] Inbox: queued COMMAND ${command.type} for worker ${ticketId}`);
  }

  /**
   * Drain all pending messages from a worker's inbox
   */
  drainWorkerInbox(ticketId: string, sinceTimestamp?: number): InboxMessage[] {
    const messages = this.workerInbox.get(ticketId) || [];

    if (sinceTimestamp === undefined) {
      this.workerInbox.set(ticketId, []);
      return messages;
    }

    const matching = messages.filter((message) => message.timestamp >= sinceTimestamp);
    const remaining = messages.filter((message) => message.timestamp < sinceTimestamp);
    this.workerInbox.set(ticketId, remaining);
    return matching;
  }

  /**
   * Peek at inbox without draining
   */
  peekWorkerInbox(ticketId: string, sinceTimestamp?: number): InboxMessage[] {
    const messages = this.workerInbox.get(ticketId) || [];

    if (sinceTimestamp === undefined) {
      return messages;
    }

    return messages.filter((message) => message.timestamp >= sinceTimestamp);
  }

  // ─── Matrix Sync Listener ──────────────────────────────────────────────

  /**
   * Set the command handler (called when admin sends /command)
   */
  setCommandHandler(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /**
   * Set the message handler (called when admin sends a plain message in a worker room)
   */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Start listening for Matrix events via /sync polling
   */
  async startListening(): Promise<void> {
    if (!this.botToken) {
      console.warn('[Matrix] Bot token not configured — sync listener disabled');
      return;
    }

    // Resolve bot identity first
    await this._resolveBotUserId();

    this.syncRunning = true;
    console.log('[Matrix] ✓ Starting sync listener...');

    // Do initial sync to get the sync token (don't process old messages)
    await this._doInitialSync();

    // Start the polling loop
    this._pollLoop();
  }

  /**
   * Stop the sync listener
   */
  stopListening(): void {
    this.syncRunning = false;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    console.log('[Matrix] Sync listener stopped');
  }

  /**
   * Initial sync to obtain the sync token without processing old messages
   */
  private async _doInitialSync(): Promise<void> {
    const filter = JSON.stringify({ room: { timeline: { limit: 0 } } });
    const result = await this._makeRequest(
      'GET',
      `/_matrix/client/r0/sync?filter=${encodeURIComponent(filter)}&timeout=0`,
      null,
      1,
      15000
    );

    if (result?.next_batch) {
      this.syncToken = result.next_batch;
      console.log(`[Matrix] Initial sync complete, token: ${this.syncToken?.substring(0, 20)}...`);
    } else {
      console.warn('[Matrix] Initial sync failed, will retry on next poll');
    }
  }

  /**
   * Main polling loop — calls /sync with the current token
   */
  private async _pollLoop(): Promise<void> {
    while (this.syncRunning) {
      try {
        const params = new URLSearchParams({
          timeout: '10000', // 10s long-poll
          filter: JSON.stringify({
            room: {
              timeline: { limit: 10 },
              state: { limit: 0 },
              ephemeral: { limit: 0 },
            },
            presence: { limit: 0 },
            account_data: { limit: 0 },
          }),
        });

        if (this.syncToken) {
          params.set('since', this.syncToken);
        }

        const result = await this._makeRequest(
          'GET',
          `/_matrix/client/r0/sync?${params.toString()}`,
          null,
          0, // no retries in the loop itself
          30000 // 30s timeout (> 10s long-poll)
        );

        if (!this.syncRunning) break;

        if (result?.error) {
          console.warn(`[Matrix] Sync error: ${result.error}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        if (result?.next_batch) {
          this.syncToken = result.next_batch;
        }

        // Process room events
        if (result?.rooms?.join) {
          for (const [roomId, roomData] of Object.entries(result.rooms.join as Record<string, any>)) {
            const events = roomData?.timeline?.events || [];
            for (const event of events) {
              await this._handleRoomEvent(roomId, event);
            }
          }
        }

        // Also process invites — auto-join rooms we're invited to
        if (result?.rooms?.invite) {
          for (const roomId of Object.keys(result.rooms.invite as Record<string, any>)) {
            console.log(`[Matrix] Auto-joining invited room: ${roomId}`);
            await this._makeRequest('POST', `/_matrix/client/r0/join/${encodeURIComponent(roomId)}`, {});
          }
        }
      } catch (err) {
        console.error(`[Matrix] Sync loop error:`, err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Handle a single room event from /sync
   */
  private async _handleRoomEvent(roomId: string, event: any): Promise<void> {
    // Only process m.room.message events
    if (event.type !== 'm.room.message') return;

    const sender = event.sender || '';
    const content = event.content?.body || '';
    const eventId = event.event_id || '';

    // Ignore our own messages
    if (sender === this.botUserId) return;

    // Ignore empty messages
    if (!content || !content.trim()) return;

    console.log(`[Matrix] Room ${roomId} | ${sender}: ${content.substring(0, 100)}`);

    // Check if this is a command (starts with /)
    if (content.trim().startsWith('/')) {
      const parts = content.trim().split(/\s+/);
      const command = parts[0];
      const args = parts.slice(1);

      console.log(`[Matrix] Command detected: ${command} ${args.join(' ')}`);

      if (this.commandHandler) {
        await this.commandHandler(command, args, roomId, sender);
      }
      return;
    }

    // Check if this is the bot room → LLM-powered conversation
    if (this.isBotRoom(roomId)) {
      // Commands still go to commandHandler; non-commands go to messageHandler
      if (this.messageHandler) {
        await this.messageHandler(roomId, sender, content);
      }
      return;
    }

    // Check if this message is in a worker's room
    const ticketId = this.roomToWorker.get(roomId);
    if (ticketId) {
      // Admin sent a message to a worker's room — queue it for the worker
      this.pushToWorkerInbox(ticketId, sender, content, eventId);

      if (this.messageHandler) {
        await this.messageHandler(roomId, sender, content);
      }
      return;
    }

    // Message in an unknown room — just log it
    console.log(`[Matrix] Unrouted message in room ${roomId} from ${sender}`);
  }

  // ─── Notification Helpers ──────────────────────────────────────────────

  /**
   * Send alert about a blocked worker
   */
  async notifyBlocked(ticketId: string, reason: string, workerId: string): Promise<void> {
    const message = [
      `🚨 **Worker Blocked Alert**`,
      '',
      'A Turing AI worker has been blocked and needs human intervention.',
      '',
      `**Ticket ID:** \`${ticketId}\``,
      `**Worker ID:** \`${workerId}\``,
      `**Reason:** ${reason}`,
      '',
      '**Action Required:**',
      `Please unblock using: \`/unblock ${ticketId}\``,
    ].join('\n');

    // Send to worker's room if exists
    const roomId = this.workerToRoom.get(ticketId);
    if (roomId) {
      await this._sendToRoom(roomId, message);
    }

    // Also send DM to admin
    if (this.adminUserId) {
      await this.sendDM(this.adminUserId, message);
    }
  }

  /**
   * Send notification about task completion
   */
  async notifyCompleted(ticketId: string, summary: string): Promise<void> {
    const message = [
      `✅ **Task Completed**`,
      '',
      `**Ticket ID:** \`${ticketId}\``,
      `**Summary:** ${summary}`,
    ].join('\n');

    // Send to worker's room
    const roomId = this.workerToRoom.get(ticketId);
    if (roomId) {
      await this._sendToRoom(roomId, message);
    }

    // Also send DM to admin
    if (this.adminUserId) {
      await this.sendDM(this.adminUserId, message);
    }
  }

  /**
   * Send alert about a stuck/killed worker
   */
  async notifyWorkerKilled(ticketId: string, reason: string): Promise<void> {
    const message = [
      `💀 **Worker Killed**`,
      '',
      `**Ticket ID:** \`${ticketId}\``,
      `**Reason:** ${reason}`,
      '',
      'Worker will be respawned automatically if the task is recoverable.',
    ].join('\n');

    const roomId = this.workerToRoom.get(ticketId);
    if (roomId) {
      await this._sendToRoom(roomId, message);
    }

    if (this.adminUserId) {
      await this.sendDM(this.adminUserId, message);
    }
  }

  // ─── Command Parsing ───────────────────────────────────────────────────

  /**
   * Parse incoming Matrix command from webhook (legacy support)
   */
  parseCommand(payload: any): { command: string; args: string[] } | null {
    const content = payload.content?.body || payload.content?.text || payload.content || '';

    if (typeof content !== 'string' && content.startsWith && content.startsWith('/')) {
      const parts = content.trim().split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    }

    if (typeof content === 'string' && content.startsWith('/')) {
      const parts = content.trim().split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    }

    return null;
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  /**
   * Get the current state of room mappings and inboxes
   */
  getRoutingStatus(): {
    rooms: { ticketId: string; roomId: string }[];
    inboxes: { ticketId: string; pending: number }[];
    pendingQuestions: Array<PendingQuestion & {
      ageMs: number;
      remainingMs: number;
      overdue: boolean;
    }>;
    syncActive: boolean;
  } {
    return {
      rooms: Array.from(this.workerToRoom.entries()).map(([ticketId, roomId]) => ({ ticketId, roomId })),
      inboxes: Array.from(this.workerInbox.entries()).map(([ticketId, messages]) => ({ ticketId, pending: messages.length })),
      pendingQuestions: this.getPendingQuestions(),
      syncActive: this.syncRunning,
    };
  }

  // ─── Bot Room (Orchestrator Agent chat) ─────────────────────────────────

  /**
   * Register the bot's own room for LLM-powered conversations.
   * Messages in this room go to the OrchestratorAgent instead of worker routing.
   */
  registerBotRoom(roomId: string): void {
    this._botRoomId = roomId;
    console.log(`[Matrix] Registered bot room: ${roomId}`);
  }

  /**
   * Check if a room is the bot room
   */
  isBotRoom(roomId: string): boolean {
    return this._botRoomId === roomId;
  }

  private _botRoomId: string | null = null;
}

// Singleton instance
export const matrixService = new MatrixService();
