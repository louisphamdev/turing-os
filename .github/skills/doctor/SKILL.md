---
name: doctor
description: **SKILL** — Doctor Agent diagnostic & self-healing toolkit for Turing OS. Use when: diagnosing errors, fixing system issues, checking Docker/container health, querying known issues database, running self-healing scripts, tracking fix metrics, or generating GitHub issues. Triggers: "doctor", "diagnose", "fix error", "system health", "self-heal", "container crashed", "service down"
---

# Doctor Agent Skill — Diagnostic & Self-Healing Toolkit

> Doctor is the system-doctor agent: it diagnoses failures, attempts self-healing,
> escalates, and records incidents. Fix-execution is **orchestrator-mediated**:
> `run_fix_script()` maps a fix name onto an allow-listed action and `POST`s it to
> `{ORCHESTRATOR_URL}/remediation` (the orchestrator runs it via Dockerode with
> audit + RBAC). The worker has no Docker socket and runs no local scripts.
> Knowledge base / metrics / GitHub escalation route through the gateway
> (`/gateway/bookstack`, `/gateway/github`) with `CONSUMER_TOKEN`. Dynamic
> fix-script creation is **disabled** and arbitrary config patching is **gated**
> for safety. These paths are implemented and unit-tested but **pending
> live-stack verification**.

## Core Philosophy

```
Every failure is a learning opportunity.
Doctor never just reports — Doctor fixes, tracks, and improves.
```

---

## Doctor Tool Suite

### 1. `check_system_health()`
Quick snapshot of system vitals: CPU, memory, disk, Docker, network.

```python
TOOL_CALL: check_system_health
ARGUMENTS: {}
```

### 2. `parse_docker_logs(container_name, lines=50)`
Fetch & parse logs. Filters INFO, highlights ERROR/WARN. Returns structured entries.

```python
TOOL_CALL: parse_docker_logs
ARGUMENTS: {"container_name": "turing-orchestrator", "lines": 100}
```

### 3. `check_service_connectivity(service_name)`
Test if a service (plane, bookstack, matrix, orchestrator, github) is up/degraded/down.

```python
TOOL_CALL: check_service_connectivity
ARGUMENTS: {"service_name": "plane"}
```

### 4. `check_recent_errors(count=10)`
Aggregate recent ERROR/WARN entries across ALL running containers.

```python
TOOL_CALL: check_recent_errors
ARGUMENTS: {"count": 20}
```

### 5. `query_known_issues_db(error_pattern)` 🔍
Search BookStack known-issues DB. Matches against error key, symptoms, causes, fix.

```python
TOOL_CALL: query_known_issues_db
ARGUMENTS: {"error_pattern": "OOM memory"}
```

### 6. `save_to_known_issues(error_key, symptoms, causes, fix, pattern)`
Record a new known issue to BookStack for future reference.

```python
TOOL_CALL: save_to_known_issues
ARGUMENTS: {"error_key": "worker OOM", "symptoms": "Container killed by OOM killer", "causes": "Memory limit too low", "fix": "Increase MEMORY_LIMIT in .env", "pattern": "killed.*OOM"}
```

### 7. `create_github_issue(title, body, labels, assignees)`
Create a structured GitHub issue via the gateway GitHub proxy (the GitHub token lives in the orchestrator vault; the worker uses `CONSUMER_TOKEN`).

```python
TOOL_CALL: create_github_issue
ARGUMENTS: {"title": "[Bug] Worker OOM on large file upload", "body": "## Error Summary\n...", "labels": ["project-bug", "severity-p1"]}
```

### 8. `run_fix_script(fix_name, target)` 🔧
Map a fix name onto an allow-listed remediation action and `POST` it to
`{ORCHESTRATOR_URL}/remediation` (CONSUMER_TOKEN). The orchestrator runs the
action via Dockerode with audit + RBAC. The worker runs **no** local scripts.
Mappings: `restart_container` / `restart_service` / `restart_pm` → `restart_container`;
`check_disk_usage` → `check_disk_usage`; `cleanup_docker` → `cleanup_docker` (admin).
Unmapped names short-circuit with a clear message.

```python
TOOL_CALL: run_fix_script
ARGUMENTS: {"fix_name": "restart_container", "target": "ticket-42"}
```

### 9. `verify_fix(command, expected_outcome)`
Verify a fix worked by running a shell command and checking output.

```python
TOOL_CALL: verify_fix
ARGUMENTS: {"command": "docker ps | grep turing-orchestrator", "expected_outcome": "turing-orchestrator"}
```

### 10. `track_metrics(metric_name, value)` 📊
Record a metric to BookStack. Keeps last 100 entries per metric.

```python
TOOL_CALL: track_metrics
ARGUMENTS: {"metric_name": "fix_success_rate", "value": 0.85}
```

