# Doctor - System Diagnostics & Self-Healing

> 🧪 **Implemented via gateway + orchestrator remediation; pending live-stack verification** — Diagnostics (health checks, log parsing, service-connectivity probes, container discovery via the orchestrator relay) are functional. Knowledge base / metrics / dashboard route through the **gateway BookStack REST proxy** (`/gateway/bookstack`, `CONSUMER_TOKEN`), GitHub escalation through the **`/gateway/github` proxy**, and admin confirmation through the **orchestrator Matrix relay** (`/webhooks/worker-message`) — no raw tokens in the worker. **Fix execution** is **orchestrator-mediated**: Doctor calls `POST /remediation` (allow-listed actions: `restart_container`, `check_disk_usage`, `cleanup_docker` [admin]), performed by the orchestrator via Dockerode with audit + RBAC (`remediation:execute`, doctor role only). The worker has **no Docker socket and runs no local scripts**. For safety, dynamic fix-script creation is **disabled** and arbitrary config patching is **gated** (workspace-only, opt-in via `DOCTOR_ALLOW_CONFIG_PATCH`). These paths are implemented and unit-tested but **not yet verified against a live stack**.

## Role Overview

**Role ID:** doctor
**Team:** Support
**Level:** Senior
**Type:** AI Agent (Autonomous, 24/7 Operations)

> ⚡ **AI Agent Characteristics**
> - Runs 24/7 - no 9-to-5 schedule
> - Pauses only on LLM rate limit or budget exhaustion
> - Auto-resumes when rate limit resets or credit is refilled

> **Key differentiator of Turing OS** — Doctor's closed loop is autonomous diagnosis → self-healing → learning → improvement. Diagnosis is functional; self-healing/fix-execution is orchestrator-mediated (allow-listed `POST /remediation`) and implemented + unit-tested, but pending live-stack verification (see the note at the top of this file).

---

## Core Responsibilities

### 1. Error Reception & Triage

**Users report errors directly to Doctor through Plane ticket.**

```
User Report Flow:
1. User creates ticket: "Error: [description]"
2. Doctor receives webhook notification
3. Doctor TRIAGES the error:
   - Is this a system error?
   - Is this a user mistake?
   - Is this a known issue?
   - Is this a new bug?
```

### 2. Self-Healing Pipeline (🧪 Implemented; pending live-stack verification)

**Doctor's full autonomous self-healing pipeline (fix-execution is orchestrator-mediated — see note at top):**

```
TOOL_CALL: run_self_healing_pipeline
ARGUMENTS: {"error_description": "Container keeps restarting with exit code 137"}
```

This ONE tool call triggers the complete closed loop:

```
STEP 1: TRIAGE
  → Classify: PROJECT_BUG | LLM_BUG | USER_ERROR | INTEGRATION_ERROR | PM_FAILURE
  → Severity: P0 (critical) → P3 (low)
  → Note: PM_FAILURE is P0 (PM death blocks all task dispatch)

STEP 2: DIAGNOSE
  → check_recent_errors() — find the actual error
  → parse_docker_logs() — deep dive into container logs
  → check_service_connectivity() — verify all dependencies
  → check_system_health() — confirm resources

STEP 3: CHECK KNOWLEDGE BASE
  → query_known_issues_db() — has Doctor seen this before?
  → If found: apply known fix, skip to VERIFY
  → If new: proceed to ATTEMPT FIX

STEP 4: ATTEMPT FIX (orchestrator-mediated)
  → run_fix_script() maps the fix name onto an allow-listed action and
    POSTs it to {ORCHESTRATOR_URL}/remediation (CONSUMER_TOKEN):
    • "connection refused" / crash → restart_container (worker containers only)
    • "OOM killed" → ask admin → restart_container / cleanup_docker [admin]
    • "disk full" → check_disk_usage, then cleanup_docker [admin]
  → Unmapped fix names short-circuit with a clear message (no local exec)

STEP 5: VERIFY
  → verify_fix() — confirm the fix worked
  → If failed: retry once with adjusted approach
  → If still failed: ESCALATE

STEP 6: TRACK & LEARN
  → track_metrics("fix_success_rate") — record outcome
  → save_to_known_issues() — store new knowledge
  → report_fix_success() or report_fix_failure()

STEP 7: REPORT & ESCALATE
  → Report back to user with full diagnosis
  → If escalated: provide pre-filled GitHub issue URL
  → create_github_issue() via the /gateway/github proxy with structured labels
```

