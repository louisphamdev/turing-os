# Worker Health Monitoring

## Overview

PM monitors worker health via heartbeats and progress indicators. Workers that don't report progress within thresholds are flagged as stuck, investigated, and if necessary, killed and respawned.

---

## Health Monitoring Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        PM MONITOR                            │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ HEARTBEAT TRACKER                                      │ │
│  │ • Every worker sends heartbeat every 2 min            │ │
│  │ • Miss 1 heartbeat → WARNING                           │ │
│  │ • Miss 3 heartbeats → STUCK → Investigate              │ │
│  └───────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ PROGRESS TRACKER                                       │ │
│  │ • Track last meaningful work timestamp                │ │
│  │ • No progress for 10 min → STUCK                       │ │
│  │ • Worker can be paused/killed                         │ │
│  └───────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ZOMBIE KILLER                                          │ │
│  │ • Cron job every 5 min                                  │ │
│  │ • DELETE containers with no heartbeat > 15 min         │ │
│  │ • Containers stopped by admin are NOT deleted          │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       WORKERS                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │    SE    │  │    QA    │  │ DevOps   │  │   Data   │    │
│  │  ♥♥♥♥♥   │  │  ♥♥♥♥♡   │  │  ♥♥♡♡♡   │  │  ♥♥♥♥♥   │    │
│  │ Healthy  │  │ Warning  │  │  Stuck   │  │ Healthy  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Heartbeat Protocol

### Worker Side

```python
# base-worker/src/health.py

class WorkerHealth:
  HEARTBEAT_INTERVAL = 120  # 2 minutes
  HEARTBEAT_URL = "http://orchestrator:3000/health/heartbeat"
  
  async def send_heartbeat(worker_id: str, status: str):
    """
    Send heartbeat to PM every 2 minutes.
    """
    payload = {
        "worker_id": worker_id,
        "status": status,  # "working", "idle", "blocked"
        "current_task": current_task_id,
        "timestamp": datetime.now().isoformat(),
        "cpu_percent": psutil.cpu_percent(),
        "memory_mb": psutil.virtual_memory().used / 1024 / 1024
    }
    
    async with aiohttp.ClientSession() as session:
        await session.post(self.HEARTBEAT_URL, json=payload, timeout=30)
```

### PM Side

```typescript
// orchestrator/src/core/health-monitor.ts

interface WorkerHealth {
  workerId: string;
  lastHeartbeat: number;
  lastProgress: number;
  status: 'healthy' | 'warning' | 'stuck' | 'dead';
  consecutiveMisses: number;
}

class HealthMonitor {
  private workers = new Map<string, WorkerHealth>();
  private heartbeat_timeout = 120000; // 2 min
  private stuck_threshold = 600000; // 10 min no progress
  
  async onHeartbeat(workerId: string, payload: HeartbeatPayload): void {
    const health = this.workers.get(workerId);
    
    if (health) {
      health.lastHeartbeat = Date.now();
      health.consecutiveMisses = 0;
      health.status = 'healthy';
    } else {
      this.workers.set(workerId, {
        workerId,
        lastHeartbeat: Date.now(),
        lastProgress: Date.now(),
        status: 'healthy',
        consecutiveMisses: 0
      });
    }
  }
  
  async checkHealth(): Promise<void> {
    const now = Date.now();
    
    for (const [workerId, health] of this.workers.entries()) {
      const timeSinceHeartbeat = now - health.lastHeartbeat;
      
      if (timeSinceHeartbeat > this.heartbeat_timeout * 3) {
        // Missed 3+ heartbeats → DEAD
        health.status = 'dead';
        await this.killAndRespawn(workerId);
      } else if (timeSinceHeartbeat > this.heartbeat_timeout) {
        // Missed 1-2 heartbeats → WARNING
        health.status = 'warning';
        health.consecutiveMisses++;
      }
    }
  }
}
```

---

## Progress Tracking

### What Counts as Progress

```yaml
PROGRESS_INDICATORS:
  - Ticket comment added
  - File created/modified
  - Test executed
  - API call made
  - State change in Taiga
  
NOT_PROGRESS:
  - Heartbeat sent (that's separate)
  - Reading documentation
  - Thinking without output
```

### Progress Update

```python
# Worker reports progress
async def report_progress(task_id: str, progress: str):
    """
    Report meaningful progress to PM.
    """
    await taiga.addComment(task_id, {
        "type": "progress",
        "worker": worker_id,
        "progress": progress,
        "timestamp": now()
    })
    
    # Also update local tracker
    pm_health.updateProgress(worker_id, task_id, progress)
```

