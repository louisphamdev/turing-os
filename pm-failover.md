# PM Failover System

## Overview

PM is the single point of failure. To prevent system-wide paralysis when PM goes down, we implement a **PM Failover** mechanism with a standby PM that takes over if the primary fails.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     PRIMARY PM                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │  • Task assignments                              │   │
│  │  • Resource orchestration                       │   │
│  │  • Worker coordination                           │   │
│  │  • Heartbeat to Taiga every 30s                   │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│                    State Sync                           │
│                    (every 30s)                         │
│                         │                               │
└─────────────────────────┼───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    STANDBY PM                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │  • Hot standby, ready to take over              │   │
│  │  • Reads state from Taiga                        │   │
│  │  • Monitors primary heartbeat                   │   │
│  │  • If primary offline > 60s → TAKEOVER           │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## State Synchronization

### What Gets Synced

```yaml
SYNC_STATE = {
    # Task Management
    "active_tasks": ["TASK-001", "TASK-002"],
    "task_assignments": {
        "SE-001": "TASK-001",
        "QA-001": "TASK-002"
    },
    
    # Worker Status
    "alive_workers": ["SE-001", "QA-001", "DevOps-001"],
    "worker_health": {
        "SE-001": {"status": "working", "last_heartbeat": "..."},
        "QA-001": {"status": "idle", "last_heartbeat": "..."}
    },
    
    # Queue State
    "pending_tasks": ["TASK-003", "TASK-004"],
    "blocked_tasks": ["TASK-005"],
    
    # Resource Config
    "current_mode": "balanced",
    "scale_decisions": []
}
```

### Sync Protocol

```
PRIMARY PM (every 30 seconds):
1. Write current state to Taiga ticket "PM-STATE"
2. Update heartbeat timestamp
3. Continue normal operations

STANDBY PM (every 30 seconds):
1. Read "PM-STATE" from Taiga
2. Check primary heartbeat timestamp
3. IF heartbeat > 60s old → PRIMARY DEAD → TAKE OVER
4. IF heartbeat < 60s → OK, continue standby
```

---

## Failover Trigger Conditions

### Automatic Takeover

| Condition | Trigger | Action |
|-----------|---------|--------|
| Primary heartbeat missing | > 60 seconds | Standby becomes primary |
| Primary PM process dead | System detects | Standby promoted |
| Primary unreachable | > 3 sync cycles | Standby promoted |

### Manual Override

```
# Admin can force failover
/failover-to-backup        # Force standby to become primary
/reset-primary             # Bring primary back as standby
```

---

## Takeover Sequence

```
WHEN STANDBY DETECTS PRIMARY DEAD (T+60s):

1. STANDBY logs: "Primary PM dead, initiating takeover"
3. STANDBY updates Taiga: "PM-STATE" with new primary
3. STANDBY sends broadcast to all workers:
   "PM failover complete. New PM: [standby_id]"
4. STANDBY reads full state from Taiga
5. STANDBY resumes operations:
   - Check blocked tasks
   - Resume interrupted tasks
   - Monitor workers
6. OLD PRIMARY (if comes back):
   - Becomes standby
   - Syncs state from new primary
```

---

## Worker Reconnection

### When PM Changes

```
Workers are configured with PM endpoint:
WORKER_CONFIG = {
    "pm_url": "http://orchestrator:3000",
    "pm_failover_urls": [
        "http://orchestrator-primary:3000",
        "http://orchestrator-backup:3000"
    ]
}

On PM change:
1. Workers receive notification
2. Workers update PM endpoint
3. Workers re-subscribe to new PM
4. Workers confirm connection
```

### Worker Handling of PM Unavailable

```
Worker → PM: "Status update" (no response)
    │
    ├── Wait 10s, retry
    ├── Wait 20s, retry
    ├── Wait 30s, try backup PM
    │
    └── If backup responds:
        "Redirected to backup PM. Continue operations."
    
    └── If no PM responds:
        Worker enters SAFEMODE:
        - Stop new tasks
        - Complete current atomic operation
        - Wait for PM restore
```

---

## Implementation

### Primary PM State Writer

```typescript
// orchestrator/src/core/pm-state.ts

class PMStateManager {
  private stateTicketId = "PM-STATE";
  
  async writeState(state: SystemState): Promise<void> {
    const content = {
      timestamp: Date.now(),
      pm_id: this.pmId,
      state: state,
      heartbeat: Date.now()
    };
    
    await taiga.updateTicket(this.stateTicketId, {
      comment: JSON.stringify(content)
    });
  }
  
  async heartbeat(): Promise<void> {
    // Lightweight heartbeat every 30s
    await taiga.updateTicket(this.stateTicketId, {
      comment: `ping:${Date.now()}`
    });
  }
}
```

### Standby PM Monitor

```typescript
// orchestrator/src/core/standby-pm.ts

class StandbyPM {
  private primaryHeartbeatTimeout = 60000; // 60s
  private checkInterval = 30000; // 30s
  
  async checkPrimaryHealth(): Promise<boolean> {
    const state = await taiga.getTicket("PM-STATE");
    const lastHeartbeat = state.comments.last?.timestamp;
    
    return (Date.now() - lastHeartbeat) < this.primaryHeartbeatTimeout;
  }
  
  async run(): Promise<void> {
    while (true) {
      const isHealthy = await this.checkPrimaryHealth();
      
      if (!isHealthy) {
        console.log("Primary PM dead, taking over...");
        await this.takeover();
      }
      
      await sleep(this.checkInterval);
    }
  }
  
  async takeover(): Promise<void> {
    // 1. Update state to mark self as primary
    // 2. Send notifications to workers
    // 3. Resume operations from last known state
  }
}
```

---

## Recovery & Reinstatement

### Old Primary Recovery

```
When original primary comes back online:

1. New primary (old standby) continues operations
2. Old primary starts as standby
3. State sync: old primary syncs from new primary
4. If new primary fails → old primary takes over

This prevents flapping (constant switching)
```

### Flapping Prevention

```
FLAP_PREVENTION = {
    "cooldown_period": 300,  // 5 min between failovers
    "max_failovers_per_hour": 3,
    "alert_on_failover": true  // Notify admin
}
```

---

## Admin Commands

```
/pm-status                # Show primary and standby status
/failover-now             # Manual failover trigger
/reset-pm                 # Reset primary to original
/pm-health                # Check both PMs health
/view-pm-state            # Current state in Taiga
```

---

## Monitoring

### Failover Metrics

| Metric | Normal | Alert |
|--------|--------|-------|
| PM failover count | 0 | > 0 per day |
| Time since last heartbeat | < 30s | > 60s |
| Standby ready | true | false |
| State sync lag | < 5s | > 30s |

### Alerts

```
ALERT CONDITIONS:
- Primary heartbeat missed → Standby activates
- State sync lag > 30s
- > 3 failovers in 1 hour
- Both PMs claiming primary
```

---

## Safemode for Workers

When workers can't reach any PM:

```
WORKER SAFEMODE:
1. Stop accepting new tasks
2. Complete current atomic operation
3. Save checkpoint to Taiga
4. Log: "PM unreachable, entering safemode"
5. Wait for PM to restore
6. On PM restore: reconnect, resume
```

This prevents workers from running wild without coordination.