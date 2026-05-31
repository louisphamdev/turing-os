"""Remediation-routing & safety coverage for doctor_tools (Task P4d).

The Doctor worker has NO docker CLI/socket. All docker control must route
through the orchestrator's allow-listed, audited remediation API:

  * run_fix_script POSTs to {ORCHESTRATOR_URL}/remediation with the mapped
    action and `Bearer {CONSUMER_TOKEN}` (restart_container, check_disk_usage).
  * An unmapped fix name returns an "escalate to human" result WITHOUT any HTTP.
  * verify_fix queries {ORCHESTRATOR_URL}/containers (relay) — never a shell.
  * create_dynamic_fix_script is disabled and writes NO file.
  * patch_config_file rejects absolute/`..` paths and is disabled unless
    DOCTOR_ALLOW_CONFIG_PATCH=true.

Hermetic: no network, no docker, no filesystem writes. src/ is added to the
path to match the worker runtime import root (`from tools import ...`).
"""

import importlib
import os
import sys
from unittest.mock import MagicMock, patch

# Match the worker runtime import root: `from tools import ...`.
_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from tools import doctor_tools  # noqa: E402


def _fake_response(status_code=200, json_body=None, content=b"{}", text=""):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.json.return_value = json_body if json_body is not None else {}
    resp.text = text
    return resp


def _reload_with_orchestrator(monkeypatch):
    """Reload doctor_tools so module-level ORCHESTRATOR_URL/CONSUMER_TOKEN
    pick up the test env."""
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")
    return importlib.reload(doctor_tools)


# ─── run_fix_script → /remediation (mapped actions) ────────────────────────────

