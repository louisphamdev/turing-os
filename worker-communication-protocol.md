# Worker Communication Protocol

## Core Principle

> **ALL task-related decisions go through PM. Workers NEVER communicate directly with each other.**

```
ABSOLUTE RULE:
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Worker A ────── ✗ ────── Worker B                     │
│       │                              │                  │
│       │         WRONG!               │                  │
│       │                              │                  │
│       └──────────┬───────────────────┘                  │
│                  │                                       │
│                  ▼                                       │
│         ┌───────────────┐                               │
│         │       PM      │ ← SINGLE SOURCE OF TRUTH       │
│         └───────┬───────┘                               │
│                 │                                       │
│         ┌───────┴───────┐                               │
│         │               │                               │
│         ▼               ▼                               │
│    Worker A        Worker B                             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Communication Flow

### Correct Flow: Everything via PM

```
Task Decision Flow (CORRECT):

Worker A ──► "PM: Task X blocked, need input from Worker B"
     │
     │         PM ──► "Worker B: Provide update on Task Y"
     │
Worker A ◄── "PM: Worker B says [info], proceed accordingly"

NO DIRECT Worker A ↔ Worker B communication
```

### Wrong Flow: Peer-to-Peer (FORBIDDEN)

```
FORBIDDEN Patterns:

✗ Worker A ──► "Hey Worker B, I need info" ──► Worker B
✗ Worker B ──► "Can you help with Task X?" ──► Worker A
✗ Worker A ──► "Your output broke my task" ──► Worker B
```

---

## Worker-to-Worker Rules

### Rule 1: Never Initiate Peer Communication

```python
# WRONG - FORBIDDEN
def some_function():
    # Worker A calling Worker B directly
    response = requests.post("http://worker-b:8080/help", data={...})
    
# CORRECT - Via PM
def some_function():
    # Worker A asks PM
    pm_message("Task X blocked, need info. Please ask Worker B.")
```

### Rule 2: Never Shift Responsibility

```python
# WRONG - FORBIDDEN
"This task is blocked because Worker B didn't deliver"
→ Worker A blaming Worker B

# CORRECT - Report to PM
"Task X blocked. I need [specific info]. Please coordinate."
→ PM decides next steps
```

### Rule 3: Always Report to PM

```
Worker Actions:
1. COMPLETE → Report to PM: "Task X done"
2. BLOCKED → Report to PM: "Task X blocked, reason Y"
3. NEED INFO → Report to PM: "Task X needs [info], please coordinate"
4. CONFLICT → Report to PM: "Task X conflict with Task Y, please resolve"
```

---

## PM as Central Coordinator

### PM Responsibilities

```
PM Coordinates:
1. TASK ASSIGNMENTS - Which worker does what
2. DEPENDENCIES - Worker B must finish before Worker A
3. BLOCKERS - Who resolves what
4. PRIORITY - Which task goes first
5. CONFLICTS - Resource or task conflicts
```

### PM Command Types

```python
PM_COMMANDS = {
    # Task Management
    "ASSIGN": "Worker X, do Task Y",
    "PAUSE": "Worker X, pause Task Y, work on Task Z",
    "RESUME": "Worker X, resume Task Y",
    "CANCEL": "Worker X, cancel Task Y",
    
    # Coordination
    "BLOCKED": "Worker X, Task Y is blocked by [reason]",
    "COORDINATE": "Worker X, get info from Worker Y via PM",
    "DEPENDENCY": "Worker X wait for Worker Y to complete",
    
    # Escalation
    "ESCALATE": "PO needs to resolve this",
    "REVIEW": "QA/PM review needed",
}
```

---

## Dependency Handling

### Task Dependencies (PM-Managed)

```
Example: Task B depends on Task A output