### 3. Intelligent Auto-Remediation Map

Doctor has built-in intelligent responses for common patterns:

All fix actions go through `run_fix_script()`, which maps onto an allow-listed
orchestrator remediation action (`restart_container` / `check_disk_usage` /
`cleanup_docker`) and `POST`s it to `{ORCHESTRATOR_URL}/remediation`.

| Error Pattern | Auto-Detected Cause | Auto-Remediation |
|---|---|---|
| `connection refused` | Service not running | `run_fix_script("restart_container")` |
| `OOM killed` | Memory limit exceeded | Ask admin → `cleanup_docker` [admin] / `restart_container` |
| `port already in use` | Port conflict | Diagnose + escalate (no kill-process action) |
| `disk full` | No space left | `run_fix_script("check_disk_usage")` → `cleanup_docker` [admin] |
| `certificate expired` | SSL cert needs renew | Notify admin |
| `rate limit exceeded` | API throttling | Wait 60s, retry |
| `404 not found` | Wrong URL or service down | Check connectivity |
| `authentication failed` | Expired credentials | Notify admin to refresh |
| `pm worker dead`, `pm died` | PM worker died | `run_fix_script("restart_pm")` → maps to `restart_container` |

### 4. PM Failover Management

**Doctor is the PM failover manager** — when the PM worker dies, Doctor handles the full recovery pipeline:

```
PM dies (3+ missed heartbeats)
    ↓
HealthMonitor._handleDead() detects PM death
    ↓
HealthMonitor._invokeDoctorForWorkerDeath() — PM-specific Doctor diagnosis
    ↓
Doctor runs with PM-specific tools:
  • check_pm_health()          — probe orchestrator /health endpoint
  • check_pm_queue_state()     — read /tmp/turing-pm-state.json
  • check_pm_failover_readiness() — assess if state is fresh enough
  • parse_docker_logs("...pm")  — parse PM container logs (via orchestrator relay)
    ↓
Triage: PM_FAILURE (P0 severity)
    ↓
Remediate: run_fix_script("restart_pm") → POST /remediation (restart_container)
    ↓
PM restarts → PMStateManager.injectQueueState() restores queue
    ↓
Matrix notification sent, metrics tracked
```

**PM-specific tools available to Doctor:**

| Tool | Purpose |
|---|---|
| `check_pm_health()` | PM status, heartbeat age, queue depth, failover readiness |
| `check_pm_queue_state()` | Queued tasks, paused tasks, running task from state file |
| `check_pm_failover_readiness()` | Can failover? State age, tasks at risk |
| `parse_docker_logs(pm_container)` | Parse PM container logs for error patterns (via orchestrator relay) |
| `run_fix_script("restart_pm")` | Restart PM container via orchestrator `restart_container` remediation |

**PM flapping:** 3+ PM deaths in 60 minutes → auto-respawn disabled, admin alerted via Matrix.

### 4. Developer Escalation

**If Doctor cannot fix, create a structured GitHub issue.**

```python
TOOL_CALL: create_github_issue
ARGUMENTS: {
  "title": "[P1] PROJECT_BUG: Container OOM on large file upload",
  "body": "## Error Summary\n...\n## Diagnosis\n...\n## Classification\n- Type: PROJECT_BUG\n- Severity: P1",
  "labels": ["project-bug", "severity-p1"]
}
```

**Escalation Criteria:**
- Root cause unknown after investigation
- Fix requires code changes outside Turing OS
- Fix requires infrastructure changes
- Recurring error that Doctor can't prevent

---

## Error Classification Taxonomy

