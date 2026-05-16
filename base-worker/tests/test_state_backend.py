"""Unit tests for the StateBackend abstraction (phase 1 of Taiga->Plane)."""

import importlib
import os

import pytest


def reload_module():
    """Force a fresh import so env-var changes are picked up."""
    from src.tools import state_backend
    return importlib.reload(state_backend)


def test_default_backend_is_taiga(monkeypatch):
    monkeypatch.delenv("STATE_BACKEND", raising=False)
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "taiga"
    assert isinstance(backend, sb.TaigaBackend)


def test_plane_backend_via_env(monkeypatch):
    monkeypatch.setenv("STATE_BACKEND", "plane")
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "plane"
    assert isinstance(backend, sb.PlaneBackend)


def test_unknown_backend_falls_back_to_taiga(monkeypatch):
    monkeypatch.setenv("STATE_BACKEND", "github-projects")
    sb = reload_module()
    backend = sb.get_backend()
    assert backend.name == "taiga"


def test_plane_backend_returns_structured_error(monkeypatch):
    monkeypatch.setenv("STATE_BACKEND", "plane")
    sb = reload_module()
    backend = sb.get_backend()
    result = backend.update_ticket_status("T-1", "DONE", "ok")
    assert result["backend"] == "plane"
    assert "not yet implemented" in result["error"]


def test_state_backend_is_abstract(monkeypatch):
    sb = reload_module()
    with pytest.raises(TypeError):
        sb.StateBackend()  # type: ignore[abstract]
