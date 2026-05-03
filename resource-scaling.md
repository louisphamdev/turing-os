# Resource Scaling System

## Overview

**Core Roles** (PO, PM) are **ALWAYS alive** - they never sleep or stop.  
**Dynamic Roles** (workers) can be scaled up/down based on demand.

PM acts as the **Resource Orchestrator**, controlling how many workers are active.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ALWAYS ALIVE                              │
│  ┌─────────┐     ┌─────────┐                                │
│  │   PO    │────▶│   PM    │                                │
│  └─────────┘     └────┬────┘                                │
│                      │                                       │
│                      ▼                                       │
│            ┌─────────────────┐                               │
│            │ Resource Manager │ ← PM controls                │
│            │  (in PM process)  │   worker lifecycle           │
│            └────────┬────────┘                               │
└─────────────────────│──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    DYNAMIC (SCALABLE)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │  │ Worker N │    │
│  │  (SE)    │  │  (QA)    │  │ (DevOps) │  │ (Data)   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │             │             │             │          │
│       └─────────────┴─────────────┴─────────────┘          │
│                         │                                   │
│                         ▼                                   │
│               ┌─────────────────┐                            │
│               │   HR Monitor    │ ← Coordinates with PM      │
│               │ (skill matching │   before terminating       │
│               │  & lifecycle)   │                           │
│               └─────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Execution Modes

### Conservative Mode (Default)

```yaml
resource:
  mode: conservative
  max_workers_alive: 2
  workers:
    - software-engineer  # Always keep 1 SE alive
    - qa                 # Keep 1 QA alive for testing
```

**Behavior:**
- Keep minimum workers alive
- Scale up only when tasks queue
- Scale down when idle > 10 minutes

### Balanced Mode

```yaml
resource:
  mode: balanced
  max_workers_alive: 5
  workers:
    - software-engineer  # 2 SE
    - qa                 # 1 QA
    - devops             # 1 DevOps
    - data               # 1 Data
```

**Behavior:**
- Keep multiple workers for different roles
- Moderate resource usage
- Balance speed vs cost

### Aggressive Mode

```yaml
resource:
  mode: aggressive
  max_workers_alive: 10  # Or "unlimited"
  spawn_on_demand: true
```

**Behavior:**
- Spawn workers as tasks arrive
- Higher resource cost
- Maximum speed

### All Mode

```yaml
resource:
  mode: all
  # No limit - spawn all workers needed
```

**Behavior:**
- No worker limit
- Spawn worker per task
- Highest resource cost
- Maximum parallelism

---

## Worker States

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│  ALIVE  │────▶│  IDLE   │────▶│ SLEEPING│
│(running)│     │(waiting)│     │(stopped)│
└────┬────┘     └────┬────┘     └────┬────┘
     │              │               │
     │              │ if idle > X   │ PM starts
     │              │ minutes       │ when needed
     │              ▼               │
     │         ┌─────────┐          │
     │         │TERMINATE│◀─────────┘
     │         │(HR/PM)  │
     │         └─────────┘
     │
     │ if task arrives
     ▼
┌─────────┐
│ WORKING │
└─────────┘
```

| State | Description | Resource Cost |
|-------|-------------|---------------|
| **ALIVE** | Container running, ready for tasks | High |
| **IDLE** | Alive but no task assigned | Medium |
| **SLEEPING** | Container stopped, can wake | Low |
| **TERMINATED** | Container killed, gone | None |

---

## PM Resource Manager

### Responsibilities

```
PM Resource Manager:
1. MONITOR queue depth and priority
2. DECIDE how many workers to keep alive
3. COMMAND HR to spawn/stop workers
4. COORDINATE with HR's idle termination
5. RESPECT max_workers config
```

### Decision Logic

```python
def assess_resource_needs():
    queue_depth = count_pending_tasks()
    priority_high = count_p0_p1_tasks()
    current_alive = count_alive_workers()
    
    if priority_high > 0 and current_alive < priority_high:
        return SCALE_UP  # Need more workers for urgent tasks
    
    if queue_depth > current_alive * 2:
        return SCALE_UP  # Queue is backing up
    
    if queue_depth == 0 and current_alive > min_required:
        return SCALE_DOWN  # Save resources
    
    return MAINTAIN
```

### Scale Up Trigger

```
When to spawn new worker:
1. P0/P1 task arrives and no idle worker available
2. Queue depth > alive workers * 2
3. PM explicitly requests for known upcoming work
```

### Scale Down Trigger

```
When to STOP (not delete) worker:
1. Worker idle > config.idle_timeout minutes
2. Queue is empty or low
3. Current alive > min_required for role
4. Worker is healthy (not stuck/dead)

