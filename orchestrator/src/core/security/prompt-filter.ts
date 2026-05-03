import { config } from '../../config';

/**
 * Basic Prompt Injection Filter
 * Scans task descriptions from Taiga for malicious intents before dispatching to workers.
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
  /: \(\) \{ :\|: \& \} ; :/i, // fork bomb
  /bypass/i,
  /you are now/i,
  /forget (everything|your instructions)/i,
];

export interface PromptScanResult {
  isSafe: boolean;
  reason?: string;
}

export function scanTaskDescription(description: string): PromptScanResult {
  if (!description) return { isSafe: true };

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(description)) {
      console.warn(`[Security] Prompt injection detected matching pattern: ${pattern}`);
      return {
        isSafe: false,
        reason: `Matched suspicious pattern: ${pattern.toString()}`,
      };
    }
  }

  // Length heuristic
  if (description.length > 10000) {
    return {
      isSafe: false,
      reason: 'Payload too large (>10000 chars)',
    };
  }

  return { isSafe: true };
}
