#!/bin/bash
# =============================================================================
# Base Worker Entrypoint
# Best-effort periodic-maintenance setup, then exec the main process.
#
# The image runs as the non-root `worker` user, so writing /etc/crontab and
# running system cron are EXPECTED to fail. Those steps are best-effort and
# MUST NOT abort startup — the entrypoint's only hard job is to exec the worker.
# (No `set -e`: an optional-maintenance failure must never stop the worker.)
# =============================================================================

# Best-effort: install the crontab + start cron (only works when run as root).
if [ -f /workspace/crontab ] && [ -w /etc/crontab ]; then
    cp /workspace/crontab /etc/crontab 2>/dev/null || true
    chmod 0644 /etc/crontab 2>/dev/null || true
fi
if command -v crond >/dev/null 2>&1; then
    crond -f -l 2 >/dev/null 2>&1 &
fi

# Best-effort initial cleanup (ignore failures / missing dirs).
rm -rf /tmp/* /workspace/tmp/* 2>/dev/null || true

# Exec the full command (the image CMD or an orchestrator-provided Cmd), or the
# default. Using "$@" preserves ALL args (e.g. `python src/index.py`), unlike
# ${1} which would drop everything after the first word.
if [ "$#" -gt 0 ]; then
    echo "[entrypoint] Starting main process: $*"
    exec "$@"
else
    echo "[entrypoint] Starting main process: python /workspace/src/index.py"
    exec python /workspace/src/index.py
fi
