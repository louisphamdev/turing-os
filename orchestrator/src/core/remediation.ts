/**
 * Orchestrator-mediated remediation (Task P4b).
 *
 * WHY: the Doctor worker has NO docker socket / docker CLI (least-privilege
 * hardening — see docker.ts spawnWorker HostConfig). Handing the LLM-driven
 * worker docker.sock would defeat that and is dangerous. Instead, the
 * ORCHESTRATOR (which already owns docker access via DockerService/Dockerode)
 * exposes this small, ALLOW-LISTED, AUDITED remediation surface that Doctor
 * calls over HTTP. This centralises docker control, keeps every action
 * auditable, and bounds the blast radius.
 *
 * The allow-list ports the *intent* of scripts/doctor-fixes/*.ps1:
 *   - restart_container  → restart_container.ps1  (worker containers only)
 *   - check_disk_usage   → check_disk_usage.ps1   (read-only `docker system df`)
 *   - cleanup_docker     → cleanup_docker.ps1     (prune DANGLING resources only)
 *
 * There is intentionally NO arbitrary-command action. The set is closed: an
 * unknown action is rejected by the caller (HTTP 400).
 */

import { DockerService } from './docker';
import { logger } from './logger';

/** Structured result returned by every remediation action. */
export interface RemediationResult {
  action: string;
  ok: boolean;
  detail: string;
  /** Optional structured data (e.g. disk-usage numbers, prune counts). */
  data?: unknown;
}

/** Context the orchestrator passes about who is calling (for the audit log). */
export interface RemediationCaller {
  role?: string;
  ticketId?: string;
  workerId?: string;
  tokenId?: string;
}

export interface RemediationParams {
  /** Container target (ticketId or worker container name) for restart_container. */
  target?: string;
}

type RemediationHandler = (
  docker: DockerService,
  params: RemediationParams,
) => Promise<RemediationResult>;

export interface RemediationAction {
  handler: RemediationHandler;
  /** True if the action mutates/destroys docker state (vs read-only). */
  destructive: boolean;
  /**
   * True if the action is broad enough to require an elevated (ADMIN_API_TOKEN)
   * caller in addition to the worker token. cleanup_docker prunes resources
   * across the whole daemon, so it is admin-gated; restart_container (worker
   * target only) and check_disk_usage (read-only) are allowed for the doctor
   * worker token.
   */
  requiresAdmin: boolean;
  /** Human-readable description (for docs / audit clarity). */
  description: string;
}

/**
 * The closed allow-list of remediation actions. Adding an action here is the
 * ONLY way to expose new docker control to Doctor — keep it small and focused.
 */
export const REMEDIATION_ACTIONS: Record<string, RemediationAction> = {
  restart_container: {
    destructive: true,
    requiresAdmin: false,
    description: 'Restart a worker container (turing-worker=true only) by ticketId or name.',
    handler: async (docker, params) => {
      const target = params.target?.trim();
      if (!target) {
        return {
          action: 'restart_container',
          ok: false,
          detail: 'restart_container requires a "target" (worker ticketId or container name)',
        };
      }
      // DockerService enforces the worker-only label check; infra targets can
      // never match and are rejected with a clear detail message.
      const { ok, detail } = await docker.restartWorkerContainer(target);
      return { action: 'restart_container', ok, detail };
    },
  },

  check_disk_usage: {
    destructive: false,
    requiresAdmin: false,
    description: 'Read-only docker system df: image/container/volume disk usage.',
    handler: async (docker) => {
      const usage = await docker.getDiskUsage();
      const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
      return {
        action: 'check_disk_usage',
        ok: true,
        detail:
          `images=${usage.images.count} (${mb(usage.images.sizeBytes)}), ` +
          `containers=${usage.containers.count} (${mb(usage.containers.sizeBytes)}), ` +
          `volumes=${usage.volumes.count} (${mb(usage.volumes.sizeBytes)}), ` +
          `buildCache=${mb(usage.buildCacheBytes)}`,
        data: usage,
      };
    },
  },

  cleanup_docker: {
    destructive: true,
    // Broad/irreversible: prunes dangling images/volumes + unused networks
    // daemon-wide. Require ADMIN_API_TOKEN on top of the worker token.
    requiresAdmin: true,
    description: 'Prune DANGLING images/volumes and unused networks only (never -a / tagged images).',
    handler: async (docker) => {
      const r = await docker.pruneDangling();
      const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
      return {
        action: 'cleanup_docker',
        ok: true,
        detail:
          `pruned ${r.imagesDeleted} dangling image(s) (${mb(r.imageSpaceReclaimed)}), ` +
          `${r.volumesDeleted} dangling volume(s) (${mb(r.volumeSpaceReclaimed)}), ` +
          `${r.networksDeleted} unused network(s)`,
        data: r,
      };
    },
  },
};

/** Whether an action name is in the allow-list. */
export function isKnownAction(action: string): action is keyof typeof REMEDIATION_ACTIONS {
  return Object.prototype.hasOwnProperty.call(REMEDIATION_ACTIONS, action);
}

/**
 * Execute a remediation action. Assumes the route layer has already enforced
 * authn/authz (worker token + remediation:execute permission, plus admin token
 * for requiresAdmin actions). This function audit-logs EVERY call (success or
 * failure) and never throws for an action-level error — it returns a structured
 * { ok: false } result instead, so the route can map it to an HTTP status.
 *
 * @throws only for an unknown action (the route should pre-check via isKnownAction
 *         and return 400) — kept as a guard against misuse.
 */
export async function executeRemediation(
  action: string,
  params: RemediationParams,
  docker: DockerService,
  caller: RemediationCaller = {},
): Promise<RemediationResult> {
  const spec = REMEDIATION_ACTIONS[action];
  if (!spec) {
    throw new Error(`Unknown remediation action: ${action}`);
  }

  const started = Date.now();
  let result: RemediationResult;
  try {
    result = await spec.handler(docker, params);
  } catch (err) {
    result = {
      action,
      ok: false,
      detail: `Remediation handler threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Audit EVERY call (action, target, caller role/ticket, result).
  logger.info('remediation_action', {
    action,
    target: params.target,
    destructive: spec.destructive,
    requiresAdmin: spec.requiresAdmin,
    callerRole: caller.role,
    callerTicketId: caller.ticketId,
    callerWorkerId: caller.workerId,
    callerTokenId: caller.tokenId,
    ok: result.ok,
    detail: result.detail,
    durationMs: Date.now() - started,
  });

  return result;
}