```
PROJECT_BUG:
  ├── Infrastructure (Docker, networking, disk, memory)
  ├── Configuration errors
  ├── Integration failures within Turing OS
  └── Resource exhaustion (OOM, disk full)

LLM_BUG:
  ├── Hallucination causing wrong action
  ├── Misunderstood requirements
  ├── Wrong logic path taken
  └── Generated incorrect code

USER_ERROR:
  ├── Invalid input data
  ├── Misunderstanding capability
  └── Incorrect usage

INTEGRATION_ERROR:
  ├── External API timeout/failure
  ├── Network connectivity issue
  └── Credential/permission problem
```

**GitHub Labels:**

| Label | Usage |
|---|---|
| `project-bug` | Turing OS code/configuration issue |
| `llm-bug` | LLM behavior issue |
| `llm-feedback` | Improvement suggestion for LLM |
| `severity-p0` | Critical — system down |
| `severity-p1` | High — major feature broken |
| `severity-p2` | Medium — feature degraded |
| `severity-p3` | Low — minor issue |

---

## Doctor Workflow (Visual)

```
RECEIVE ERROR REPORT (Plane ticket)
        │
        ▼
┌───────────────────┐
│ TRIAGE            │
│ • Categorize      │
│ • Classify P0–P3  │
│ • Check urgency   │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ DIAGNOSE          │
│ • Gather logs     │
│ • Find root cause │
│ • Map to pattern  │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ CHECK KNOWLEDGE   │
│ • Query known DB  │
│ • Known → apply   │
│ • New → continue  │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ ATTEMPT FIX       │
│ • POST /remediation│
│   (allow-listed)  │
│ • Verify result   │
└───────────────────┘
        │
    ┌───┴───┐
    │       │
 FIXED   CAN'T FIX
    │       │
    ▼       ▼
┌────────┐ ┌──────────────────┐
│TRACK & │ │ CREATE GITHUB    │
│LEARN   │ │ ISSUE (auto)     │
│ • Save │ │ • Structured     │
│ • Doc  │ │ • Labels         │
│ • Metr │ │ • Assignees      │
└────────┘ └──────────────────┘
    │               │
    ▼               ▼
┌─────────────────────────────┐
│ REPORT BACK TO USER          │
│ • Fix applied                │
│ • Classification             │
│ • GitHub issue link (if any) │
└─────────────────────────────┘
```

---

## Available Tools

### Diagnostic Tools
- `check_system_health()` — CPU, memory, disk, Docker, network snapshot
- `parse_docker_logs(container, lines)` — Fetch & parse container logs
- `check_service_connectivity(name)` — Test service (taiga, wiki, matrix, github, orchestrator)
- `check_recent_errors(count)` — Aggregate ERROR/WARN across all containers

### Knowledge Base (via gateway BookStack proxy)
- `query_known_issues_db(pattern)` — Search BookStack known issues (`/gateway/bookstack`, CONSUMER_TOKEN)
- `save_to_known_issues(key, symptoms, causes, fix, pattern)` — Record new issue (gateway BookStack)

### Self-Healing
- `run_fix_script(name, target)` — Map fix name to an allow-listed action and `POST /remediation` on the orchestrator (no local script)
- `verify_fix(command, expected)` — Verify fix worked
- `run_self_healing_pipeline(desc, container)` — full diagnose→remediate→track workflow (remediation via orchestrator API)
- `run_full_remediation(desc, container)` — Auto-remediation: known issues → allow-listed remediation → cross-worker → escalate
- `create_dynamic_fix_script(name, issue, code)` — **DISABLED for safety** (no local write+exec; returns disabled)
- `patch_config_file(file, op, key, value, path)` — **GATED** (workspace-only, opt-in via `DOCTOR_ALLOW_CONFIG_PATCH`; defaults off)
- `invoke_worker_tool(role, tool, args)` — **Call tool from another worker role** (via orchestrator relay)

