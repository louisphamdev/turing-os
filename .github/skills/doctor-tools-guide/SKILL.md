---
name: doctor-tools-guide
description: **SKILL** — Advanced Doctor Agent tool-building guide. Use when: generating new fix scripts dynamically, patching config files (.env, docker-compose.yml), invoking cross-worker tools, creating self-healing tools on-the-fly. Triggers: "tạo tool mới", "fix config", "sinh tool tự động", "gọi tool worker khác", "dynamic tool creation", "patch config"
file: d:\Source\Project_Turing\turing-os\.github\skills\doctor-tools-guide\SKILL.md
---

# Doctor Tools Guide — Dynamic Tool Building & Config Patching

> Doctor có thể **tự tạo tool mới** khi cần thiết — không chỉ chạy fix script có sẵn, mà còn **sinh ra script fix mới** hoặc **patch config** ngay lập tức.

---

## 1. Dynamic Tool Generation — `create_dynamic_fix_script()`

Doctor có thể tạo script fix mới khi không có script phù hợp trong `scripts/doctor-fixes/`.

### Cách hoạt động

```python
TOOL_CALL: create_dynamic_fix_script
ARGUMENTS: {
  "fix_name": "fix_nginx_502",
  "target_issue": "nginx returns 502 Bad Gateway when upstream is slow",
  "code_content": "docker compose restart nginx\n# Verify\nsleep 3\ncurl -f http://localhost:8080"
}
```

### Luồng hoạt động

```
1. Doctor phát hiện lỗi chưa có fix script
2. Doctor SUY NGHĨ: "Cần fix gì?"
3. Doctor gọi create_dynamic_fix_script() 
   → Tạo script mới trong scripts/doctor-fixes/
4. Doctor gọi run_fix_script(fix_name) 
   → Chạy script vừa tạo
5. Nếu fix thành công 
   → Lưu vào known_issues DB
   → Script mới được ghi nhận
```

---

## 2. Config Patching — `patch_config_file()`

Doctor có thể patch trực tiếp các file config khi lỗi do misconfiguration.

### Supported Config Files

| File | Patching Capability |
|------|---------------------|
| `.env` | Add/change/remove env vars |
| `docker-compose.yml` | Change image, ports, environment, restart policy |
| `taiga.env` | Change Taiga-specific settings |
| `synapse/homeserver.yaml` | Change Matrix/Synapse settings |
| `BookStack` config | Via BookStack API |

### Ví dụ: Patch .env

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": ".env",
  "operation": "set",
  "key": "WORKER_MEMORY_LIMIT",
  "value": "512m"
}
```

### Ví dụ: Patch docker-compose.yml

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": "docker-compose.override.yml",
  "operation": "set",
  "path": "services.orchestrator.environment.WORKER_TIMEOUT",
  "value": "300"
}
```

### Ví dụ: Reset config về mặc định

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": ".env",
  "operation": "reset",
  "key": "WORKER_MEMORY_LIMIT"
}
```

---

## 3. Cross-Worker Tool Invocation — `invoke_worker_tool()`

Doctor có thể gọi **tool từ worker khác** khi cần khả năng đặc biệt.

### Ví dụ: Gọi tool từ DevOps worker

```python
TOOL_CALL: invoke_worker_tool
ARGUMENTS: {
  "target_role": "devops",
  "tool_name": "scale_worker",
  "arguments": {"service": "taiga", "replicas": 3}
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

## 4. Tự Động Tạo Tool Mới — Complete Flow

```
PHÁT HIỆN LỖI MỚI
      │
      ▼
┌─────────────────────┐
│ Có fix script chưa? │
└─────────────────────┘
    KHÔNG
      │
      ▼
┌─────────────────────────────────────────┐
│ 1. ANALYZE: Doctor phân tích lỗi         │
│    → Gọi check_recent_errors()          │
│    → Gọi parse_docker_logs()            │
│    → Xác định root cause                │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 2. GENERATE: Tạo script fix mới          │
│    → create_dynamic_fix_script()        │
│    → Lưu vào scripts/doctor-fixes/       │
│    → verify_python_syntax()             │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 3. EXECUTE: Chạy script vừa tạo          │
│    → run_fix_script(new_fix_name)        │
│    → verify_fix()                       │
└─────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────┐
│ 4. LEARN: Ghi nhận vào known-issues      │
│    → save_to_known_issues()             │
│    → track_metrics("fix_success_rate")   │
│    → Script mới → part of corpus        │
└─────────────────────────────────────────┘
```

---

## 5. Config Patching — Detailed Examples

### 5.1 Fix .env Memory Setting

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": ".env",
  "operation": "set",
  "key": "WORKER_MEMORY_LIMIT",
  "value": "1g"
}
```

### 5.2 Fix Taiga Secret

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": "taiga.env",
  "operation": "set",
  "key": "TAIGA_SECRET_KEY",
  "value": "auto-generated-$(date +%s)"
}
```

### 5.3 Fix Docker Compose Restart Policy

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": "docker-compose.override.yml",
  "operation": "set",
  "path": "services.orchestrator.restart",
  "value": "on-failure:3"
}
```

### 5.4 Reset Config Key

```python
TOOL_CALL: patch_config_file
ARGUMENTS: {
  "file_path": ".env",
  "operation": "reset",
  "key": "DEBUG_MODE"
}
```

---

## 6. Auto-Detection Map — Khi nào Doctor tự tạo tool mới?

| Lỗi Pattern | Doctor Action |
|-------------|---------------|
| Config sai → chưa có script fix | → `patch_config_file()` |
| Lỗi mới, chưa từng thấy | → `create_dynamic_fix_script()` |
| Cần tool từ worker khác | → `invoke_worker_tool()` |
| Script fix cũ không work | → Tạo script mới + `create_dynamic_fix_script()` |
| Lỗi liên quan đến config file | → `patch_config_file()` |

---

## 7. Key Files & References

| File | Purpose |
|------|---------|
| `base-worker/src/tools/doctor_tools.py` | All Doctor tools including new dynamic ones |
| `scripts/doctor-fixes/` | Directory where new scripts are saved |
| `base-worker/src/tools/tool_registry.py` | Cross-worker tool registry |
| `roles/doctor.md` | Doctor role definition |