def test_run_fix_script_restart_container_posts_remediation(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _fake_response(
            status_code=200,
            json_body={"action": "restart_container", "ok": True, "detail": "restarted T-9"},
        )

    try:
        with patch("requests.post", side_effect=fake_post):
            result = dt.run_fix_script("restart_container", target="T-9")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is True
    assert result["action"] == "restart_container"
    assert "restarted" in result["output"]
    assert captured["url"] == "http://orchestrator:3001/remediation"
    assert captured["json"] == {"action": "restart_container", "target": "T-9"}
    assert captured["headers"]["Authorization"] == "Bearer consumer.jwt.token"


def test_run_fix_script_restart_service_aliases_to_restart_container(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["json"] = json
        return _fake_response(json_body={"action": "restart_container", "ok": True, "detail": "ok"})

    try:
        with patch("requests.post", side_effect=fake_post):
            result = dt.run_fix_script("restart_service", target="orch")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is True
    assert captured["json"]["action"] == "restart_container"


def test_run_fix_script_check_disk_usage_posts_remediation(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        return _fake_response(
            status_code=200,
            json_body={"action": "check_disk_usage", "ok": True, "detail": "images=3", "data": {"images": {"count": 3}}},
        )

    try:
        with patch("requests.post", side_effect=fake_post):
            result = dt.run_fix_script("check_disk_usage")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is True
    assert result["action"] == "check_disk_usage"
    # No target → not in payload.
    assert captured["json"] == {"action": "check_disk_usage"}
    assert captured["url"] == "http://orchestrator:3001/remediation"
    assert captured["headers"]["Authorization"] == "Bearer consumer.jwt.token"


def test_run_fix_script_cleanup_docker_admin_401_escalates(monkeypatch):
    """cleanup_docker needs admin; a worker token gets 401 → clear escalate
    result, no crash."""
    dt = _reload_with_orchestrator(monkeypatch)

    def fake_post(url, json=None, headers=None, timeout=None):
        return _fake_response(status_code=401, text="admin token required")

    try:
        with patch("requests.post", side_effect=fake_post):
            result = dt.run_fix_script("cleanup_docker")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is False
    assert result["status_code"] == 401
    assert "admin" in result["error"].lower()


def test_run_fix_script_unmapped_name_escalates_without_http(monkeypatch):
    """Unmapped fix names need infra access the worker lacks → escalate, and
    crucially NO HTTP call is attempted."""
    dt = _reload_with_orchestrator(monkeypatch)

    called = {"posts": 0}

    def fake_post(*a, **k):
        called["posts"] += 1
        return _fake_response()

    try:
        with patch("requests.post", side_effect=fake_post):
            for name in ("restart_docker", "reset_network", "increase_memory"):
                result = dt.run_fix_script(name)
                assert result["success"] is False
                assert "escalate to human" in result["error"]
    finally:
        importlib.reload(doctor_tools)

    assert called["posts"] == 0


def test_run_fix_script_requires_orchestrator_env(monkeypatch):
    for var in ("ORCHESTRATOR_URL", "CONSUMER_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    # ORCHESTRATOR_URL has a non-empty default; null out CONSUMER_TOKEN only.
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3001")
    monkeypatch.delenv("CONSUMER_TOKEN", raising=False)
    dt = importlib.reload(doctor_tools)

    try:
        # A mapped action with no CONSUMER_TOKEN → guarded, no HTTP.
        with patch("requests.post", side_effect=AssertionError("must not POST")):
            result = dt.run_fix_script("restart_container", target="x")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is False
    assert "CONSUMER_TOKEN" in result["error"]


# ─── verify_fix → /containers relay (no shell) ─────────────────────────────────

def test_verify_fix_queries_containers_relay_running(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)
    captured = {}

    def fake_get(url, headers=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        return _fake_response(
            status_code=200,
            json_body={"total": 1, "containers": [
                {"name": "turing-worker-T-9", "state": "running", "status": "Up 3m"},
            ]},
        )

    # If verify_fix ever shelled out, this would explode the test.
    with patch("subprocess.run", side_effect=AssertionError("verify_fix must not shell out")):
        try:
            with patch("requests.get", side_effect=fake_get):
                result = dt.verify_fix("confirm container turing-worker-T-9 running", "turing-worker-T-9")
        finally:
            importlib.reload(doctor_tools)

    assert result["success"] is True
    assert result["matches"] is True
    assert result["state"] == "running"
    assert captured["url"] == "http://orchestrator:3001/containers"
    assert captured["headers"]["Authorization"] == "Bearer consumer.jwt.token"


def test_verify_fix_reports_not_running_when_stopped(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)

    def fake_get(url, headers=None, timeout=None):
        return _fake_response(
            status_code=200,
            json_body={"containers": [{"name": "svc", "state": "exited", "status": "Exited (1)"}]},
        )

    try:
        with patch("requests.get", side_effect=fake_get):
            result = dt.verify_fix("x", "svc")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is False
    assert result["state"] == "exited"


def test_verify_fix_not_found_returns_clear_failure(monkeypatch):
    dt = _reload_with_orchestrator(monkeypatch)

    def fake_get(url, headers=None, timeout=None):
        return _fake_response(status_code=200, json_body={"containers": []})

    try:
        with patch("requests.get", side_effect=fake_get):
            result = dt.verify_fix("x", "ghost")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is False
    assert "not found" in result["actual_output"]


# ─── create_dynamic_fix_script: disabled, writes nothing ───────────────────────

def test_create_dynamic_fix_script_disabled_writes_no_file():
    # Any attempt to open a file for writing would fail the test.
    with patch("builtins.open", side_effect=AssertionError("must not write a file")), \
         patch("subprocess.run", side_effect=AssertionError("must not exec")):
        result = doctor_tools.create_dynamic_fix_script(
            fix_name="evil",
            target_issue="x",
            code_content="rm -rf /",
            language="bash",
        )

    assert result["success"] is False
    assert result["disabled"] is True
    assert "disabled" in result["message"].lower()


# ─── patch_config_file: gated + path-contained ─────────────────────────────────

def test_patch_config_file_disabled_without_optin(monkeypatch):
    monkeypatch.delenv("DOCTOR_ALLOW_CONFIG_PATCH", raising=False)
    # Even a syntactically fine relative path is refused without opt-in, and no
    # file is touched.
    with patch("builtins.open", side_effect=AssertionError("must not touch files")):
        result = doctor_tools.patch_config_file("config.env", "set", key="K", value="V")
    assert result["success"] is False
    assert result.get("disabled") is True


def test_patch_config_file_rejects_absolute_path(monkeypatch):
    monkeypatch.setenv("DOCTOR_ALLOW_CONFIG_PATCH", "true")
    try:
        with patch("builtins.open", side_effect=AssertionError("must not touch files")):
            result = doctor_tools.patch_config_file("/etc/passwd", "set", key="x", value="y")
    finally:
        monkeypatch.delenv("DOCTOR_ALLOW_CONFIG_PATCH", raising=False)
    assert result["success"] is False
    assert "absolute" in result["error"].lower()


def test_patch_config_file_rejects_traversal(monkeypatch):
    monkeypatch.setenv("DOCTOR_ALLOW_CONFIG_PATCH", "true")
    try:
        with patch("builtins.open", side_effect=AssertionError("must not touch files")):
            result = doctor_tools.patch_config_file("../../etc/hosts", "set", key="x", value="y")
    finally:
        monkeypatch.delenv("DOCTOR_ALLOW_CONFIG_PATCH", raising=False)
    assert result["success"] is False
    assert "escapes" in result["error"].lower() or "traversal" in result["error"].lower()


def test_patch_config_file_rejects_append_op(monkeypatch):
    monkeypatch.setenv("DOCTOR_ALLOW_CONFIG_PATCH", "true")
    try:
        with patch("builtins.open", side_effect=AssertionError("must not touch files")):
            result = doctor_tools.patch_config_file("config.env", "append", value="# line")
    finally:
        monkeypatch.delenv("DOCTOR_ALLOW_CONFIG_PATCH", raising=False)
    assert result["success"] is False
    assert "append" in result["error"].lower()