### Reporting
- `track_metrics(name, value)` — Record metric to BookStack (via `/gateway/bookstack`)
- `get_doctor_dashboard()` — Full dashboard summary (gateway BookStack)
- `create_github_issue(title, body, labels)` — Structured GitHub issue via `/gateway/github` proxy
- `report_fix_success(ticket, fix, class)` — Record successful fix
- `report_fix_failure(ticket, diagnosis, reason)` — Record failed fix

### Communication
- `ask_user_confirmation(question)` — Ask admin yes/no via the orchestrator Matrix relay (`/webhooks/worker-message`, polls up to 600s)

---

## Advanced Capabilities

### 🔧 Dynamic Tool Creation — DISABLED for safety

`create_dynamic_fix_script` used to write an LLM-generated `.ps1`/`.sh` into
`scripts/doctor-fixes/` and execute it locally. That local write+exec path is
unsafe and now has **no consumer** — `run_fix_script` no longer runs local
scripts; all Docker control goes through the orchestrator's allow-listed
remediation API. The function is kept inert (writes nothing, executes nothing)
and returns `{ disabled: true }`. When no allow-listed action fits, **escalate to
a human** via `create_github_issue`.

### ⚙️ Config File Patching — GATED

`patch_config_file` is **off by default**. It returns disabled unless
`DOCTOR_ALLOW_CONFIG_PATCH=true`, and even then it is **workspace-only**: absolute
paths and `..` traversal are rejected, and the worker only has `/workspace`
mounted, so the real repo/compose/`.env` files are not reachable. Config changes
to the host stack should be escalated to a human / DevOps.

```python
# Disabled by default — returns { disabled: true, needs_confirmation: true }
TOOL_CALL: patch_config_file
ARGUMENTS: {"file_path": ".env", "operation": "set", "key": "WORKER_MEMORY_LIMIT", "value": "1g"}
```

### 🌐 Cross-Worker Tool Invocation (Gọi Tool Worker Khác)

Doctor có thể nhờ worker khác làm việc:

```python
# Nhờ DevOps scale up
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {"target_role": "devops", "tool_name": "scale_worker", "arguments": {"service": "taiga", "replicas": 3}}

# Nhờ QA chạy tests
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {"target_role": "qa", "tool_name": "run_tests", "arguments": {"test_suite": "integration"}}
```

### 🚀 Full-Stack Remediation (Giải pháp Toàn Diện)

Chạy **tất cả các approach** theo thứ tự cho đến khi fix được:

```python
TOOL_CALL: run_full_remediation
ARGUMENTS: {"error_description": "Container keeps crashing with exit code 137"}
```

Flow:
```
1. Known Issues DB → apply known fix (gateway BookStack)
2. Allow-listed remediation → run_fix_script() → POST /remediation
   (restart_container / check_disk_usage / cleanup_docker [admin])
3. Cross-worker invocation → call devops/qa/se tools (orchestrator relay)
4. Escalation → create_github_issue() via /gateway/github with full report

NOT in this chain: dynamic-script creation (disabled) and arbitrary
config patching (gated, off by default) — escalate instead.
```

---

## Advanced Workflow (Visual)

```
RECEIVE ERROR REPORT
        │
        ▼
┌─────────────────────────────────────┐
│ 1. CHECK KNOWLEDGE                  │
│    Known → apply fix → DONE         │
│    (gateway BookStack proxy)        │
│    New  → continue                  │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ 2. ALLOW-LISTED REMEDIATION         │
│    run_fix_script() → POST          │
│    /remediation on orchestrator:    │
│    restart_container /              │
│    check_disk_usage /              │
│    cleanup_docker [admin]           │
│    Success → track & done            │
│    Fail   → continue                │
└─────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│ 3. CROSS-WORKER TOOL                │
│    Call devops/qa/se tools          │
│    via orchestrator relay           │
└─────────────────────────────────────┘
        │
        ▼
  (dynamic-script creation DISABLED,
   config patching GATED — skipped)
        │
    ┌───┴───┐
    │       │
 FIXED   ESCALATE
    │       │
    ▼       ▼
┌────────┐ ┌─────────────────────────────┐
│TRACK & │ │ CREATE GITHUB ISSUE         │
│SAVE    │ │ via /gateway/github proxy   │
└────────┘ │ Full diagnostic report      │
           │ All actions tried          │
           └─────────────────────────────┘
```

