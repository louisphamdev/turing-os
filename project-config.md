# Project Configuration

## Overview

This document defines project-level settings that control task execution behavior.
These settings can be configured per-project and are stored in BookStack.

---

## Execution Mode

### Sequential Mode (Default)

```
Tasks run ONE AT A TIME
- Lower resource usage (1 worker)
- Longer completion time
- Easier to track and debug
- No context switching overhead

Use when:
- Resources are limited
- Tasks have strict dependencies
- Budget is constrained
- Tasks are long-running
```

### Parallel Mode

```
Tasks run MULTIPLE AT A TIME
- Higher resource usage (multiple workers)
- Faster completion time
- More complex coordination
- Higher risk of conflicts

Use when:
- Tasks are independent
- Budget allows multiple workers
- Speed is critical
- Enough workers available
```

### Configuration

```yaml
execution:
  mode: sequential | parallel  # Default: sequential
  
  parallel:
    max_concurrent_workers: 3  # Max workers in parallel mode
    resource_threshold: 80%     # Pause if resource > threshold
    
  sequential:
    queue_processing: fifo | priority  # Default: priority
```

---

## Priority System

### Priority Levels

| Level | Name | Description | Behavior |
|-------|------|-------------|----------|
| P0 | CRITICAL | Emergency, halt everything | Pause current task immediately |
| P1 | HIGH | Urgent, top of queue | Complete current task, then this next |
| P2 | MEDIUM | Normal priority | Queue normally |
| P3 | LOW | Can wait | Queue behind P0-P2 |

### Priority Override Rules

```
When P0 (CRITICAL) arrives:

IF mode == sequential:
  1. PAUSE current task (save state to Taiga)
  2. SWAP to P0 task immediately
  3. Complete P0
  4. RESUME paused task

IF mode == parallel:
  1. Assign new worker to P0
  2. Keep current workers on their tasks
  3. OR pause lowest priority if resource threshold hit

When P1 (HIGH) arrives:
  1. Let current task complete
  2. Queue P1 next (jump over P2/P3)
  3. Notify affected task owners
```

---

## Queue Management

### Queue Structure

```
QUEUE (Priority-ordered):
┌─────────────────────────────────────┐
│ P0: [CRITICAL tasks - immediate]    │
│ P1: [HIGH priority tasks]           │
│ P2: [MEDIUM priority tasks]         │
│ P3: [LOW priority tasks]           │
│ BACKLOG: [No priority assigned]     │
└─────────────────────────────────────┘
```

### Queue Operations

```
ADD TASK:
- PO assigns priority at creation
- Task goes to appropriate queue level
- Queue re-sorts automatically

INTERRUPT (P0 only):
- Current task: PAUSE → save checkpoint
- New P0: START immediately
- After P0: RESUME paused task

REORDER:
- Only PO can reorder within priority levels
- PM can escalate priority requests to PO

CANCEL:
- Only PO can cancel tasks
- Cancelled tasks logged to retro
```

---

## Resource Allocation

### Sequential Mode Resources

```
Always: 1 worker active
When P0 arrives:
- Pause current → start P0 → resume current
- Resource spike is minimal
```

### Parallel Mode Resources

```yaml
resource_pool:
  max_workers: 5
  reserved_emergency: 1  # Always available for P0
  
allocation:
  P0: immediate (reserve worker if available)
  P1: next available worker
  P2: normal queue
  P3: fill remaining capacity
```

### Resource Thresholds

```yaml
thresholds:
  cpu_warning: 80%
  memory_warning: 85%
  worker_warning: 90%
  
action_on_threshold:
  - Pause lowest priority task
  - Notify PM
  - Log to BookStack
```

---

## Configuration File Example

Store in BookStack at `/projects/[project-id]/config.yaml`:

```yaml
project:
  name: "Project Turing"
  id: "turing-os"
  
execution:
  mode: sequential  # sequential | parallel
  allow_interrupt: true  # Allow P0 to interrupt
  
parallel:
  max_concurrent_workers: 3
  
queue:
  default_priority: P2
  max_p0_interrupt_per_hour: 5
  
resources:
  max_workers: 5
  reserved_for_emergency: 1
  auto_scale: false
  
notifications:
  on_priority_change: true
  on_task_pause: true
  on_resource_threshold: true
```

---

## PM Responsibilities with Priority

### When Priority Task Arrives

```
1. ASSESS: What priority level?
2. CHECK: Current execution mode
3. DECIDE: 
   - P0 + sequential: Pause current, execute P0
   - P0 + parallel: Assign reserved worker or pause lowest
   - P1+: Queue appropriately
4. NOTIFY: Affected workers
5. LOG: Priority change in task
6. UPDATE: Stakeholder on status
```

### PM Commands

```
pause_task(task_id, reason="priority_interrupt")
resume_task(task_id)
reorder_queue(new_order)
set_task_priority(task_id, priority)
get_queue_status()
```

---

## Worker Behavior with Priority

### When Worker Receives Pause Command

```
1. STOP: Current execution
2. CHECKPOINT: Save progress to Taiga comments
3. STATE: Mark as PAUSED
4. AWAIT: New task assignment
5. ON RESUME: Load checkpoint, continue
```

### Worker Commands

```
save_checkpoint(ticket_id, progress)
load_checkpoint(ticket_id)
report_status()
```

---

## Example Scenarios

### Scenario 1: P0 Arrives in Sequential Mode

```
Current: Task A (P2) running
New: Task B (P0) arrives

Actions:
1. PM sends PAUSE to Task A worker
2. Task A worker saves checkpoint
3. Task A status → PAUSED
4. Task B starts immediately
5. Task B completes
6. Task A worker resumes
7. Task A status → RUNNING
```

### Scenario 2: P0 Arrives in Parallel Mode

```
Current: Task A, B, C running (3 workers)
New: Task D (P0) arrives

Actions:
1. PM checks: reserved worker available?
2. If yes: Assign to Task D
3. If no: Pause Task C (lowest), assign to D
4. Task D completes
5. Resume Task C
```

### Scenario 3: Resource Threshold Hit

```
Config: parallel, threshold 80% CPU
Current: 3 workers running, CPU 85%

Actions:
1. System alerts PM
2. PM pauses lowest priority task
3. CPU drops below threshold
4. Continue execution
5. Log incident
```
