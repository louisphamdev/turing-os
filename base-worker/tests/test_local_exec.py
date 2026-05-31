"""Unit tests for the hardened worker terminal tool (Task P2-2).

Covers two guarantees added by P2-2:
  * `working_dir` is contained inside WORKSPACE_ROOT (escapes are rejected,
    not executed);
  * the child-process environment is sanitized so live secrets
    (CONSUMER_TOKEN, PLANE_API_TOKEN, ...) are stripped while PATH etc. remain.

Hermetic: the env-sanitizer is unit-tested directly, and the containment
tests point WORKSPACE_ROOT at a real temp dir so they do not depend on
/workspace existing on the host.
"""

import pytest

from src.tools import local_exec
from src.tools.local_exec import (
    _SENSITIVE_ENV_KEYS,
    _sanitized_env,
    execute_terminal_command,
)


# ─── Sanitized environment ──────────────────────────────────────────────────

def test_sanitized_env_strips_sensitive_keys(monkeypatch):
    """Secrets present in os.environ are absent from the sanitized copy."""
    monkeypatch.setenv("CONSUMER_TOKEN", "jwt-secret-value")
    monkeypatch.setenv("PLANE_API_TOKEN", "plane-secret-value")
    monkeypatch.setenv("LLM_API_KEY", "llm-secret-value")
    monkeypatch.setenv("WORKER_INTERNAL_TOKEN", "internal-secret-value")

    env = _sanitized_env()

    assert "CONSUMER_TOKEN" not in env
    assert "PLANE_API_TOKEN" not in env
    assert "LLM_API_KEY" not in env
    assert "WORKER_INTERNAL_TOKEN" not in env


def test_sanitized_env_strips_every_sensitive_key(monkeypatch):
    """Every key in the denylist is removed even when all are set."""
    for key in _SENSITIVE_ENV_KEYS:
        monkeypatch.setenv(key, f"value-for-{key}")

    env = _sanitized_env()

    assert _SENSITIVE_ENV_KEYS.isdisjoint(env.keys())


def test_sanitized_env_keeps_non_sensitive_keys(monkeypatch):
    """Non-secret variables (PATH and friends) survive sanitization."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/home/worker")
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.setenv("CONSUMER_TOKEN", "should-be-removed")

    env = _sanitized_env()

    assert env.get("PATH") == "/usr/bin:/bin"
    assert env.get("HOME") == "/home/worker"
    assert env.get("LANG") == "en_US.UTF-8"
    assert "CONSUMER_TOKEN" not in env


# ─── working_dir containment ────────────────────────────────────────────────

@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Point WORKSPACE_ROOT at a real temp dir for hermetic containment tests."""
    root = (tmp_path / "workspace").resolve()
    root.mkdir()
    monkeypatch.setattr(local_exec, "WORKSPACE_ROOT", root)
    return root


def test_command_runs_with_working_dir_inside_workspace(workspace):
    """A working_dir inside the workspace is accepted and the command runs."""
    sub = workspace / "proj"
    sub.mkdir()

    out = execute_terminal_command("echo hardened-ok", working_dir=str(sub))

    assert "hardened-ok" in out
    assert not out.startswith("Error:")


def test_command_defaults_to_workspace_root_when_dir_empty(workspace):
    """Empty working_dir defaults to the workspace root rather than failing."""
    out = execute_terminal_command("echo default-ok", working_dir="")

    assert "default-ok" in out
    assert not out.startswith("Error:")


def test_command_rejects_absolute_escape(workspace):
    """An absolute working_dir outside the workspace (/etc) is rejected."""
    out = execute_terminal_command("echo should-not-run", working_dir="/etc")

    assert out.startswith("Error:")
    assert "escapes workspace" in out
    assert "should-not-run" not in out


def test_command_rejects_dotdot_traversal(workspace):
    """A `../../` traversal escaping the workspace is rejected, not executed."""
    out = execute_terminal_command("echo should-not-run", working_dir="../../")

    assert out.startswith("Error:")
    assert "escapes workspace" in out
    assert "should-not-run" not in out


def test_command_env_does_not_leak_secrets(workspace, monkeypatch):
    """A command that dumps the environment does not see the stripped secrets."""
    monkeypatch.setenv("CONSUMER_TOKEN", "LEAK_CONSUMER_TOKEN_MARKER")
    monkeypatch.setenv("PLANE_API_TOKEN", "LEAK_PLANE_API_TOKEN_MARKER")

    # Use a portable env dump; `env`/`printenv` may be absent on some hosts,
    # so fall back to a python one-liner if needed.
    out = execute_terminal_command("env || printenv || python -c \"import os;print(os.environ)\"")

    assert "LEAK_CONSUMER_TOKEN_MARKER" not in out
    assert "LEAK_PLANE_API_TOKEN_MARKER" not in out
