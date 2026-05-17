"""Unit tests for the StateBackend abstraction (Plane CE)."""

import importlib
from unittest.mock import patch

import pytest


def reload_module():
    """Force a fresh import so env-var changes are picked up."""
    from src.tools import state_backend
    return importlib.reload(state_backend)


def test_default_backend_is_plane(monkeypatch):
    monkeypatch.delenv("STATE_BACKEND", raising=False)
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "plane"
    assert isinstance(backend, sb.PlaneBackend)


def test_unknown_backend_falls_back_to_plane(monkeypatch):
    monkeypatch.setenv("STATE_BACKEND", "github-projects")
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "plane"


def test_taiga_setting_warns_and_falls_back(monkeypatch):
    """STATE_BACKEND=taiga is no longer a valid choice but must not crash."""
    monkeypatch.setenv("STATE_BACKEND", "taiga")
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "plane"


def test_plane_backend_missing_config_returns_error(monkeypatch):
    """Without gateway env, every call must surface a structured error."""
    for var in ("GATEWAY_URL", "CONSUMER_TOKEN", "PLANE_API_URL", "PLANE_API_TOKEN", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_ID"):
        monkeypatch.delenv(var, raising=False)
    sb = reload_module()
    backend = sb.get_backend()
    result = backend.update_ticket_status("T-1", "DONE", "ok")
    assert result["backend"] == "plane"
    assert "GATEWAY_URL" in result["error"] or "CONSUMER_TOKEN" in result["error"]


def test_state_backend_is_abstract(monkeypatch):
    sb = reload_module()
    with pytest.raises(TypeError):
        sb.StateBackend()  # type: ignore[abstract]


def _configure_plane_env(monkeypatch):
    """Configure the gateway envs that PlaneBackend now relies on."""
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "test.jwt.token")


def test_plane_update_ticket_resolves_state_and_patches(monkeypatch):
    _configure_plane_env(monkeypatch)
    sb = reload_module()
    backend = sb.get_backend()

    def fake_request(method, endpoint, body=None):
        if method == "GET" and endpoint == "/states/":
            return {"results": [
                {"id": "state-todo", "name": "Todo", "group": "unstarted"},
                {"id": "state-progress", "name": "In Progress", "group": "started"},
                {"id": "state-done", "name": "Done", "group": "completed"},
            ]}
        if method == "PATCH" and endpoint == "/issues/T-1/":
            return {"id": "T-1", "state": body["state"]}
        if method == "POST" and endpoint == "/issues/T-1/comments/":
            return {"id": "c1"}
        raise AssertionError(f"unexpected call {method} {endpoint}")

    with patch.object(backend, "_request", side_effect=fake_request):
        result = backend.update_ticket_status("T-1", "IN_PROGRESS", "starting work")

    assert result["state"] == "state-progress"
    assert "comment_error" not in result


def test_plane_read_ticket_normalises(monkeypatch):
    _configure_plane_env(monkeypatch)
    sb = reload_module()
    backend = sb.get_backend()

    raw = {
        "id": "T-1",
        "sequence_id": 42,
        "name": "Fix login bug",
        "description_stripped": "Users can't log in.",
        "state": "state-progress",
        "project": "proj-uuid",
        "assignees": ["u1"],
        "priority": "high",
        "labels": ["bug"],
        "created_at": "2026-05-17T00:00:00Z",
    }
    with patch.object(backend, "_request", return_value=raw):
        result = backend.read_ticket("T-1")

    assert result["id"] == "T-1"
    assert result["title"] == "Fix login bug"
    assert result["description"] == "Users can't log in."
    assert result["status"] == "state-progress"
    assert result["ref"] == 42


def test_plane_list_tickets_with_status_filter(monkeypatch):
    _configure_plane_env(monkeypatch)
    sb = reload_module()
    backend = sb.get_backend()

    calls = []

    def fake_request(method, endpoint, body=None):
        calls.append((method, endpoint))
        if endpoint == "/states/":
            return {"results": [{"id": "state-done", "name": "Done", "group": "completed"}]}
        return {"results": [{"id": "T-9", "name": "Closed", "state": "state-done"}]}

    with patch.object(backend, "_request", side_effect=fake_request):
        result = backend.list_tickets(status="DONE")

    assert result["tickets"][0]["id"] == "T-9"
    list_calls = [c for c in calls if c[1].startswith("/issues/")]
    assert list_calls and "state=state-done" in list_calls[0][1]


def test_plane_add_comment_posts_to_comments_endpoint(monkeypatch):
    _configure_plane_env(monkeypatch)
    sb = reload_module()
    backend = sb.get_backend()

    with patch.object(backend, "_request", return_value={"id": "c1"}) as mock_req:
        result = backend.add_comment("T-1", "looks good")

    assert result["id"] == "c1"
    mock_req.assert_called_once()
    args, kwargs = mock_req.call_args
    method, endpoint = args[0], args[1]
    assert method == "POST"
    assert endpoint == "/issues/T-1/comments/"


def test_plane_resolve_state_unknown_status_returns_none(monkeypatch):
    _configure_plane_env(monkeypatch)
    sb = reload_module()
    backend = sb.get_backend()

    with patch.object(backend, "_request", return_value={"results": [
        {"id": "state-todo", "name": "Todo", "group": "unstarted"},
    ]}):
        result = backend.update_ticket_status("T-1", "ABANDONED", "")
    assert "could not resolve Plane state" in result["error"]