WRONG (Worker-to-Worker):
Worker B ──► Worker A: "When will your output be ready?"
Worker A ──► Worker B: "I'll send it when done"
Worker B ──► Worker A: "I'm blocked waiting"
(Loop: Worker B keeps asking, Worker A doesn't know timeline)

CORRECT (Via PM):
Worker B ──► PM: "Task B blocked, waiting for Task A output"
PM ──► Worker A: "Prioritize Task A, Worker B waiting"
PM ──► Worker B: "Task A will be done in ~30min, please wait"
(PM tracks and coordinates)
```

### Shared Resource Conflicts

```
Example: Both need Database lock

WRONG (Workers negotiating):
Worker A ──► Worker B: "Give me the DB lock"
Worker B ──► Worker A: "No, I'm using it"
(Argument, neither knows timeline)

CORRECT (PM decides):
Worker A ──► PM: "Blocked, need DB lock held by Worker B"
PM ──► Worker B: "Can you release DB lock in 5min?"
PM ──► Worker A: "Lock available in 5min"
(PM has full picture)
```

---

## Deadlock Prevention

### Common Deadlock Patterns

```
PATTERN 1: Circular Wait
Worker A waiting for Worker B
Worker B waiting for Worker C
Worker C waiting for Worker A
→ DEADLOCK

PATTERN 2: Responsibility Loop
Worker A → "This is Worker B's job"
Worker B → "No, Worker A should do it"
Worker A → "I already said it's B's job"
→ STUCK
```

### Prevention: PM Breaks Deadlocks

```
Deadlock Resolution (PM Only):

1. DETECT: PM notices workers waiting on each other
2. ANALYZE: PM maps dependency cycle
3. DECIDE: PM assigns clear ownership
4. COMMAND: PM tells each worker their action
5. LOG: PM documents to prevent future cycles
```

### PM's Deadlock Detection

```python
def detect_deadlock():
    """
    PM periodically checks:
    1. Are workers waiting on each other?
    2. Are there circular dependencies?
    3. Are workers idle but task not progressing?
    """
    waiting_workers = get_workers_with_status("WAITING")
    
    for worker in waiting_workers:
        blocker = worker.blocked_by
        if blocker in [w.id for w in waiting_workers]:
            # CIRCULAR WAIT DETECTED
            pm_escalate(f"Deadlock: {worker} ↔ {blocker}")
            return BREAK_DEADLOCK
    
    return None  # No deadlock

def break_deadlock(workers):
    """
    PM breaks deadlock by:
    1. Pausing one worker
    2. Reassigning tasks
    3. Giving clear ownership
    """
    # PM makes decision, workers follow
```

---

## Communication Templates

### Worker → PM Messages

```
1. TASK COMPLETE:
"[Worker X] Task [ID] completed.
Output: [summary]
Next: [ready for new task]"

2. TASK BLOCKED:
"[Worker X] Task [ID] blocked.
Reason: [specific reason]
Need: [exactly what's needed]
Please coordinate with [specific worker] if needed"

3. NEED DEPENDENCY:
"[Worker X] Task [ID] needs output from Task [Y].
Please coordinate delivery."

4. CONFLICT:
"[Worker X] Conflict detected:
Task [ID] vs Task [Y]
Resource: [what's contested]
Please resolve."

5. IDLE:
"[Worker X] Task [ID] complete, idle.
Capacity available for new tasks."
```

### PM → Worker Messages

```
1. NEW ASSIGNMENT:
"[Worker X] New task: [ID]
Priority: [P0-P3]
Deadline: [if any]
Execute now."

2. COORDINATE:
"[Worker X] Get info from [Worker Y] about [topic].
Use PM as relay if needed."

3. PAUSE/RESUME:
"[Worker X] Pause Task [ID], work on [ID-Y].
Resume [ID] when [condition]."

4. ESCALATE:
"[Worker X] This requires PO intervention.
PM escalating. Stand by."

5. CONFLICT RESOLVED:
"[Worker X] Conflict resolved:
You get [resource/priority]
Worker [Y] gets [resource/priority]
Proceed."
```

---

## Implementation: Message Bus

### All Workers Connect to PM (Not Each Other)

```
Worker Architecture:

┌─────────┐     ┌─────────┐     ┌─────────┐
│Worker A │     │Worker B │     │Worker C │
└────┬────┘     └────┬────┘     └────┬────┘
     │               │               │
     └───────────────┼───────────────┘
                     │
                     ▼
              ┌─────────────┐
              │  PM Inbox   │ ← All messages go here
              └─────────────┘
                     │
                     ▼
              ┌─────────────┐
              │     PM      │ ← Single decision point
              └─────────────┘
```

### Message Queue (PM-Managed)

```python
class MessageQueue:
    """
    Workers send messages TO PM only.
    PM routes/decides/coordinates.
    """
    
    def send_to_pm(self, from_worker, message_type, payload):
        """Worker → PM only"""
        queue.enqueue({
            "from": from_worker,
            "type": message_type,  # BLOCKED, COMPLETE, NEED_INFO, etc.
            "payload": payload,
            "timestamp": now()
        })
    
    def send_to_worker(self, to_worker, message):
        """PM → Worker only"""
        # Direct message to specific worker
        worker.inbox.put(message)
```

### No Worker-to-Worker Sockets

```
# WRONG - Creates peer-to-peer
worker_a.connect_to(worker_b)  # FORBIDDEN
worker_b.send_to(worker_a)     # FORBIDDEN

# CORRECT - Via PM
worker_a.send_to_pm("need_info", {...})
# PM processes, may or may not involve worker_b
worker_a.receive_from_pm("info", {...})
```

---

## Worker Checkpoint & Fast Recovery

Workers are **ephemeral containers** — they can die at any time (OOM, crash, killed). The checkpoint system ensures a worker can resume from where it left off without repeating work.

### Checkpoint Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        WORKER                                    │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ CheckpointManager                                          │   │
│  │ • Auto-saves every N iterations (configurable)            │   │
│  │ • Captures: messages, iteration, context, last_action      │   │
│  │ • Compresses + base64 to reduce size                      │   │
│  │ • File: /tmp/worker-checkpoint.json (shared volume)        │   │
│  └───────────────────────────────────────────────────────────┘   │
│         │                                           │            │
│         ▼ (notify on save)                          ▼ (load)   │
│  ┌──────────────┐                           ┌────────────────┐  │
│  │ Orchestrator │                           │  New Worker    │  │
│  │ /webhooks/   │                           │  (spawned on  │  │
│  │ checkpoint   │                           │   crash)      │  │
│  └──────────────┘                           └────────────────┘  │
│                                                    ▲             │
│                                             loads checkpoint     │
│                                                    │             │
└────────────────────────────────────────────────────┼─────────────┘
                                                     │
                              ┌──────────────────────┴──────────────┐
                              │        Recovery Flow                  │
                              │                                      │
                              │  1. Worker dies → PM detects (HB↓)   │
                              │  2. Doctor diagnoses WHY worker died  │
                              │     (OOM? Crash loop? Dependency?)   │
                              │  3. If Doctor fixes → apply fix       │
                              │  4. PM respawns worker with checkpoint│
                              │  5. Worker loads checkpoint if exists │
                              │  6. Continue from iteration N+1       │
                              │                                      │
                              │  NOTE: Checkpoint is LAST RESORT.    │
                              │  Doctor MUST try to fix first.        │
                              └─────────────────────────────────────┘
```

### Recovery Priority (Doctor First, Checkpoint Last)

```
┌─────────────────────────────────────────────────────────────────┐
│                    DEATH DETECTED (3+ missed HBs)                │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │  1. FLAPPING CHECK    │
                    │  3+ deaths/60min?     │
                    │  → STOP, alert human  │
                    └──────────┬────────────┘
                               │ No
                               ▼
                    ┌───────────────────────┐
                    │  2. DOCTOR DIAGNOSIS  │◄─── BEFORE respawn
                    │  Spawn temp Doctor    │
                    │  container to investigate│
                    │  WHY did worker die?   │
                    └──────────┬────────────┘
                               │
              ┌────────────────┼────────────────┐
              │ Doctor fixable │                │ Doctor can't fix
              ▼                │                ▼
    ┌─────────────────┐        │     ┌─────────────────────┐
    │  Apply fix      │        │     │ Log diagnosis        │
    │  (e.g., restart │        │     │ (root cause unknown)│
    │  service, tune  │        │     └─────────────────────┘
    │  memory, etc.)  │        │
    └────────┬────────┘        │
             │                 │
             ▼                 ▼
    ┌─────────────────────────────────┐
    │  3. RESPAWN with checkpoint     │
    │  New container starts           │
    │  → Loads /tmp/checkpoint.json  │
    │  → Resumes from iteration N    │
    └─────────────────────────────────┘
```

### Checkpoint Contents

```typescript
interface Checkpoint {
  ticket_id: string;        // Task identifier
  role: string;             // Worker role
  iteration: number;        // Current iteration count
  messages_summary: string; // Compressed conversation history (last 30 msgs)
  context: {
    ticket_id: string;
    role: string;
    task: string;           // Task description
    checkpoint_num: number;  // How many checkpoints taken
  };
  last_action: string;      // What agent was doing
  created_at: number;       // Unix timestamp (for staleness check)
}
```

### Checkpoint Events (Worker → Orchestrator)

| Event | When | PM Action |
|-------|------|-----------|
| `checkpoint_saved` | After every auto-save | Track in registry |
| `resumed` | New worker loaded checkpoint | Resume HB tracking |
| `completed` | Task done, checkpoint cleared | Normal cleanup |

### PM Recovery Flow (HealthMonitor._handleDead)

```typescript
// When HealthMonitor detects worker death (3 missed heartbeats):
async function _handleDead(ticketId: string) {
  // 1. Flapping check — 3+ deaths/60min = STOP, alert human
  if (isFlapping(ticketId)) { return; }

  // 2. Kill old container
  await docker.killWorker(ticketId);

  // 3. Doctor diagnosis (BEFORE respawn) — Crown Jewel
  doctorResult = await _invokeDoctorForWorkerDeath(ticketId, role);
  // Doctor identifies root cause (OOM, crash, dependency issue)
  // If fixable: fix is applied before respawn

  // 4. Checkpoint-aware respawn
  const containerId = await docker.spawnWorker(ticketId, role, roomId);
  // New worker → loads checkpoint if exists → resumes from iteration N

  // 5. Worker sends 'resumed' event to /webhooks/checkpoint
  // 6. PM updates registry, continues monitoring
}

// Checkpoint is LAST RESORT — Doctor must try to fix first
// If Doctor fixes root cause → fix applied → respawn with checkpoint (FAST)
// If Doctor can't fix → respawn anyway, checkpoint preserves work
```

### Checkpoint Staleness

- **< 30 min**: Fresh enough to use
- **> 30 min**: Marked stale — PM decides whether to use or restart fresh
- **On completion**: Checkpoint automatically cleared

### Checkpoint Webhooks

| Method | Endpoint | Direction | Purpose |
|--------|----------|-----------|---------|
| POST | `/webhooks/checkpoint` | Worker → Orch | Notify checkpoint save/resume |
| POST | `/webhooks/workers/:id/recover` | PM → Orch | Trigger checkpoint-based recovery |

### Worker Checkpoint Tools

Workers have 3 built-in tools for checkpoint management:

```
TOOL_CALL: save_checkpoint
ARGUMENTS: {"last_action": "Completed iteration 5"}

TOOL_CALL: load_checkpoint
ARGUMENTS: {}

TOOL_CALL: clear_checkpoint
ARGUMENTS: {}
```

### Checkpoint Usage Guidelines

| Scenario | Checkpoint Used? | Reason |
|----------|-----------------|--------|
| Worker dies, Doctor fixes root cause | ✅ Yes (after fix) | Fix prevents recurrence, checkpoint preserves progress |
| Worker dies, Doctor can't fix | ✅ Yes | Preserve work as-is |
| Worker OOM — Doctor increases memory limit | ✅ Yes + fix | Fix + progress preserved |
| Worker crash loop — unknown cause | ✅ Yes | Work preserved, Doctor investigates |
| Worker killed manually by admin | ❌ No | Admin intent = full stop |
| Task completed successfully | ❌ No (cleared) | Task done, no need |

> ⚠️ **Checkpoint is not magic** — it restores state, not fixes bugs. If the bug that killed the worker isn't fixed, the new worker will die the same way. Doctor first, checkpoint second.

### Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `CHECKPOINT_INTERVAL` | `5` | Save every N iterations |
| `CHECKPOINT_PATH` | `/tmp/worker-checkpoint.json` | Checkpoint file path |

### Heartbeat Checkpoint Info

Worker heartbeats now include checkpoint metadata:

```typescript
{
  ticket_id: "TASK-123",
  status: "working",
  progress: "iteration_5",
  checkpoint_count: 2,           // Total checkpoints saved
  last_checkpoint_iteration: 5,  // Last checkpoint iteration
  last_checkpoint_age: 120,      // Seconds since last save
}
```

This lets PM monitor checkpoint health and detect workers that aren't checkpointing properly.
```

---

## Task Assignment Protocol

### PM Assigns, Workers Execute

```
Task Assignment Flow:

1. PO → PM: New task with requirements

2. PM:
   - Breaks into subtasks (if needed)
   - Checks worker availability
   - Assigns to workers (one at a time or batch)
   - Sets dependencies

3. Workers receive ONLY from PM:
   - "Worker A: Do Task X"
   - "Worker B: Wait for Worker A, then Task Y"
   - "Worker A: After Task X, do Task Z"

4. Workers report ONLY to PM:
   - Complete → PM
   - Blocked → PM
   - Need info → PM
```

---

## Conflict Resolution

### Rules for Conflicts

```
Conflict Types:
1. Resource Conflict: Two workers need same resource
2. Task Conflict: Unclear ownership
3. Dependency Conflict: Circular dependencies

Resolution (PM Only):
1. Worker A reports conflict to PM
2. PM analyzes both perspectives
3. PM makes binding decision
4. Both workers follow PM's decision
5. No arguing or negotiation between workers
```

### Conflict Response Template

```python
# Worker A's perspective (report to PM ONLY)
"""
Conflict with Worker B on Task X.
We both tried to [do something].
Please decide who should proceed.
"""

# Worker B's perspective (report to PM ONLY)
"""
Conflict with Worker A on Task X.
I believe I should proceed because [reason].
Please advise.
"""

# PM's resolution (single source of truth)
"""
Decision: Worker A proceeds.
Worker B: Wait for Worker A, then do Task Y.
No further discussion - execute as directed.
"""
```

---

## Summary: Do's and Don'ts

### ✅ DO

```
✓ Worker → PM: Report blockers, completions, conflicts
✓ PM → Worker: Assign tasks, resolve conflicts
✓ All decisions via PM
✓ PM coordinates dependencies
✓ PM breaks deadlocks
✓ Report to PM when stuck
```

### ❌ DON'T

```
✗ Worker ↔ Worker direct communication
✗ Workers negotiating with each other
✗ Workers blaming each other
✗ Workers resolving own conflicts
✗ Workers creating dependencies without PM knowledge
✗ Workers waiting on each other without PM awareness
```

### Why This Works

```
1. SINGLE SOURCE OF TRUTH: PM sees full picture
2. NO LOOPS: All decisions flow through PM
3. NO DEADLOCKS: PM breaks circular waits
4. CLEAR OWNERSHIP: PM assigns, workers execute
5. ACCOUNTABILITY: PM tracks all decisions
```