### 11. `get_doctor_dashboard()` 📋
Full summary: recent errors, fix success rate, open escalations, system health.

```python
TOOL_CALL: get_doctor_dashboard
ARGUMENTS: {}
```

### 12. `ask_user_confirmation(question)` 🙋
Ask admin a yes/no question via Matrix, poll for reply (up to 600s).

```python
TOOL_CALL: ask_user_confirmation
ARGUMENTS: {"question": "Should I restart the failed container?"}
```

### 13. `run_self_healing_pipeline(error_description)` (experimental)
Orchestrates the full self-healing workflow:
diagnose → check known issues → attempt fix → verify → track → report.
The fix-execution steps are experimental; diagnosis + escalation are reliable.

```python
TOOL_CALL: run_self_healing_pipeline
ARGUMENTS: {"error_description": "Container turing-orchestrator keeps restarting with exit code 137"}
```

### 14. `run_full_remediation(error_description, container_name)` 🚀
**Auto-remediation** — tries approaches in sequence:
1. Known Issues DB → 2. Allow-listed remediation (`run_fix_script` → `POST /remediation`) → 3. Cross-worker tools → 4. GitHub escalation (via `/gateway/github`).
Dynamic-script creation and arbitrary config patching are NOT in this chain
(disabled / gated for safety — escalate instead).

```python
TOOL_CALL: run_full_remediation
ARGUMENTS: {"error_description": "Container keeps crashing", "container_name": "turing-orchestrator"}
```

### 15. `create_dynamic_fix_script(...)` 🔨 — DISABLED
**Disabled for safety.** This used to write an LLM-generated `.ps1`/`.sh` into
`scripts/doctor-fixes/` and execute it locally; that write+exec path is unsafe
and now has no consumer (`run_fix_script` no longer runs local scripts). The
function is inert (returns `{ disabled: true }`). When no allow-listed action
fits, **escalate to a human** via `create_github_issue`.

### 16. `patch_config_file(file_path, operation, key, value, path)` ⚙️ — GATED
**Off by default.** Returns disabled unless `DOCTOR_ALLOW_CONFIG_PATCH=true`, and
even then it is **workspace-only** (absolute paths and `..` traversal rejected;
the worker only mounts `/workspace`, so the host repo/compose/`.env` are not
reachable). Escalate host config changes to a human / DevOps. Operations:
`set`, `remove`, `reset` (`append` is rejected).

### 17. `invoke_worker_tool(target_role, tool_name, arguments)` 🌐
**Call a tool from another worker role** via orchestrator relay.
Used when the fix requires capabilities from devops, qa, se, or pm workers.

```python
# Scale via DevOps worker
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {"target_role": "devops", "tool_name": "scale_worker", "arguments": {"service": "plane", "replicas": 3}}

# Run tests via QA worker
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {"target_role": "qa", "tool_name": "run_tests", "arguments": {"test_suite": "integration"}}
```

### 18. `list_docker_containers(include_logs, log_lines)` 🔍 **NEW**
**Discover ALL containers and workers** in the system. This is Doctor's
"eyes on the entire Docker estate" — returns running + stopped containers,
role-classified (doctor/devops/qa/se/po/pm/hr/data/infrastructure), and
optionally with error lines attached.

Discovery strategy: tries local `docker ps` first, falls back to
orchestrator relay via `GET /containers`.

```python
TOOL_CALL: list_docker_containers
ARGUMENTS: {"include_logs": true, "log_lines": 20}
```

### 19. `get_container_inspect(container_name)` 🔬 **NEW**
**Deep inspection** of any container — restart count, restart policy,
resource limits (memory/CPU), mounts, networks, env vars, labels.
Full `docker inspect` parsed into a clean structured dict.

```python
TOOL_CALL: get_container_inspect
ARGUMENTS: {"container_name": "turing-worker-qa-ticket-42"}
```

### 20. `tail_container_logs(container_name, tail, since)` 📜 **NEW**
**Stream log reader** — fetches live logs from any container (even if
Doctor has no local Docker socket), filters ERROR/WARN entries, returns
structured entries with timestamps.

```python
TOOL_CALL: tail_container_logs
ARGUMENTS: {"container_name": "turing_orchestrator", "tail": 50}
```

### 21. `find_containers_by_role(role)` 🎯 **NEW**
Find all containers matching a worker role. Uses `list_docker_containers`
internally so result is always fresh.

```python
TOOL_CALL: find_containers_by_role
ARGUMENTS: {"role": "doctor"}
```

### 22. `report_fix_success(ticket_id, fix_applied, classification)` ✅
Record fix success to BookStack metrics + notify admin via Matrix.

### 23. `report_fix_failure(ticket_id, diagnosis, reason)` ❌
Record fix failure to BookStack metrics + notify admin via Matrix.