---

## Stuck Detection

### Detection Rules

```
STUCK_THRESHOLDS:
  heartbeat_missed: 3      # 6 min no heartbeat
  progress_stale: 10        # 10 min no progress
  both: → MARK AS STUCK
```

### Stuck Worker Flow

```
┌──────────────────────────────────────────────────────┐
│                    STUCK DETECTION                    │
└──────────────────────────────────────────────────────┘
                      │
         ┌────────────┴────────────┐
         │                         │
    No heartbeat            No progress
    > 6 minutes             > 10 minutes
         │                         │
         ▼                         ▼
┌─────────────────┐      ┌─────────────────┐
│  Send WARNING   │      │  Send WARNING   │
│  to worker      │      │  to worker      │
└─────────────────┘      └─────────────────┘
         │                         │
         │    Both conditions      │
         │         met?            │
         │         │               │
         ▼         ▼               │
┌─────────────────────────────────┐
│       MARK AS STUCK              │
│  • Notify PM                     │
│  • Log reason                    │
│  • PM decides: retry/kill/resume │
└─────────────────────────────────┘
```

### PM Investigation

```typescript
async investigateStuckWorker(workerId: string): Promise<void> {
  const health = this.workers.get(workerId);
  
  // 1. Get current task status
  const task = await taiga.getTask(health.currentTask);
  
  // 2. Check if task is actually blocked
  if (task.status === 'BLOCKED') {
    // Expected - worker reported blocked
    // Don't kill, wait for unblock
    return;
  }
  
  // 3. Try to get worker response
  const responded = await this.tryPingWorker(workerId, timeout=10000);
  
  if (!responded) {
    // Worker truly stuck/dead
    await this.killAndRespawn(workerId);
  } else {
    // Worker responded but not making progress
    await this.analyzeProgress(workerId);
  }
}
```

---

## Worker Lifecycle: Stop vs Delete

### Two Modes of Shutdown

| Mode | Command | Effect | Use Case |
|------|---------|--------|----------|
| **STOP** | `docker stop` | Container paused, preserved on disk, can restart | Scale down, temporary pause, preserve "trained" worker |
| **DELETE** | `docker rm -f` | Container permanently removed, all state lost | Admin removal, zombie cleanup, irrecoverable failure |

### When to STOP (Not Delete)

- Worker has been "trained" — learned project context, already made progress
- PM wants to scale down idle workers but keep them for later
- Admin wants to pause a worker temporarily without losing its state

### When to DELETE

- Worker is completely dead/unrecoverable
- Zombie container (no heartbeat > 15 min, auto-cleanup)
- Admin explicitly wants to remove a worker permanently
- Worker failed in a way that requires fresh start

---

## Kill & Respawn

### Kill Conditions

| Condition | Action | Reason |
|-----------|--------|--------|
| 3 missed heartbeats | Delete + respawn | Worker dead |
| Stuck > 15 min | Delete + respawn | Worker hung |
| OOMKilled | Delete + respawn | Out of memory |
| Unresponsive to PM | Delete + respawn | Glitch |
| Manual `/stop` | Stop only | Preserve trained worker |
| Manual `/delete` | Delete + respawn | Admin command |
| Scale down (idle) | **Stop** (not delete) | Preserve for restart |

### Stop Process (Graceful Scale-Down)

```
1. PM/HR decides: "Scale down worker [worker_id]"
2. PM logs: "Stopping worker [worker_id] (scale down)"
3. PM marks worker as STOPPED in registry
4. PM sends SIGTERM via docker stop [container_id]
5. Worker saves checkpoint
6. Container stopped, NOT removed
7. Worker remains in registry as STOPPED
8. Admin can restart later: /start [worker_id]
```

### Delete Process (Permanent)

```
1. PM logs: "Deleting worker [worker_id]"
2. PM marks worker as DEAD in registry
3. PM sends SIGTERM then SIGKILL via docker rm -f [container_id]
4. Wait for container to stop
5. PM notifies HR: "Worker [worker_id] deleted, need respawn"
6. HR spawns new worker with same role
7. New worker checks Taiga for interrupted tasks
8. New worker resumes or gets reassigned
```

### Respawn Process

```typescript
async respawnWorker(role: WorkerRole): Promise<string> {
  // 1. HR creates new container
  const container = await docker.createContainer({
    image: `turing-worker:${role}`,
    labels: ['turing-worker', role],
    env: [...],
    autoRemove: true
  });
  
  // 2. Register new worker
  const workerId = `SE-${Date.now()}`;
  await this.registerWorker(workerId, role, container.id);
  
  // 3. Notify PM
  await this.pm.notify(`Worker ${workerId} spawned for ${role}`);
  
  // 4. Worker loads skills and checks for tasks
  // (handled in worker startup sequence)
  
  return workerId;
}
```

