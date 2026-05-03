# Timeout & Escalation Policy

## Overview

Workers operate with bounded wait times. If responses don't arrive within SLA, the system escalates automatically to prevent indefinite blocking.

---

## Timeout Rules

### Default Timeouts

| Action | Timeout | Max Retries | Escalation |
|--------|---------|-------------|------------|
| Worker → PM: Request coordination | 5 min | 3 | PM escalates to PO |
| PM → Worker: Task assignment | 2 min | 1 | PM reassigns |
| Worker → Worker: Dependency response | 5 min | 3 | PM force-resolve |
| Health check: Worker heartbeat | 2 min | 1 | Warning, then investigate |

### Timeout Flow

```
Worker A sends request to PM
    │
    ├── ACK received within 5 min → proceed
    │
    └── No ACK in 5 min:
        ├── Retry 1: "Still waiting for response"
        ├── Retry 2: "Second attempt failed"
        ├── Retry 3: "Final attempt"
        │
        └── After 3 retries (15 min total):
            PM → PO: "BLOCKED: [reason]. Requires PO decision."
```

---

## Retry Policy

### Automatic Retries

```
RETRY_STRATEGY = {
    "max_attempts": 3,
    "backoff_multiplier": 2,  # 1min → 2min → 4min
    "jitter": true,  # Random ±10% to avoid thundering herd
    "escalate_after": 3
}
```

### Retry Flow

```
Attempt 1 (T+0):
  Worker A → PM: "Need input from Worker B"
  PM → Worker B: "Provide within 5 min"
  
Attempt 2 (T+5):
  If no response → PM retries Worker B
  PM → Worker B: "URGENT: Input overdue, respond in 2 min"

Attempt 3 (T+7):
  If still no response → PM escalates
  PM → PO: "Dependency stuck: Worker B not responding"
  PM → Worker A: "Wait or take alternative action"
```

---

## Escalation Triggers

### Auto-Escalation Conditions

| Condition | Escalate To | Action |
|-----------|-------------|--------|
| 3 retries, no response | PO | Request PO decision |
| Task blocked > 15 min | PO | Review and redirect |
| Worker not responding | PM | Kill and respawn |
| Resource exhaustion | PO | Request budget increase |
| Conflict unresolved > 10 min | PO | Force resolution |

### Escalation Message Format

```
ESCALATION_TEMPLATE = """
[ESCALATION from {PM}]

Priority: {P0/P1/P2/P3}
Blocked Task: {task_id}
Blocking Reason: {reason}

Attempts Made:
- Attempt 1: {timestamp} - {result}
- Attempt 2: {timestamp} - {result}
- Attempt 3: {timestamp} - {result}

Current Status: {stuck since X minutes}
Action Required: {specific ask from PO}

PM Recommendation: {suggested resolution}
"""
```

---

## Circuit Breaker Pattern

### Why Circuit Breaker?

```
Without circuit breaker:
Worker A ──► Worker B (timeout)
Worker A ──► Worker B (timeout)
Worker A ──► Worker B (timeout)
Worker A ──► Worker B (timeout)
... (infinite retries)

With circuit breaker:
Worker A ──► Worker B (timeout)
Worker A ──► Worker B (timeout)
Worker A ──► ⚠️ CIRCUIT OPEN ⚠️
Worker A ──► PM: "Worker B circuit open, need alternative"
```

### Circuit Breaker Rules

```
CIRCUIT_BREAKER = {
    "failure_threshold": 3,  # Open after 3 failures
    "timeout_duration": 5,  # Stay open for 5 minutes
    "half_open_after": 5,  # Try reset after 5 min
    "auto_reset": true
}
```

### States

```
┌─────────────┐     3 failures      ┌─────────────┐
│   CLOSED    │ ──────────────────▶ │    OPEN     │
│ (正常运作)  │                    │ (熔断)       │
└─────────────┘                    └─────────────┘
       ▲                                 │
       │                           5 min timeout
       │                                 │
       │    1 success              ┌─────────────┐
       └──────────────────────────── │  HALF_OPEN  │
                                    │ (测试恢复)   │
                                    └─────────────┘
```

---

## Timeout Implementation

### Worker-Side (taiga_tools.py)

```python
async def send_to_pm_with_timeout(message: str, timeout: int = 300):
    """
    Send message to PM with timeout and retry.
    """
    start_time = time.time()
    attempts = 0
    
    while attempts < 3:
        try:
            response = await pm_client.send(message, timeout=timeout)
            return response
        except TimeoutError:
            attempts += 1
            wait_time = (2 ** attempts) * 60  # 1min, 2min, 4min
            if attempts >= 3:
                raise EscalationError(f"No response after {attempts} attempts")
            time.sleep(wait_time + random.jitter(wait_time))
```

### PM-Side (orchestrator)

```typescript
interface TimeoutConfig {
  worker_request_timeout: 300; // 5 min
  worker_retry_limit: 3;
  escalation_cooldown: 60; // 1 min between escalations
}

class EscalationManager {
  async handleTimeout(workerId: string, taskId: string, reason: string) {
    const attempts = await this.getAttempts(workerId, taskId);
    
    if (attempts >= 3) {
      await this.escalateToPO(workerId, taskId, reason);
      await this.openCircuitBreaker(workerId);
    }
  }
  
  async escalateToPO(workerId: string, taskId: string, reason: string) {
    const message = this.formatEscalation(workerId, taskId, reason);
    await matrix.sendDM(po_user_id, message);
    await this.logEscalation(workerId, taskId, reason);
  }
}
```

---

## PM Commands for Timeout

```
/timeout-status              # Show all active timeouts
/kill-stuck [worker]         # Force kill stuck worker
/escalate-to-po [task]       # Force escalate task to PO
/circuit-break [worker]      # Open circuit for worker
/circuit-reset [worker]       # Reset circuit to closed
/retry-now [task]            # Force immediate retry
```

---

## Monitoring & Logging

### Timeout Events to Log

```
TIMEOUT_LOG = {
    "event": "timeout_occurred",
    "worker_id": "SE-001",
    "task_id": "TASK-123",
    "timeout_type": "pm_request",
    "attempts": 3,
    "total_wait": 900,  // seconds
    "escalated_to": "PO",
    "resolution": "pending"
}
```

### Dashboard Metrics

| Metric | Target | Alert If |
|--------|--------|----------|
| Avg timeout duration | < 2 min | > 5 min |
| Escalation rate | < 5% | > 10% |
| Circuit breaker opens | < 2/hour | > 5/hour |
| Unresolved escalations | 0 | > 0 for > 15 min |

---

## Anti-Patterns to Avoid

```
❌ NEVER ignore timeouts - they indicate system issues
❌ NEVER retry indefinitely - circuit breaker prevents this
❌ NEVER escalate without trying retries first
❌ NEVER block PM while waiting - use async notification
```