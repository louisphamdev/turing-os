#!/usr/bin/env bash
# =============================================================================
# orchestrator-health.sh — External health check cron for turing-orchestrator
# =============================================================================
# Purpose:
#   - Polls GET /health/ping on the orchestrator every 5 minutes
#   - If orchestrator is down OR /health/ping fails → send critical alert
#   - If orchestrator recovers → send recovery notification
#
# Usage (add to crontab):
#   */5 * * * * /path/to/orchestrator-health.sh
#
# Dependencies: curl, bash
# =============================================================================

set -euo pipefail

ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3001}"
ALERT_FILE="${ALERT_FILE:-/tmp/turing-orchestrator-alert.json}"
WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

# ─── Helpers ───────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"
}

send_alert() {
  local level="$1"    # CRITICAL | WARNING | INFO
  local message="$2"
  local details="${3:-}"

  log "${level}: ${message}"

  if [[ -n "${WEBHOOK_URL}" ]]; then
    curl -sf -X POST "${WEBHOOK_URL}" \
      -H "Content-Type: application/json" \
      -d "{\"alert\":{\"level\":\"${level,,}\",\"source\":\"orchestrator-health.sh\",\"message\":\"${message}\",\"details\":\"${details}\",\"system\":\"turing-os\",\"timestamp\":\"$(date -Iseconds)\"}}" \
      || log "WARNING: Failed to send webhook alert"
  fi
}

# ─── Health Check ──────────────────────────────────────────────────────────

check_orchestrator() {
  local start_ts
  start_ts=$(date +%s%3N)

  local response
  local http_code

  response=$(curl -sf -m 10 "${ORCHESTRATOR_URL}/health/ping" 2>&1) || true
  http_code=$?

  local elapsed_ms=$(( $(date +%s%3N) - start_ts ))

  # curl returns 0 on success, non-zero on failure
  if [[ ${http_code} -eq 0 ]] && [[ -n "${response}" ]]; then
    return 0   # healthy
  else
    return 1   # unhealthy
  fi
}

# ─── Main ─────────────────────────────────────────────────────────────────

was_down=false
if [[ -f "${ALERT_FILE}" ]]; then
  was_down=true
fi

if check_orchestrator; then
  # ── Healthy ──────────────────────────────────────────────────────────────
  if $was_down; then
    log "Orchestrator recovered — clearing alert file"
    rm -f "${ALERT_FILE}"
    send_alert "INFO" "Orchestrator recovered" "Turing OS orchestrator is back online."
  else
    log "Orchestrator healthy (${ORCHESTRATOR_URL}/health/ping OK)"
  fi
else
  # ── Unhealthy ────────────────────────────────────────────────────────────
  log "Orchestrator DOWN — ${ORCHESTRATOR_URL}/health/ping failed"

  if $was_down; then
    log "Already alerted — skipping duplicate alert"
  else
    # Record that we've alerted (prevents alert spam)
    echo "DOWN at $(date -Iseconds)" > "${ALERT_FILE}"

    send_alert "CRITICAL" \
      "Orchestrator DOWN" \
      "GET ${ORCHESTRATOR_URL}/health/ping failed. Turing OS may be non-functional. Check container logs: docker logs turing_orchestrator"
  fi
fi