---

## Zombie Killer (Cron)

### Cron Job Configuration

```typescript
// orchestrator/src/core/docker.ts  →  killZombies()

// Cron runs every 5 minutes
// ONLY deletes containers with no heartbeat > 15 min
// Containers that were manually stopped by admin are SKIPPED

const zombieKiller = cron.schedule('*/5 * * * *', async () => {
  console.log('[ZOMBIE-KILLER] Running health check...');
  
  // listContainers with all=true to see stopped containers too
  const containers = await docker.listContainers({
    labels: ['turing-worker'],
    all: true,  // Include stopped containers
  });
  
  for (const container of containers) {
    const workerId = container.labels['worker-id'];
    const health = healthMonitor.getHealth(workerId);
    
    if (!health) {
      // Unknown container with no registry entry → delete it
      console.log(`[ZOMBIE] Deleting unknown container: ${container.id}`);
      await docker.deleteWorker(container.labels['ticket-id']);
      continue;
    }
    
    // Only delete running containers that are zombies
    // Containers in STOPPED state (admin-stopped) are SKIPPED
    if (container.State === 'running' && health.lastHeartbeat) {
      const timeSinceHeartbeat = Date.now() - health.lastHeartbeat;
      if (timeSinceHeartbeat > 15 * 60 * 1000) {
        console.log(`[ZOMBIE] Deleting zombie: ${workerId} (no heartbeat ${Math.round(timeSinceHeartbeat/60000)}min)`);
        await docker.deleteWorker(container.labels['ticket-id']);
        await healthMonitor.markDead(workerId);
      }
    }
    // STOPPED containers are NOT touched by zombie killer
  }
});
```

### Why 5 Minutes?

```
5-minute interval balances:
- Reactivity: Catch problems quickly (max 5 min delay)
- Efficiency: Not running constantly
- Tolerance: Small network blips don't trigger kills
```

---

## Health Dashboard

### Status Board (PM Commands)

```
/health-status              # Show all workers' health
/health-details [worker]    # Show specific worker details
/health-reset [worker]      # Reset health state for worker
/health-history [worker]    # Show health history
```

### Output Example

```
┌────────────┬────────────┬────────────┬────────────┐
│ WORKER     │ STATUS     │ LAST HB    │ PROGRESS   │
├────────────┼────────────┼────────────┼────────────┤
│ SE-001     │ ✓ Healthy  │ 30s ago    │ 2min ago   │
│ SE-002     │ ⚠ Warning  │ 3min ago   │ 5min ago   │
│ QA-001     │ ✓ Healthy  │ 45s ago    │ 1min ago   │
│ DevOps-001 │ ✗ Stuck    │ 12min ago  │ 15min ago  │
│ Data-001   │ ✓ Healthy  │ 20s ago    │ 30s ago    │
└────────────┴────────────┴────────────┴────────────┘

Actions:
- DevOps-001: STUCK → Investigating → Will kill if unresponsive
```

---

## Alerting

### Alert Conditions

```yaml
ALERTS:
  warning_threshold:
    - 1 missed heartbeat
    
  critical_threshold:
    - 3 missed heartbeats
    - stuck > 10 minutes
    
  notification_targets:
    - PM logs
    - Matrix DM to admin (on critical)
```

### Alert Message Format

```
⚠️ WORKER WARNING: [worker_id]
- Status: {status}
- Last heartbeat: {time}
- Last progress: {time}
- Current task: {task_id}

🔴 WORKER CRITICAL: [worker_id]
- Status: DEAD/STUCK
- Action: Killing and respawning
- New worker: [new_worker_id]
```

---

## Integration with Other Systems

### With Resource Scaling

```
HEALTH + SCALING:
- Workers marked DEAD → HR spawns replacement
- Scale down if workers consistently idle
- Scale up if tasks queue and workers healthy
```

### With Worker Communication

```
HEALTH + COMMUNICATION:
- Workers in SAFEMODE (no PM) don't send heartbeats
- PM detects SAFEMODE workers via extended timeout
- PM tries to restore PM connectivity first
```

### With Timeout Policy

```
HEALTH + TIMEOUT:
- Timeout escalation triggers health check
- Stuck worker = timeout escalation candidate
- Circuit breaker affects heartbeat expectations
```