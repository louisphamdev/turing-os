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
