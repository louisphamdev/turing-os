/**
 * Alert Manager — Centralized alerting for Turing OS
 *
 * Handles all outbound alerts from the orchestrator to:
 *   - Matrix DM to admin (critical alerts)
 *   - Generic HTTP webhook (configurable, for Slack/Teams/PagerDuty)
 *
 * Features:
 *   - Alert severity levels: critical, warning, info
 *   - Rate-limiting: max 1 alert per source per 5 minutes (de-duplication)
 *   - Fire-and-forget (non-blocking) — alerting never crashes the orchestrator
 */

import { matrixService } from './matrix';
import { config } from '../config';

export type AlertLevel = 'critical' | 'warning' | 'info';

export interface Alert {
  level: AlertLevel;
  source: string;        // e.g. 'HealthMonitor', 'DockerService', 'WebhookEndpoint'
  message: string;      // Short one-line summary
  details?: string;      // Optional multi-line details
  ticketId?: string;     // Optional related ticket
  timestamp: number;
}

export class AlertManager {
  private webhookUrl: string;
  private adminUserId: string;
  private cooldownMap: Map<string, number> = new Map();
  private readonly cooldownMs: number;

  constructor() {
    this.webhookUrl = optionalEnv('ALERT_WEBHOOK_URL', '');
    this.adminUserId = config.matrix.adminUserId;
    this.cooldownMs = optionalInt('ALERT_COOLDOWN_MS', 300_000); // 5 min default
  }

  /**
   * Send an alert through appropriate channels based on severity.
   * Critical alerts → Matrix DM + webhook
   * Warning alerts  → Matrix DM (if severe) + webhook
   * Info alerts    → webhook only (if configured)
   */
  async sendAlert(alert: Alert): Promise<void> {
    const { level, source, message, details, ticketId } = alert;

    // Rate-limit check: skip if we've alerted this source recently
    if (this._isRateLimited(source)) {
      console.debug(`[AlertManager] Rate-limited: ${source}`);
      return;
    }
    this._setCooldown(source);

    // Format the alert as a human-readable message
    const formatted = this._formatAlert(alert);

    // Fire-and-forget: catch all errors so alerting never crashes the main system
    this._sendMatrixDM(formatted).catch((e) =>
      console.error('[AlertManager] Matrix DM failed:', e)
    );

    if (this.webhookUrl) {
      this._sendWebhook(alert).catch((e) =>
        console.error('[AlertManager] Webhook failed:', e)
      );
    } else {
      console.warn(`[AlertManager] No ALERT_WEBHOOK_URL configured — alert will only go to Matrix DM`);
    }

    console.warn(`[AlertManager] [${level.toUpperCase()}] [${source}] ${message}`);
  }

  // ─── Convenience Methods ───────────────────────────────────────────────

  async critical(source: string, message: string, details?: string, ticketId?: string): Promise<void> {
    return this.sendAlert({ level: 'critical', source, message, details, ticketId, timestamp: Date.now() });
  }

  async warning(source: string, message: string, details?: string, ticketId?: string): Promise<void> {
    return this.sendAlert({ level: 'warning', source, message, details, ticketId, timestamp: Date.now() });
  }

  async info(source: string, message: string, details?: string, ticketId?: string): Promise<void> {
    return this.sendAlert({ level: 'info', source, message, details, ticketId, timestamp: Date.now() });
  }

  // ─── Worker-specific Alerts ────────────────────────────────────────────

  /**
   * Alert when a worker dies (DEAD state — 3+ missed heartbeats).
   * This is WARNING level since the orchestrator will auto-respawn.
   */
  async alertWorkerDead(ticketId: string, role: string, reason: string): Promise<void> {
    return this.warning(
      'HealthMonitor',
      `Worker dead: ${ticketId} (${role})`,
      `${reason}. Orchestrator will attempt auto-respawn.`,
      ticketId
    );
  }

  /**
   * Alert when a worker is stuck (no progress for too long).
   */
  async alertWorkerStuck(ticketId: string, role: string, stuckMinutes: number): Promise<void> {
    return this.warning(
      'HealthMonitor',
      `Worker stuck: ${ticketId} (${role}) — no progress for ${stuckMinutes}min`,
      undefined,
      ticketId
    );
  }

  /**
   * Alert when a worker is flapping (died multiple times in short period).
   * This is CRITICAL — manual intervention required.
   */
  async alertWorkerFlapping(ticketId: string, role: string, respawnCount: number, withinMinutes: number): Promise<void> {
    return this.critical(
      'HealthMonitor',
      `Worker FLAPPING: ${ticketId} (${role}) — ${respawnCount} deaths in ${withinMinutes}min`,
      `Auto-respawn DISABLED for this ticket. Manual intervention required. Use /status to review.`,
      ticketId
    );
  }

  /**
   * Alert when orchestrator itself has a problem (e.g., external service down).
   */
  async alertSystemProblem(service: string, message: string, details?: string): Promise<void> {
    return this.critical(
      'HealthMonitor',
      `System issue: ${service} — ${message}`,
      details
    );
  }

  /**
   * Alert when a Docker event (OOM, container die) is detected.
   */
  async alertDockerEvent(ticketId: string, event: string, details?: string): Promise<void> {
    const isOOM = event.includes('oom');
    return isOOM
      ? this.critical('DockerService', `Container OOM: ${ticketId}`, details, ticketId)
      : this.warning('DockerService', `Container event: ${ticketId} — ${event}`, details, ticketId);
  }

  /**
   * Alert when disk space is running low on the host.
   */
  async alertDiskLow(percentUsed: number, details?: string): Promise<void> {
    return this.critical(
      'HealthMonitor',
      `Disk space low: ${percentUsed}% used`,
      details || 'Host may become unresponsive if disk fills. Consider cleaning old logs or worker workspaces.'
    );
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private _isRateLimited(source: string): boolean {
    const lastAlert = this.cooldownMap.get(source);
    if (lastAlert === undefined) return false;
    return Date.now() - lastAlert < this.cooldownMs;
  }

  private _setCooldown(source: string): void {
    this.cooldownMap.set(source, Date.now());
  }

  private _formatAlert(alert: Alert): string {
    const emoji = {
      critical: '🔴',
      warning: '🟡',
      info: 'ℹ️',
    }[alert.level];

    const lines = [
      `${emoji} **[${alert.level.toUpperCase()}]** [${alert.source}]`,
      `**${alert.message}**`,
    ];

    if (alert.details) {
      lines.push(alert.details);
    }

    if (alert.ticketId) {
      lines.push(`Ticket: \`${alert.ticketId}\``);
    }

    lines.push(`_Turing OS Alert · ${new Date(alert.timestamp).toISOString()}_`);

    return lines.join('\n');
  }

  private async _sendMatrixDM(formatted: string): Promise<void> {
    if (!this.adminUserId) {
      console.warn('[AlertManager] No admin user ID configured — skipping Matrix DM');
      return;
    }
    await matrixService.sendDM(this.adminUserId, formatted);
  }

  private async _sendWebhook(alert: Alert): Promise<void> {
    const payload = {
      alert: {
        level: alert.level,
        source: alert.source,
        message: alert.message,
        details: alert.details,
        ticketId: alert.ticketId,
        timestamp: new Date(alert.timestamp).toISOString(),
      },
      system: 'turing-os',
    };

    // Errors propagate to the .catch() in sendAlert.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[AlertManager] Webhook returned ${response.status}`);
    } else {
      console.log(`[AlertManager] Webhook sent successfully`);
    }
  }
}

// ─── Helpers matching config/index.ts style ───────────────────────────────

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

// Singleton instance
export const alertManager = new AlertManager();