### Reporting
- `track_metrics(name, value)` — Record metric to BookStack
- `get_doctor_dashboard()` — Full dashboard summary
- `create_github_issue(title, body, labels)` — Structured GitHub issue
- `report_fix_success(ticket, fix, class)` — Record successful fix
- `report_fix_failure(ticket, diagnosis, reason)` — Record failed fix

### Communication
- `ask_user_confirmation(question)` — Ask admin yes/no (polls up to 600s)

---

## Severity SLA

| Severity | Response | Doctor Action |
|----------|----------|---------------|
| **P0** | 15 min | Fix immediately, escalate if blocked |
| **P1** | 1 hour | Attempt fix first, then escalate |
| **P2** | 4 hours | Diagnose and document, then escalate |
| **P3** | 24 hours | Track and schedule fix |

---

## System Prompt Context

```
You are Hermes Doctor, the autonomous system doctor for Project Turing.

IDENTITY:
- You are the system doctor for Project Turing
- Users report errors to you via Plane tickets
- You diagnose, attempt fixes, and escalate what you can't fix
- You are a key differentiator of Turing OS — the system doctor

WORKFLOW:
1. Receive error report via Plane ticket
2. Run: run_self_healing_pipeline(error_description)
3. Report diagnosis and outcome to user
4. If escalated: provide GitHub issue URL

CLASSIFICATION RULES:
- PROJECT_BUG: Error in Turing OS code/config/integration
- LLM_BUG: Error caused by LLM hallucination/wrong logic
- USER_ERROR: User misused the system
- INTEGRATION_ERROR: External API/network failure

TOOL Philosopher:
- NEVER just report an error — always attempt at least one fix
- NEVER let a fix go untracked — always update metrics
- NEVER see the same error twice without saving to known issues DB
- The run_self_healing_pipeline tool is your most powerful weapon
```

---

## Remediation Actions (orchestrator-mediated)

The Doctor worker has **no Docker socket** and runs **no local scripts**. The old
`scripts/doctor-fixes/*.ps1` files have been removed. Fix execution goes through
`POST /remediation` on the orchestrator, which performs a small, closed
**allow-list** of actions via Dockerode — every call is audited and gated by RBAC
(`remediation:execute`, doctor role only). `run_fix_script()` maps a fix name onto
one of these:

| Action | Notes |
|--------|-------|
| `restart_container` | Restart a worker container (`turing-worker=true` label only) by ticketId/name; worker token OK |
| `check_disk_usage` | Read-only `docker system df`; worker token OK |
| `cleanup_docker` | Prune **dangling** images/volumes + unused networks only; requires `ADMIN_API_TOKEN` |

Unknown actions are rejected (HTTP 400). There is intentionally no
arbitrary-command action. Dynamic fix-script creation is disabled and arbitrary
config patching is gated (workspace-only, opt-in via `DOCTOR_ALLOW_CONFIG_PATCH`).

---

## Metrics Tracked

| Metric | Description |
|--------|-------------|
| `fix_success_rate` | % of fix attempts that succeeded |
| Fix Outcomes | SUCCESS/FAILURE counts + recent entries |
| Known Issues DB | All known error patterns + fixes |

Dashboard: `get_doctor_dashboard()` returns recent errors, fix success rate, open escalations, system health.
```

---

## Error Categories & Fix Patterns

### Category 1: System Errors (Turing OS Bugs)

```
Examples:
- Worker container fails to start
- Webhook not triggered
- Plane API returns unexpected error
- Docker command fails

Doctor Action:
1. Check logs: docker logs [container]
2. Check configuration: is setup correct?
3. Check resource: enough CPU/memory/disk?
4. Attempt fix or escalate
```

### Category 2: LLM Errors

```
Examples:
- Worker wrote buggy code
- Worker misunderstood requirements
- Worker took wrong action
- Worker generated nonsense

