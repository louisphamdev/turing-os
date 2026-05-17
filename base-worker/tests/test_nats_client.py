"""Unit tests for the worker NATS client helpers (phase 2 of Matrix->NATS)."""

import importlib
import os
import sys


def reload_module():
    """Force a fresh import so env-var changes are picked up."""
    if "src.tools.nats_client" in sys.modules:
        return importlib.reload(sys.modules["src.tools.nats_client"])
    from src.tools import nats_client
    return nats_client


def test_worker_subject_canonical():
    """Role is lowercased, ticket preserved — must match orchestrator NatsService.workerSubject."""
    nc = reload_module()
    assert nc.worker_subject("software-engineer", "TASK-1", "event") == "turing.worker.software-engineer.TASK-1.event"


def test_worker_subject_sanitises():
    nc = reload_module()
    assert nc.worker_subject("Software Engineer!", "task/with spaces", "inbox") == "turing.worker.software-engineer-.task-with-spaces.inbox"


def test_worker_subject_falls_back_to_unknown():
    nc = reload_module()
    assert nc.worker_subject("", "", "heartbeat") == "turing.worker.unknown.unknown.heartbeat"


def test_worker_inbox_subject_matches_orchestrator():
    """Orchestrator publishes to `turing.worker.any.<ticket>.inbox` (ticket preserved verbatim)."""
    nc = reload_module()
    assert nc.worker_inbox_subject("T-99") == "turing.worker.any.T-99.inbox"


def test_start_subscriber_disabled_by_default(monkeypatch):
    monkeypatch.delenv("WORKER_NATS_SUBSCRIBE", raising=False)
    nc = reload_module()
    assert nc.start_subscriber("T-1", "se") is None


def test_start_subscriber_false_returns_none(monkeypatch):
    monkeypatch.setenv("WORKER_NATS_SUBSCRIBE", "false")
    nc = reload_module()
    assert nc.start_subscriber("T-1", "se") is None


def test_dedup_marks_duplicate_event_ids():
    nc = reload_module()
    client = nc.WorkerNatsClient(ticket_id="T-1", role="se")
    assert client.mark_event_seen("evt-1") is False
    assert client.mark_event_seen("evt-1") is True
    assert client.mark_event_seen("evt-2") is False


def test_dedup_ignores_blank_event_ids():
    nc = reload_module()
    client = nc.WorkerNatsClient(ticket_id="T-1", role="se")
    # Blank event id never marks duplicate (caller decides what to do).
    assert client.mark_event_seen("") is False
    assert client.mark_event_seen("") is False


def test_drain_inbox_empty_returns_empty_list():
    nc = reload_module()
    client = nc.WorkerNatsClient(ticket_id="T-1", role="se")
    assert client.drain_inbox() == []


def test_drain_inbox_returns_queued_messages():
    nc = reload_module()
    client = nc.WorkerNatsClient(ticket_id="T-1", role="se")
    client._inbox_queue.put({"sender": "admin", "content": "hi", "eventId": "e1"})
    client._inbox_queue.put({"sender": "admin", "content": "bye", "eventId": "e2"})
    drained = client.drain_inbox()
    assert len(drained) == 2
    assert drained[0]["eventId"] == "e1"
    # Queue should be empty after drain.
    assert client.drain_inbox() == []
