---
name: doctor
description: **SKILL** — Doctor Agent diagnostic & self-healing toolkit for Turing OS. Use when: diagnosing errors, fixing system issues, checking Docker/container health, querying known issues database, running self-healing scripts, tracking fix metrics, or generating GitHub issues. Triggers: "doctor", "diagnose", "fix error", "system health", "self-heal", "container crashed", "service down"
file: d:\Source\Project_Turing\turing-os\.github\skills\doctor\SKILL.md
---

# Doctor Agent Skill — Diagnostic & Self-Healing Toolkit

> ⚡ Doctor is the **crown jewel** of Turing OS — the autonomous system doctor that runs 24/7, diagnoses failures, attempts self-healing, escalates intelligently, and learns from every incident.

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
Test if a service (taiga, wiki, matrix, context7, github, orchestrator) is up/degraded/down.

```python
TOOL_CALL: check_service_connectivity
ARGUMENTS: {"service_name": "taiga"}
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
Create a structured GitHub issue. Token fetched from BookStack `/api/secrets/doctor-github-token` first.

```python
TOOL_CALL: create_github_issue
ARGUMENTS: {"title": "[Bug] Worker OOM on large file upload", "body": "## Error Summary\n...", "labels": ["project-bug", "severity-p1"]}
```

### 8. `run_fix_script(fix_name)` 🔧
Execute a self-healing script from `scripts/doctor-fixes/`. Supports `.ps1` and `.sh`.

```python
TOOL_CALL: run_fix_script
ARGUMENTS: {"fix_name": "restart_container"}
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

### 13. `run_self_healing_pipeline(error_description)` 🌟 **CROWN JEWEL**
**ONE TOOL TO RULE THEM ALL.** Orchestrates the full self-healing workflow:
diagnose → check known issues → attempt fix → verify → track → report.

```python
TOOL_CALL: run_self_healing_pipeline
ARGUMENTS: {"error_description": "Container turing-orchestrator keeps restarting with exit code 137"}
```

### 14. `run_full_remediation(error_description, container_name)` 🚀
**FULL auto-remediation** — tries ALL approaches in sequence:
1. Known Issues DB → 2. Existing fix scripts → 3. Dynamic script creation → 4. Config patching → 5. Cross-worker tools → 6. GitHub escalation

```python
TOOL_CALL: run_full_remediation
ARGUMENTS: {"error_description": "Container keeps crashing", "container_name": "turing-orchestrator"}
```

### 15. `create_dynamic_fix_script(fix_name, target_issue, code_content, language)` 🔨
**Create a new fix script on-the-fly** when no existing script fits the error.
Syntax is verified before saving. Script is saved to `scripts/doctor-fixes/`.

```python
TOOL_CALL: create_dynamic_fix_script
ARGUMENTS: {"fix_name": "fix_nginx_502", "target_issue": "nginx 502 error", "code_content": "docker compose restart nginx"}
```

### 16. `patch_config_file(file_path, operation, key, value, path)` ⚙️
**Patch config files in-place**: `.env`, `docker-compose.yml`, `.json`, `.yaml`.
Supports `set`, `append`, `remove`, `reset` operations. No restart needed.

```python
# Patch .env
TOOL_CALL: patch_config_file
ARGUMENTS: {"file_path": ".env", "operation": "set", "key": "WORKER_MEMORY_LIMIT", "value": "1g"}

# Patch YAML (dot-path notation)
TOOL_CALL: patch_config_file
ARGUMENTS: {"file_path": "docker-compose.override.yml", "operation": "set", "path": "services.orchestrator.restart", "value": "on-failure:3"}
```

### 17. `invoke_worker_tool(target_role, tool_name, arguments)` 🌐
**Call a tool from another worker role** via orchestrator relay.
Used when the fix requires capabilities from devops, qa, se, or pm workers.

```python
# Scale via DevOps worker
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {"target_role": "devops", "tool_name": "scale_worker", "arguments": {"service": "taiga", "replicas": 3}}

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

STEP 4: ATTEMPT FIX
  - Run the appropriate fix script via run_fix_script()
  - If no script exists: attempt intelligent remediation
    • "connection refused" → restart the service
    • "OOM killed" → suggest memory limit increase
    • "port already in use" → find and kill the conflicting process
    • "disk full" → clean up old Docker resources

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

For complex or stubborn errors, use `run_full_remediation()` which tries **all approaches**:

```
APPROACH 1: Known Issues DB
  → If match found: apply known fix, done

APPROACH 2: Existing Fix Scripts (top 3)
  → If one works: done

APPROACH 3: Dynamic Script Creation
  → Generate new .ps1 based on error type
  → Verify syntax → save → run
  → If works: save to known-issues DB

APPROACH 4: Config Patching
  → Patch .env / docker-compose.yml / .json / .yaml
  → No restart needed

APPROACH 5: Cross-Worker Invocation
  → Call devops.scale_worker for scaling issues
  → Call qa.run_tests for regression check
  → Call se.read_code for code-level diagnosis

APPROACH 6: Full GitHub Escalation
  → Create issue with all actions tried
  → All failed approaches documented
  → Pre-filled, labeled, ready to submit
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
| `turing_taiga_*` | taiga |
| `turing_wiki` | wiki |
| `synapse` | matrix |
| `turing_redis` | redis |
| `postgres` | postgres |
| `nginx` | nginx |

---

## Fix Script Directory

```
scripts/doctor-fixes/
├── restart_container.ps1     # Restart a specific container
├── cleanup_docker.ps1        # Clean up dangling volumes/networks
├── increase_memory.ps1        # Increase container memory limit
├── restart_service.ps1       # Restart a Docker Compose service
├── check_disk_usage.ps1      # Report disk usage and cleanup targets
└── reset_network.ps1         # Reset Docker networking
```

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
    "network": {"taiga": "up", "wiki": "up"},
    "disk_percent": 67,
    "memory_percent": 72.3
  }
}
```

---

## Auto-Remediation Intelligence Map

Doctor has built-in intelligent responses for common error patterns:

| Error Pattern | Auto-Detected Cause | Auto-Remediation |
|---|---|---|
| `connection refused` | Service not running | `run_fix_script("restart_service")` |
| `OOM killed` | Memory limit exceeded | `ask_user_confirmation` → increase limit |
| `port already in use` | Port conflict | Kill process using that port |
| `disk full` | No space left | `run_fix_script("cleanup_docker")` |
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
| `scripts/doctor-fixes/` | Self-healing fix scripts |
| `wiki_data/doctor/` | BookStack pages (known-issues, metrics) |