Scale down → docker stop (preserve container, can restart later)
Scale down does NOT → docker rm (that would lose all trained context)
```

---

## HR Coordination

### HR's Role (Updated)

HR **coordinates with PM** before terminating workers:

```
HR Idle Termination Flow (Updated):
1. Worker idle > 30 minutes
2. HR CHECKS with PM: "Can I terminate worker X?"
3. PM DECIDES based on:
   - Current queue depth
   - Reserved workers for priority tasks
   - Resource mode (conservative/balanced/aggressive)
4. IF PM approves → HR terminates
5. IF PM denies → Worker stays (PM may assign soon)
```

### HR Commands (Updated)

```python
# Instead of auto-terminating, HR asks PM
def should_terminate_worker(worker_id):
    idle_time = get_idle_time(worker_id)
    
    if idle_time > 30 minutes:
        pm_response = ask_pm("Can I terminate worker X?")
        if pm_response == "APPROVED":
            terminate(worker_id)
        else:
            # PM says keep it, maybe for upcoming work
            log(f"PM denied termination for {worker_id}")
    
# HR can still terminate immediately if:
# - PM mode is "aggressive" or "all" (no limits)
# - PM explicitly grants permission
# - Emergency resource need
```

---

## Configuration

### Per-Project Config

Stored in Wiki.js: `/projects/[id]/resource-config.yaml`

```yaml
project:
  name: "Project Turing"
  
resource:
  mode: conservative  # conservative | balanced | aggressive | all
  max_workers_alive: 3
  idle_timeout_minutes: 10
  
  # Minimum workers per role to keep alive
  min_workers:
    software-engineer: 1
    qa: 1
    devops: 0
    
  # Max workers per role
  max_workers:
    software-engineer: 5
    qa: 2
    devops: 1
    data: 1
    
scale_up_cooldown: 2  # minutes between scale-up decisions
scale_down_cooldown: 5  # minutes between scale-down decisions
```

### PM Resource Commands

```python
# PM can override via Taiga comments or direct command
PM_COMMANDS:
  /scale-up [role]       # Spawn additional worker
  /scale-down [role]     # Stop idle worker
  /scale-to [role] [n]   # Set exact count
  /status                # Show current resource status
```

---

## Conflict Resolution

### HR vs PM Resource Decisions

| Scenario | Resolution |
|----------|------------|
| HR wants to terminate, PM needs worker | PM wins, worker stays |
| PM wants to spawn, HR monitoring | HR assists, no conflict |
| Both want to scale down | PM decides, HR defers |
| Emergency (P0 task, no worker) | PM can override HR limits |

### Coordination Protocol

```
1. HR detects idle worker > 30 min
2. HR SENDS REQUEST to PM:
   "Can I terminate SE-Worker-003? Idle 45 min."
3. PM RESPONDS within 1 minute:
   - APPROVE: Terminate
   - DENY: Keep, work incoming
   - DEFER: Wait X minutes
4. HR EXECUTES decision
5. If PM doesn't respond in 2 min → HR uses PM's default mode
```

---

## Priority-Aware Scaling

### P0/P1 Task Priority

When P0/P1 task arrives:

```
1. PM checks: Is there an idle worker for this role?
2. IF NO:
   - Spawn immediately (even if at max_workers limit)
   - PM can exceed limits for P0/P1
3. IF YES:
   - Assign to P0/P1 immediately
   - P0 interrupts lower priority task
```

### Resource Reservation

```yaml
resource:
  mode: conservative
  reserve_for_priority: 1  # Keep 1 worker in reserve
  
# When P0 arrives and no idle worker:
# - Use the reserved worker OR
# - Spawn new (PM override)
```

---

## Metrics & Logging

### Resource Status Report

```markdown
## Resource Status: [Timestamp]

### Alive Workers
| Role | Alive | Idle | Working |
|------|-------|------|---------|
| SE   | 2     | 1    | 1       |
| QA   | 1     | 0    | 1       |
| DevOps| 1    | 1    | 0       |

### Queue
- Pending: 5 tasks
- P0/P1: 2 tasks
- P2/P3: 3 tasks

### Resource Mode
- Current: conservative
- Max Alive: 3
- Scale Decisions: 2 up, 1 down (last hour)

### Recommendations
- Consider scaling up SE workers (queue backing up)
- OK to terminate DevOps worker (idle 45 min)
```

---

## Implementation Notes

### PM as Single Source of Truth

PM's Resource Manager is the **authority** on worker lifecycle decisions:
- HR suggests, PM decides
- PM can override HR's idle termination
- HR never acts unilaterally on worker lifecycle

### Fast Path for Scaling

For P0/P1 emergencies:
1. PM immediately spawns worker (no HR consultation)
2. PM notifies HR after: "Spawned emergency worker X"
3. HR records for tracking

### Graceful Shutdown

When scaling down:
1. PM sends SIGTERM to worker via `docker stop`
2. Worker saves checkpoint
3. Worker stops within 30 seconds (container preserved, not deleted)
4. If stuck, PM deletes forcefully (`docker rm -f`)
5. **Container is STOPPED, not removed** — admin can restart later
