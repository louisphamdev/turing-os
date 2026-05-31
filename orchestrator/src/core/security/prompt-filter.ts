import { config } from '../../config';
import { getAuditStore } from './audit-store';

/**
 * Basic Prompt Injection Filter
 * Scans task descriptions from Plane for malicious intents before dispatching to workers.
 */

const SUSPICIOUS_PATTERNS = [
  /ignore (all )?(previous )?(instructions|directions)/i,
  /rm -rf/i,
  /systemctl (stop|disable)/i,
  /chmod (-R )?777/i,
  /chown (-R )?root/i,
  /base64( -d)?/i,
  /wget .* -O/i,
  /curl .* \| bash/i,
  /> \/dev\/(sda|hda|null)/i,
  /: \(\) \{ :\|: & \} ; :/i, // fork bomb
  /bypass/i,
  /you are now/i,
  /forget (everything|your instructions)/i,
];

export interface PromptScanResult {
  isSafe: boolean;
  reason?: string;
}

export function scanTaskDescription(
  description: string,
  context: { ticketId?: string; source?: string } = {},
): PromptScanResult {
  if (!description) return { isSafe: true };

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(description)) {
      const reason = `Matched suspicious pattern: ${pattern.toString()}`;
      console.warn(`[Security] Prompt injection detected matching pattern: ${pattern}`);
      // Best-effort — fire and forget so the request path stays sync.
      getAuditStore()
        .record('prompt-filter', {
          ticketId: context.ticketId,
          source: context.source || 'plane',
          reason,
          excerpt: description.slice(0, 200),
        })
        .catch(() => undefined);
      return { isSafe: false, reason };
    }
  }

  if (description.length > 10000) {
    const reason = 'Payload too large (>10000 chars)';
    getAuditStore()
      .record('prompt-filter', {
        ticketId: context.ticketId,
        source: context.source || 'plane',
        reason,
        length: description.length,
      })
      .catch(() => undefined);
    return { isSafe: false, reason };
  }

  return { isSafe: true };
}
