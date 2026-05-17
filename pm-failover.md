# PM Failover System (Doctor-Managed)

## Overview

PM is the single point of failure. To prevent system-wide paralysis when PM goes down, the **Doctor Agent** manages PM failover — Doctor already has health monitoring infrastructure, diagnosis tools, and self-healing scripts. PM death is handled by the same Doctor pipeline as worker death, with PM-specific tools and triage categories.

> **Architecture Change from Original Design:**
> The original design specified a hot-standby PM process that monitors via Plane heartbeat and takes over after 60s. The implemented architecture uses **Doctor Agent as the failover manager** — no second PM process needed. This reuses existing infrastructure and adds full diagnose→fix→track→report capabilities.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HEALTH MONITOR                           │
│  (health-monitor.ts — 60s check cycle)                      │
│                                                             │
│  Worker/PM dies → _handleDead()                             │
│         │                                                   │
│         ├── Worker death → _invokeDoctorForWorkerDeath()     │
│         │                                              [A]  │
│         └── PM death    → _invokeDoctorForWorkerDeath() ←── NOW wired
│                               │                             │
│                               ▼                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                   DOCTOR AGENT                         │  │
│  │  PM-specific tools:                                    │  │
│  │  • check_pm_health()         — orchestrator /health    │  │
│  │  • check_pm_queue_state()    — /tmp/turing-pm-state.json│ │
│  │  • check_pm_failover_readiness() — state freshness      │  │
│  │  Triage: PM_FAILURE (P0)                               │  │
│  │  Fix scripts: restart_pm.ps1, check_pm_logs.ps1         │  │
│  └───────────────────────────────────────────────────────┘  │
│                               │                             │
│                               ▼                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  PM STATE MANAGER                      │  │
│  │  (pm-state.ts — persists to /tmp/turing-pm-state.json) │  │
│  │  Auto-saves every 30s. On PM respawn:                  │  │
│  │  → injectQueueState() restores queue tasks             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key difference vs. original standby-PM design:**

| Aspect | Original (standby PM) | Implemented (Doctor-managed) |
|--------|------------------------|------------------------------|
| Extra PM process | 2 containers | 0 extra containers |
| State storage | Plane ticket | Local JSON file |
| Diagnosis on death | None | Full Doctor pipeline |
| Fix on death | None | restart_pm.ps1 + check_pm_logs.ps1 |
| Flapping detection | Not specified | 3 deaths / 60 min → stop |
| Monitoring | Standby → Plane | HealthMonitor 60s cycle |

---

## State Persistence

### What Gets Persisted

The `PMStateManager` writes a snapshot to a local JSON file every 30 seconds.
The file holds enough context for a freshly respawned PM to resume dispatching
without consulting Plane first.

```typescript
// orchestrator/src/core/pm-state.ts — actual shape persisted to disk
interface PMState {
  pmTicketId: string;            // identity of the PM that owned the queue
  pmContainerId: string;
  pmStartTime: number;
  queueState: {
    queue: QueuedTask[];         // tasks waiting for dispatch
    runningTask: QueuedTask | null;
    pausedTasks: [string, QueuedTask][];
  };
  timestamp: number;             // wall-clock time of last save
}
```

### Persistence Path

| Setting | Default | How to override |
|---------|---------|-----------------|
| State file | `/tmp/turing-pm-state.json` | `PM_STATE_PATH` env var |
| Save cadence | 30s | hard-coded in `PMStateManager.startAutoPersist` |
| Stale threshold | 2 minutes since last save | `PMStateManager.isStateStale` |

> Caveat: the file lives on the orchestrator container's filesystem. If the
> orchestrator itself is recreated, the file is lost and PM has to rebuild
> queue state from Plane tickets. Mount a volume on `PM_STATE_PATH` if you
> need PM-failover survival across orchestrator restarts.

---

## Failover Flow (End to End)

```
T+0s    Worker (PM container) crashes / OOM / SIGKILLed.
T+0..60s HealthMonitor's 60s heartbeat check elapses without a beat from PM.
T+60s   HealthMonitor._handleDead() runs.
        → detects isPM = (role === 'pm')
        → calls _invokeDoctorForWorkerDeath('pm', ticketId)
        → awaits pmStateManager.saveState() so the dying PM's queue is captured.
T+60..90s Doctor agent triages: category=PM_FAILURE, severity=P0.
        Doctor runs:
          - check_pm_health()             — orchestrator /health
          - check_pm_queue_state()        — reads /tmp/turing-pm-state.json
          - check_pm_failover_readiness() — confirms state is fresh
        If a known fix matches, Doctor invokes scripts/doctor-fixes/restart_pm.ps1.
T+90s+  Orchestrator respawns PM via DockerService.spawnWorker('pm').
        On boot, PM reads PM_STATE_PATH and re-hydrates its priority queue.
T+~120s PM resumes dispatching from where the old PM left off.
```

---

## Flapping Protection

`HealthMonitor` keeps a rolling window of PM deaths.

| Field | Value |
|-------|-------|
| Window length | 60 minutes |
| Death threshold | 3 |
| On exceed | Stop respawning, page admin via Matrix |

---

## Admin Commands (Matrix DM to orchestrator)

| Command | Effect |
|---------|--------|
| `/pm-status`   | Show current PM container ID + queue depth |
| `/pm-health`   | Force one health-check cycle and report |
| `/failover-now`| Kill current PM and let the failover flow respawn it |
| `/view-pm-state` | Dump the contents of `PM_STATE_PATH` |

---

## Worker Handling of PM Unavailable

Workers do not need PM-failover URLs because there is only one orchestrator
endpoint. When PM is being respawned, workers see `503` from PM-routed
endpoints and back off:

```
Worker → orchestrator (PM route): 503 PM unavailable
    │
    ├── Retry with exponential backoff (1s → 2s → 4s ... max 30s)
    └── After ~3 minutes without PM:
        - Stop accepting new tasks
        - Save checkpoint (see worker-communication-protocol.md)
        - Wait passively for PM to come back; do NOT escalate to other workers
```

---

## Open Items

- **Cross-orchestrator persistence:** mount a volume on `PM_STATE_PATH` so
  PM state survives orchestrator container recreation.
- **State-file integrity:** add a checksum / version field so a corrupted save
  is detected on load rather than parsed into an unusable queue.
- **Heartbeat to Plane:** the current model is local-only; mirroring PM state
  to a Plane ticket would let an external observer detect PM death.