---

## Self-Healing Pipeline (Deep Dive)

The `run_self_healing_pipeline` is Doctor's most powerful capability:

```
STEP 1: TRIAGE
  - Categorize: PROJECT_BUG | LLM_BUG | INTEGRATION_ERROR | USER_ERROR
  - Assess severity: P0 (critical) → P3 (low)
  - Check urgency level

STEP 2: DIAGNOSE
  - check_recent_errors() — find the actual error
  - parse_docker_logs() — deep dive into container logs
  - check_service_connectivity() — verify all dependencies
  - check_system_health() — confirm resources aren't exhausted

STEP 3: CHECK KNOWLEDGE BASE
  - query_known_issues_db() — has Doctor seen this before?
  - If found: apply known fix, skip to VERIFY
  - If new: proceed to ATTEMPT FIX

STEP 4: ATTEMPT FIX (orchestrator-mediated)
  - run_fix_script() maps the fix name onto an allow-listed action and
    POSTs it to {ORCHESTRATOR_URL}/remediation (no local script):
    • "connection refused" / crash → restart_container (worker containers only)
    • "OOM killed" → ask admin → restart_container / cleanup_docker [admin]
    • "disk full" → check_disk_usage, then cleanup_docker [admin]
  - Unmapped fix names short-circuit with a clear message (no local exec)

STEP 5: VERIFY
  - verify_fix() — confirm the fix worked
  - If failed: retry once with adjusted approach
  - If still failed: ESCALATE

STEP 6: TRACK & LEARN
  - track_metrics("fix_success_rate") — record outcome
  - save_to_known_issues() — store new knowledge if fix succeeded
  - update ticket status to RESOLVED or ESCALATED

STEP 7: REPORT
  - Report back to user with full diagnosis
  - If escalated: provide pre-filled GitHub issue URL
```

## Advanced Remediation: `run_full_remediation()`

For complex or stubborn errors, use `run_full_remediation()` which tries the
available approaches in sequence:

```
APPROACH 1: Known Issues DB (gateway BookStack)
  → If match found: apply known fix, done

APPROACH 2: Allow-listed remediation
  → run_fix_script() → POST {ORCHESTRATOR_URL}/remediation
  → restart_container / check_disk_usage / cleanup_docker [admin]
  → If one works: done

APPROACH 3: Cross-Worker Invocation (orchestrator relay)
  → Call devops.scale_worker for scaling issues
  → Call qa.run_tests for regression check
  → Call se.read_code for code-level diagnosis

APPROACH 4: Full GitHub Escalation (via /gateway/github)
  → Create issue with all actions tried
  → All failed approaches documented
  → Pre-filled, labeled, ready to submit

NOT in this chain (disabled / gated for safety):
  ✗ Dynamic .ps1/.sh script creation (no local write+exec)
  ✗ Arbitrary config patching (workspace-only, off by default)
```

## Container Discovery Architecture 🔍

Doctor can inspect ALL containers in the system — both workers AND infrastructure services — regardless of whether it has a local Docker socket:

```
┌─────────────────────────────────────────────────────────────┐
│                    CONTAINER DISCOVERY                       │
│                                                             │
│  Doctor (on host)          Doctor (in container)            │
│        │                            │                       │
│        ▼                            ▼                       │
│  docker ps -a              ORCHESTRATOR RELAY               │
│  (local socket)                   │                        │
│        │                     ┌────▼────────┐                │
│        │                     │ /containers │                │
│        │                     │  /containers│                │
│        │                     │   /:name/   │                │
│        │                     │   /logs     │                │
│        └─────────────────────│────────────│────────────────│
│                              └────────────┘                 │
│                                                             │
│  Same API: list_docker_containers()                        │
│            parse_docker_logs(name)                          │
│            get_container_inspect(name)                      │
└─────────────────────────────────────────────────────────────┘
```

**Role Classification** — containers are automatically classified by name/image patterns:

| Pattern | Role |
|---------|------|
| `turing-worker-doctor-*` | doctor |
| `turing-worker-devops-*` | devops |
| `turing-worker-qa-*` | qa |
| `turing-worker-se-*` | software-engineer |
| `turing-orchestrator` | orchestrator |
| `plane-*` / `turing_plane_*` | plane |
| `turing_bookstack` | bookstack |
| `synapse` | matrix |
| `turing_redis` | redis |
| `postgres` | postgres |
| `nginx` | nginx |

---

## Remediation Actions (orchestrator-mediated)

The Doctor worker has **no Docker socket** and runs **no local scripts** (the old
`scripts/doctor-fixes/*.ps1` files were removed). `run_fix_script()` maps a fix
name onto one of the orchestrator's allow-listed actions and `POST`s it to
`{ORCHESTRATOR_URL}/remediation`:

| Action | Notes |
|--------|-------|
| `restart_container` | Restart a worker container (`turing-worker=true` only); worker token OK |
| `check_disk_usage` | Read-only `docker system df`; worker token OK |
| `cleanup_docker` | Prune dangling images/volumes + unused networks; requires `ADMIN_API_TOKEN` |

Unknown actions are rejected (HTTP 400). Every call is audited (`remediation:execute`,
doctor role only).

---

## Severity & SLA

| Severity | Response | Doctor Action |
|----------|----------|---------------|
| **P0** | 15 min | Fix immediately, escalate if blocked |
| **P1** | 1 hour | Attempt fix first, then escalate |
| **P2** | 4 hours | Diagnose and document, then escalate |
| **P3** | 24 hours | Track and schedule fix |

---

## Classification Taxonomy

```
PROJECT_BUG:
  ├── Code bug in Turing OS
  ├── Misconfiguration
  ├── Infrastructure issue
  └── Integration failure

LLM_BUG:
  ├── Hallucination causing wrong action
  ├── Misunderstood requirements
  ├── Wrong logic path taken
  └── Incorrect code generated

USER_ERROR:
  ├── Invalid input data
  ├── Misunderstanding capability
  └── Incorrect usage

INTEGRATION_ERROR:
  ├── External API timeout/failure
  ├── Network connectivity issue
  └── Credential/permission problem
```

---

## GitHub Issue Labels

Doctor uses these labels for systematic bug tracking:

| Label | Usage |
|-------|-------|
| `project-bug` | Turing OS code/configuration issue |
| `llm-bug` | LLM behavior issue |
| `llm-feedback` | Improvement suggestion for LLM |
| `severity-p0` | Critical (system down) |
| `severity-p1` | High (major feature broken) |
| `severity-p2` | Medium (feature degraded) |
| `severity-p3` | Low (minor issue) |

---

## Dashboard Interpretation

```python
# Example dashboard output
{
  "recent_errors": [
    {"container": "turing-orchestrator", "level": "ERROR", "message": "Port 3001 already in use"}
  ],
  "fix_success_rate": 85.5,   # 85.5% of fixes succeed
  "total_fixes_attempted": 200,
  "successful_fixes": 171,
  "failed_fixes": 29,
  "open_escalations_count": 3,
  "system_health_summary": {
    "docker": "running",
    "network": {"plane": "up", "bookstack": "up"},
    "disk_percent": 67,
    "memory_percent": 72.3
  }
}
```

---

## Auto-Remediation Intelligence Map

Doctor has built-in intelligent responses for common error patterns:

All fix actions go through `run_fix_script()` → an allow-listed orchestrator
remediation action (`restart_container` / `check_disk_usage` / `cleanup_docker`).

| Error Pattern | Auto-Detected Cause | Auto-Remediation |
|---|---|---|
| `connection refused` | Service not running | `run_fix_script("restart_container")` |
| `OOM killed` | Memory limit exceeded | `ask_user_confirmation` → `cleanup_docker` [admin] / `restart_container` |
| `port already in use` | Port conflict | Diagnose + escalate (no kill-process action) |
| `disk full` | No space left | `run_fix_script("check_disk_usage")` → `cleanup_docker` [admin] |
| `certificate expired` | SSL cert needs renew | Notify admin with renewal steps |
| `rate limit exceeded` | API throttling | Wait 60s, retry with backoff |
| `404 not found` | Wrong URL or service down | Check connectivity, update endpoint |
| `authentication failed` | Expired credentials | Notify admin to refresh token |

---

## Known Issues DB Schema

Each known issue in BookStack follows this structure:

```markdown
| Field | Value |
| --- | --- |
| Error Key | worker_startup_failure |
| Pattern | exited.*code.*1 |
| Symptoms | Container exits immediately after start |
| Causes | Missing env vars, invalid image, resource limit |
| Fix | Check Docker logs, verify .env, check resource limits |
```

---

## Best Practices for Doctor Development

1. **Every new error type → add to auto-remediation map**
2. **Every fix that works → save to known_issues DB**
3. **Every fix that fails → create GitHub issue immediately**
4. **Never just report → always attempt at least one fix**
5. **Dashboard metrics → reviewed weekly for patterns**
6. **P0 errors → escalate immediately, don't wait for fix attempt**

---

## Key Files

| File | Purpose |
|------|---------|
| `base-worker/src/tools/doctor_tools.py` | All Doctor tools |
| `roles/doctor.md` | Doctor role definition |
| `orchestrator/src/core/remediation.ts` | Allow-listed remediation actions (orchestrator-side) |
| `bookstack_data/doctor/` | BookStack pages (known-issues, metrics) |
