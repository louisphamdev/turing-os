#!/bin/bash
# =============================================================================
# Base Worker Entrypoint with Cron Daemon
# Replaces default CMD to run cron alongside main process
# =============================================================================

set -e

CRON_FILE="/etc/crontab"
MAIN_PROCESS="${1:-python /workspace/src/index.py}"

# Copy crontab if exists
if [ -f /workspace/crontab ]; then
    cp /workspace/crontab /etc/crontab
    chmod 0644 /etc/crontab
fi

# Start cron daemon in background
echo "[entrypoint] Starting cron daemon..."
crond -f -l 2 &

# Wait for cron to start
sleep 2

# Run initial cleanup
echo "[entrypoint] Running initial cleanup..."
rm -rf /tmp/* 2>/dev/null || true
rm -rf /workspace/tmp/* 2>/dev/null || true
rm -rf /root/.cache/* 2>/dev/null || true

echo "[entrypoint] Starting main process: $MAIN_PROCESS"

# Exec main process
exec $MAIN_PROCESS
