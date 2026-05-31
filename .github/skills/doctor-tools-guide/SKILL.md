---
name: doctor-tools-guide
description: **SKILL** — Doctor Agent remediation guide. Use when: running allow-listed remediation via the orchestrator, invoking cross-worker tools, or understanding why dynamic-script creation / arbitrary config patching are disabled. Triggers: "remediation", "restart container", "fix config", "gọi tool worker khác", "patch config", "orchestrator remediation"
---

# Doctor Tools Guide — Orchestrator-Mediated Remediation & Cross-Worker Tools

> Fix execution is **orchestrator-mediated**: Doctor's `run_fix_script()` maps a
> fix name onto an **allow-listed** action and `POST`s it to
> `{ORCHESTRATOR_URL}/remediation`, where the orchestrator runs it via Dockerode
> with audit + RBAC. The worker has **no Docker socket** and runs **no local
> scripts**. Dynamic fix-script creation is **disabled** and arbitrary config
> patching is **gated** — both for safety.

---

## 1. Allow-Listed Remediation — `run_fix_script(fix_name, target)`

The only way Doctor executes a fix. `run_fix_script()` maps a fix name onto one of
the orchestrator's closed allow-list of actions and `POST`s it to
`{ORCHESTRATOR_URL}/remediation` with the worker's `CONSUMER_TOKEN`.

| Action | Notes |
|--------|-------|
| `restart_container` | Restart a worker container (`turing-worker=true` only) by ticketId/name; worker token OK |
| `check_disk_usage` | Read-only `docker system df`; worker token OK |
| `cleanup_docker` | Prune dangling images/volumes + unused networks; requires `ADMIN_API_TOKEN` |

Fix-name mappings: `restart_container` / `restart_service` / `restart_pm` →
`restart_container`; `check_disk_usage` → `check_disk_usage`; `cleanup_docker` →
`cleanup_docker` (admin). Unknown actions are rejected (HTTP 400); unmapped fix
names short-circuit with a clear message.

```python
# Restart a crashed worker container
TOOL_CALL: run_fix_script
ARGUMENTS: {"fix_name": "restart_container", "target": "ticket-42"}

# Read-only disk usage
TOOL_CALL: run_fix_script
ARGUMENTS: {"fix_name": "check_disk_usage"}
```

### Luồng hoạt động

```
1. Doctor phát hiện lỗi → diagnose (parse_docker_logs, check_recent_errors)
2. Doctor chọn action allow-listed phù hợp (restart_container / check_disk_usage / cleanup_docker)
3. run_fix_script(fix_name, target)
   → POST {ORCHESTRATOR_URL}/remediation (CONSUMER_TOKEN)
   → orchestrator chạy action bằng Dockerode, audit + RBAC
4. verify_fix() → confirm
5. Nếu fix thành công → save_to_known_issues() (gateway BookStack)
   Nếu không có action phù hợp → escalate (create_github_issue via /gateway/github)
```

---

## 2. Dynamic Tool Generation — DISABLED for safety

`create_dynamic_fix_script()` used to write an LLM-generated `.ps1`/`.sh` into
`scripts/doctor-fixes/` and execute it locally. That local write+exec path is
unsafe and now has **no consumer** — `run_fix_script` no longer runs local
scripts. The function is kept inert (writes nothing, executes nothing) and returns
`{ disabled: true }`. When no allow-listed action fits, **escalate to a human**
via `create_github_issue`.

---

## 3. Config Patching — `patch_config_file()` — GATED, off by default

`patch_config_file()` returns disabled unless `DOCTOR_ALLOW_CONFIG_PATCH=true`.
Even when enabled it is **workspace-only**: absolute paths and `..` traversal are
rejected, and the worker only mounts `/workspace`, so the host
repo/compose/`.env`/`synapse/homeserver.yaml` are **not reachable**. Host config
changes must be escalated to a human / DevOps. Supported ops when enabled:
`set`, `remove`, `reset` (`append` is rejected).

```python
# Disabled by default — returns { disabled: true, needs_confirmation: true }
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": ".env",
  "operation": "set",
  "key": "WORKER_MEMORY_LIMIT",
  "value": "512m"
}
```

---

## 4. Cross-Worker Tool Invocation — `invoke_worker_tool()`

Doctor có thể gọi **tool từ worker khác** khi cần khả năng đặc biệt.

### Ví dụ: Gọi tool từ DevOps worker

```python
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {
  "target_role": "devops",
  "tool_name": "scale_worker",
  "arguments": {"service": "plane", "replicas": 3}
}
```

### Ví dụ: Gọi tool từ QA worker

```python
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {
  "target_role": "qa",
  "tool_name": "run_tests",
  "arguments": {"test_suite": "integration", "fail_fast": true}
}
```

### Supported Cross-Worker Calls

| Target Role | Available Tools Doctor Can Call |
|-------------|--------------------------------|
| `devops` | `scale_worker`, `restart_service`, `check_resource_usage` |
| `qa` | `run_tests`, `check_coverage`, `generate_report` |
| `se` | `read_code`, `analyze_code`, `suggest_refactor` |
| `pm` | `update_ticket`, `get_sprint_status`, `create_task` |

---

## 5. Remediation Flow — Complete

```
PHÁT HIỆN LỖI
      │
      ▼
┌─────────────────────────────────────────┐
│ 1. ANALYZE: Doctor phân tích lỗi         │
│    → check_recent_errors()              │
│    → parse_docker_logs() (via relay)    │
│    → Xác định root cause                │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 2. KNOWN ISSUES (gateway BookStack)      │
│    → query_known_issues_db()            │
│    → Match? apply known fix             │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 3. REMEDIATE (allow-listed)              │
│    → run_fix_script(fix_name, target)    │
│    → POST {ORCHESTRATOR_URL}/remediation │
│       restart_container / check_disk_    │
│       usage / cleanup_docker [admin]    │
│    → orchestrator chạy = Dockerode + audit│
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 4. VERIFY & LEARN                        │
│    → verify_fix()                       │
│    → save_to_known_issues() (gateway BS) │
│    → track_metrics("fix_success_rate")   │
│    → Không fix được? escalate            │
│       create_github_issue (/gateway/github)│
└─────────────────────────────────────────┘
```

---

## 6. Auto-Detection Map — Doctor chọn action nào?

| Lỗi Pattern | Doctor Action |
|-------------|---------------|
| Container crash / unhealthy | → `run_fix_script("restart_container", target)` |
| Disk pressure / disk full | → `run_fix_script("check_disk_usage")` → `cleanup_docker` [admin] |
| Cần khả năng từ worker khác | → `invoke_worker_tool()` |
| Lỗi mới, không có action phù hợp | → escalate: `create_github_issue()` (KHÔNG tạo script mới — đã disabled) |
| Cần đổi host config | → escalate to human / DevOps (`patch_config_file` gated, workspace-only) |

---

## 7. Key Files & References

| File | Purpose |
|------|---------|
| `base-worker/src/tools/doctor_tools.py` | All Doctor tools (incl. disabled `create_dynamic_fix_script`, gated `patch_config_file`) |
| `orchestrator/src/core/remediation.ts` | Allow-listed remediation actions (orchestrator-side, Dockerode + audit) |
| `base-worker/src/tools/tool_registry.py` | Cross-worker tool registry |
| `roles/doctor.md` | Doctor role definition |