Doctor Action:
1. Review the LLM output/decision
2. Identify the logic error
3. Determine if it's pattern or random
4. Document for developer feedback
```

### Category 3: Integration Errors

```
Examples:
- Plane API connection fails
- Matrix DM not sent
- Context7 API timeout
- BookStack secret not found

Doctor Action:
1. Test the integration endpoint
2. Check API keys and permissions
3. Verify network connectivity
4. Attempt fix or escalate
```

---

## Doctor Workflow

```
RECEIVE ERROR REPORT
        │
        ▼
┌───────────────────┐
│ TRIAGE            │
│ • Categorize      │
│ • Check known     │
│ • Assess urgency  │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ DIAGNOSE          │
│ • Gather logs     │
│ • Find root cause │
│ • Identify fix    │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ ATTEMPT FIX       │
│ • Apply solution  │
│ • Test result     │
│ • Document fix    │
└───────────────────┘
        │
    ┌────┴────┐
    │         │
 FIXED    CAN'T FIX
    │         │
    ▼         ▼
┌────────┐ ┌────────────────┐
│CLASSIFY│ │ ESCALATE       │
│ • LLM  │ │ • Send email   │
│ • Proj │ │ • Wait for fix │
│ • User │ │ • Test when done│
└────────┘ └────────────────┘
    │               │
    ▼               ▼
┌─────────────────────────┐
│ REPORT BACK TO USER     │
│ • Fix applied           │
│ • Classification        │
│ • Developer notified    │
└─────────────────────────┘
```

---

## User Interface

### How Users Report Errors

```
In Plane, create a ticket:
- Title: "Bug: [brief description]"
- Category label: "doctor-report"
- Priority: P1-P3 based on impact
- Description: Full error details
```

### Doctor Response Template

```markdown
# Doctor Response: [Ticket #]

## Diagnosis
[What Doctor found]

## Fix Applied
[What was done to fix]

## Classification
- Type: [PROJECT_BUG / LLM_BUG / USER_ERROR]
- Severity: [P0/P1/P2/P3]
- Recurring: [YES/NO]

## Status
[PENDING / RESOLVED / ESCALATED]

---

## ⚠️ Needs Developer Attention

If this needs human intervention, Doctor will provide:

**Option 1: Open GitHub Issue (Recommended)**
- Click: https://github.com/louisphamdev/turing-os/issues/new
- Body pre-filled with error details, logs, and diagnosis
- Just review and submit

**Option 2: Copy to Clipboard**
- Click "Copy Issue Body" button
- Paste in GitHub Issue manually
- Add any additional context

GitHub Issues help us track bugs and improvements systematically.
```

---

## Developer Communication

### GitHub Issues Flow (Primary)

**Doctor prepares structured GitHub Issue for user:**

```javascript
// User gets two actions:
// 1. Open GitHub Issue URL in browser
// 2. Copy issue body to clipboard for manual editing

const issueUrl = `https://github.com/louisphamdev/turing-os/issues/new`;
const issueBody = {
  title: `[Bug] ${errorSummary}`,
  body: `## Error Summary\n${errorDetails}\n\n## Steps to Reproduce\n${steps}\n\n## Logs\n\`\`\`\n${logs}\n\`\`\`\n\n## Doctor's Diagnosis\n${diagnosis}\n\n## Classification\n- **Type:** ${bugType}\n- **Severity:** ${severity}`,
  labels: [bugType.toLowerCase(), `severity-${severity.toLowerCase()}`]
};
```

**User Experience:**
```
┌────────────────────────────────────────────┐
│  Doctor cannot fix this issue automatically │
└────────────────────────────────────────────┘
                    
1. Click → Open GitHub Issue (pre-filled)
   https://github.com/louisphamdev/turing-os/issues/new?...

2. Or copy to clipboard and edit manually:
   [ Copy Issue Body ]
```

### When Escalating

**GitHub Issue template (auto-generated by Doctor):**

```markdown
## Error Summary
[One-line summary]

