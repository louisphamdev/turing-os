/**
 * Revolt Integration Module
 * Handles sending alerts to Revolt when workers are blocked
 * and processing /unblock commands from users
 */

import dotenv from 'dotenv';
dotenv.config();

const REVOLT_API_URL = process.env.REVOLT_API_URL || 'http://revolt:8080';
const REVOLT_BOT_TOKEN = process.env.REVOLT_BOT_TOKEN || '';
const REVOLT_ADMIN_USER_ID = process.env.REVOLT_ADMIN_USER_ID || '';

interface RevoltMessage {
  content: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
  }>;
}

export class RevoltService {
  private baseUrl: string;
  private botToken: string;

  constructor() {
    this.baseUrl = REVOLT_API_URL;
    this.botToken = REVOLT_BOT_TOKEN;
  }

  private async _makeRequest(
    method: string,
    endpoint: string,
    data: any = null
  ): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.botToken) {
      headers['x-bot-token'] = this.botToken;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: data ? JSON.stringify(data) : undefined
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`[Revolt] API error ${response.status}: ${error}`);
        return { error: `HTTP ${response.status}`, details: error };
      }

      return response.json();
    } catch (error) {
      console.error(`[Revolt] Request failed: ${error}`);
      return { error: String(error) };
    }
  }

  /**
   * Send a direct message to a user
   */
  async sendDM(userId: string, message: string): Promise<boolean> {
    console.log(`[Revolt] Sending DM to user ${userId}: ${message.substring(0, 50)}...`);

    try {
      // First, get or create a DM channel with the user
      const channelResult = await this._makeRequest(
        'POST',
        '/api/channels',
        {
          type: 1, // DM channel type
          recipients: [userId]
        }
      );

      if (channelResult.error) {
        console.error(`[Revolt] Failed to create DM channel: ${channelResult.error}`);
        return false;
      }

      const channelId = channelResult._id || channelResult.id;

      // Send the message
      const messageResult = await this._makeRequest(
        'POST',
        `/api/channels/${channelId}/messages`,
        {
          content: message,
          embeds: [
            {
              title: '🚨 Turing AI Worker Blocked',
              description: message,
              color: 0xff6600 // Orange warning
            }
          ]
        }
      );

      if (messageResult.error) {
        console.error(`[Revolt] Failed to send message: ${messageResult.error}`);
        return false;
      }

      console.log(`[Revolt] Successfully sent DM to user ${userId}`);
      return true;
    } catch (error) {
      console.error(`[Revolt] Send DM failed: ${error}`);
      return false;
    }
  }

  /**
   * Send an alert to the admin about a blocked worker
   */
  async notifyBlocked(ticketId: string, reason: string, workerId: string): Promise<void> {
    const adminId = REVOLT_ADMIN_USER_ID;

    if (!adminId) {
      console.warn(`[Revolt] REVOLT_ADMIN_USER_ID not configured - cannot notify about blocked worker`);
      return;
    }

    const message = `
**🚨 Worker Blocked Alert**

A Turing AI worker has been blocked and needs human intervention.

**Ticket ID:** \`${ticketId}\`
**Worker ID:** \`${workerId}\`
**Reason:** ${reason}

**Action Required:**
Please review the blocked task and unblock it using:
\`/unblock ${ticketId}\`

Or visit Plane to manually handle this ticket.
    `.trim();

    await this.sendDM(adminId, message);
  }

  /**
   * Send a notification about task completion
   */
  async notifyCompleted(ticketId: string, summary: string): Promise<void> {
    const adminId = REVOLT_ADMIN_USER_ID;

    if (!adminId) {
      return;
    }

    const message = `
**✅ Task Completed**

**Ticket ID:** \`${ticketId}\`
**Summary:** ${summary}
    `.trim();

    await this.sendDM(adminId, message);
  }

  /**
   * Parse incoming Revolt webhook/command
   */
  parseCommand(payload: any): { command: string; args: string[] } | null {
    // Revoltslash commands come in this format
    if (payload.interaction?.type === 2) {
      // Slash command
      const commandName = payload.interaction.name;
      const options = payload.interaction.options || [];

      const args: string[] = [];
      for (const opt of options) {
        if (opt.type === 3) {
          // String option
          args.push(opt.value);
        }
      }

      return { command: `/${commandName}`, args };
    }

    // Fallback: check content for command-like strings
    const content = payload.content || '';
    if (content.startsWith('/')) {
      const parts = content.slice(1).split(/\s+/);
      return { command: `/${parts[0]}`, args: parts.slice(1) };
    }

    return null;
  }
}

// Singleton instance
export const revoltService = new RevoltService();