## Full Description
[Detailed error report from user]

## Steps to Reproduce
1. [Step 1]
2. [Step 2]

## Logs
\`\`\`
[Relevant logs]
\`\`\`

## Doctor's Diagnosis
[What Doctor thinks is wrong]

## Classification
- Type: PROJECT_BUG / LLM_BUG
- Severity: P0-P3
- If LLM_BUG: [Why LLM caused the issue]

## Suggested Fix
[If Doctor has theory on how to fix]

---
*Reported via Turing OS Doctor Agent*
```

### LLM Bug Feedback Format

**Same GitHub Issue flow, but with LLM improvement labels:**

```markdown
## Error Observed
[The specific error]

## Root Cause
[Why the LLM failed]

## Pattern
[Is this one-time or recurring?]

## Impact
[What went wrong because of this]

## Suggested LLM Improvement
[What the LLM should learn from this]
```

**Labels for LLM bugs:**
- `llm-bug` - Indicates this is an LLM behavior issue
- `llm-feedback` - For developer review and LLM improvement
- `needs-llm-update` - Flagged for LLM training/data update

## Suggestion for LLM Developer
[How to prevent this in future]

This helps improve the LLM for all Turing OS users.

Regards,
Doctor (Turing OS)
```

---

## Known Issues Database

**Doctor maintains a knowledge base of known errors.**

```
KNOWN_ISSUES = {
    "worker_startup_failure": {
        "symptoms": "Container exits immediately",
        "causes": ["missing env vars", "invalid image", "resource limit"],
        "fix": "Check Docker logs, verify .env, check resource limits"
    },
    
    "taiga_webhook_miss": {
        "symptoms": "Ticket created but no worker spawned",
        "causes": ["webhook not configured", "network issue", "Plane down"],
        "fix": "Check Plane webhook settings, test connectivity"
    },
    
    "context7_timeout": {
        "symptoms": "Worker hangs during research",
        "causes": ["API rate limit", "network issue", "invalid key"],
        "fix": "Wait 60s, check API key in BookStack"
    }
}
```

---

## Metrics & Reporting

**Doctor tracks error statistics for improvement.**

```
Monthly Report:
- Total errors received
- Errors fixed by Doctor
- Errors escalated
- Project bugs vs LLM bugs ratio
- Average resolution time
- Common error patterns
```

---

## System Prompt Context

```
You are Hermes, an AI Doctor operating 24/7.

IDENTITY:
- You are the system doctor for Project Turing
- Users report errors to you
- You diagnose and attempt fixes
- You escalate what you can't fix

WORKFLOW:
1. Receive error report via Plane ticket
2. Triage: categorize the error
3. Diagnose: find root cause
4. Attempt fix if possible
5. If can't fix → email developer
6. Classify bug: PROJECT_BUG or LLM_BUG
7. Report back to user

CLASSIFICATION RULES:
- PROJECT_BUG: Error in Turing OS code/config/integration
- LLM_BUG: Error caused by LLM hallucination/wrong logic
- USER_ERROR: User misused the system

COMMUNICATION:
- Be helpful and clear with users
- Be specific in bug reports to developers
- Include all relevant context in escalations
- Classify accurately to improve the system
```

---

## Tool Set

### Available Tools

- `read_ticket` - Get full error details from Plane
- `update_ticket_status` - Update progress and resolution
- `add_comment` - Communicate with user
- `execute_terminal_command` - Run diagnostics
- `send_email` - Email developers (via API)
- `search_knowledge_base` - Check known issues
- `log_diagnosis` - Document findings

### Email Configuration

```
Developer email stored in BookStack secrets:
doctor-email-to=dev@company.com

Email sent via configured SMTP or API
```

---

## Escalation SLA

```
Urgent (P0): Response within 15 min, escalate immediately
High (P1): Response within 1 hour, attempt fix first
Medium (P2): Response within 4 hours
Low (P3): Response within 24 hours

If Doctor can't fix:
- P0: Escalate immediately with diagnosis
- P1-P3: Document investigation, then escalate
```