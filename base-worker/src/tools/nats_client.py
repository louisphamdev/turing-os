"""
NATS subscriber + publisher for workers (Phase 2 of Matrix->NATS migration).

Workers opt-in by setting WORKER_NATS_SUBSCRIBE=true. When enabled, the
worker subscribes to its inbox subject and receives admin->worker messages
without HTTP polling. The HTTP inbox remains the source of truth — NATS is
a complementary path. Messages are deduplicated by eventId at the worker
side, so dual-consumption is safe.

Subject layout matches orchestrator's NatsService.workerSubject:
  turing.worker.<role>.<ticketId>.inbox      — admin->worker messages
  turing.worker.<role>.<ticketId>.heartbeat  — heartbeat events
  turing.worker.<role>.<ticketId>.event      — generic worker events

The orchestrator currently publishes worker-bound inbox messages using role
literal "any" (see matrix.ts pushToWorkerInbox), so subscribers should listen
on the wildcard role token.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from queue import Queue
from typing import Any, Optional


def worker_subject(role: str, ticket_id: str, kind: str) -> str:
    """Encode a worker-scoped subject. Mirrors orchestrator's sanitisation."""
    safe_role = re.sub(r"[^a-zA-Z0-9_-]", "-", role).lower() or "unknown"
    safe_ticket = re.sub(r"[^a-zA-Z0-9_-]", "-", ticket_id) or "unknown"
    return f"turing.worker.{safe_role}.{safe_ticket}.{kind}"


def worker_inbox_subject(ticket_id: str) -> str:
    """Subject that the orchestrator publishes admin->worker messages to."""
    return worker_subject("any", ticket_id, "inbox")


class WorkerNatsClient:
    """Background NATS subscriber + publisher for a single worker.

    Runs an asyncio loop on a dedicated thread so the rest of the worker
    (which is synchronous) can interact via a Queue and `publish_sync`.
    """

    def __init__(
        self,
        ticket_id: str,
        role: str,
        nats_url: Optional[str] = None,
    ) -> None:
        self.ticket_id = ticket_id
        self.role = role
        self.nats_url = nats_url or os.environ.get("NATS_URL", "nats://nats:4222")
        self._inbox_queue: Queue = Queue()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._nc: Any = None
        self._stop_event = threading.Event()
        self._connected = threading.Event()
        self._seen_event_ids: set[str] = set()
        self._seen_lock = threading.Lock()

    # ─── Lifecycle ─────────────────────────────────────────────────────────

    def start(self) -> bool:
        """Start the background loop. Returns False if nats-py is unavailable."""
        try:
            import nats  # noqa: F401
        except ImportError:
            print("[NATS] nats-py not installed — worker NATS subscribe disabled")
            return False

        if self._thread is not None:
            return True

        self._thread = threading.Thread(target=self._run, daemon=True, name="nats-worker")
        self._thread.start()

        # Wait briefly for connect so callers can decide whether to fall back.
        connected = self._connected.wait(timeout=5.0)
        if not connected:
            print("[NATS] Connect did not complete within 5s — falling back to HTTP polling")
        return connected

    def stop(self) -> None:
        self._stop_event.set()
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=3.0)

    def is_connected(self) -> bool:
        return self._connected.is_set()

    # ─── Inbox consumption ─────────────────────────────────────────────────

    def drain_inbox(self) -> list[dict]:
        """Return all queued admin->worker messages and clear the queue."""
        messages: list[dict] = []
        while not self._inbox_queue.empty():
            try:
                messages.append(self._inbox_queue.get_nowait())
            except Exception:
                break
        return messages

    def mark_event_seen(self, event_id: str) -> bool:
        """Track an event_id as seen. Returns True if it was a duplicate."""
        if not event_id:
            return False
        with self._seen_lock:
            if event_id in self._seen_ids_locked():
                return True
            self._seen_event_ids.add(event_id)
            if len(self._seen_event_ids) > 1024:
                # Keep memory bounded; drop oldest half (set has no order, so
                # rebuild from a slice — acceptable trade-off for a worker
                # that lives minutes-to-hours).
                self._seen_event_ids = set(list(self._seen_event_ids)[-512:])
        return False

    def _seen_ids_locked(self) -> set[str]:
        return self._seen_event_ids

    # ─── Publishing ────────────────────────────────────────────────────────

    def publish_sync(self, subject: str, payload: dict, timeout: float = 2.0) -> bool:
        """Synchronously publish a JSON payload. Returns True on success."""
        if not self._loop or not self._connected.is_set():
            return False
        fut = asyncio.run_coroutine_threadsafe(self._publish(subject, payload), self._loop)
        try:
            return bool(fut.result(timeout=timeout))
        except Exception as exc:
            print(f"[NATS] publish_sync to {subject} failed: {exc}")
            return False

    def publish_heartbeat(self, payload: dict) -> bool:
        return self.publish_sync(worker_subject(self.role, self.ticket_id, "heartbeat"), payload)

    def publish_event(self, payload: dict) -> bool:
        return self.publish_sync(worker_subject(self.role, self.ticket_id, "event"), payload)

    # ─── Internal asyncio loop ─────────────────────────────────────────────

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._main())
        except Exception as exc:
            print(f"[NATS] loop crashed: {exc}")
        finally:
            try:
                self._loop.close()
            except Exception:
                pass

    async def _main(self) -> None:
        import nats

        try:
            self._nc = await nats.connect(
                servers=[self.nats_url],
                reconnect_time_wait=2,
                max_reconnect_attempts=-1,
                connect_timeout=5,
            )
        except Exception as exc:
            print(f"[NATS] connect failed: {exc}")
            return

        self._connected.set()
        subject = worker_inbox_subject(self.ticket_id)
        sub = await self._nc.subscribe(subject, cb=self._on_inbox_message)
        print(f"[NATS] subscribed to {subject}")

        # Pump until stop is signalled.
        while not self._stop_event.is_set():
            await asyncio.sleep(0.5)

        try:
            await sub.unsubscribe()
        except Exception:
            pass
        try:
            await self._nc.drain()
        except Exception:
            pass

    async def _publish(self, subject: str, payload: dict) -> bool:
        if not self._nc:
            return False
        try:
            await self._nc.publish(subject, json.dumps(payload).encode("utf-8"))
            return True
        except Exception as exc:
            print(f"[NATS] publish to {subject} failed: {exc}")
            return False

    async def _on_inbox_message(self, msg: Any) -> None:
        try:
            decoded = json.loads(msg.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            print(f"[NATS] dropping malformed inbox payload: {exc}")
            return
        event_id = str(decoded.get("eventId") or decoded.get("event_id") or "")
        if event_id and self.mark_event_seen(event_id):
            # Duplicate — already delivered via HTTP polling or earlier NATS
            return
        decoded.setdefault("timestamp", int(time.time() * 1000))
        self._inbox_queue.put(decoded)


# ─── Module-level singleton helpers ─────────────────────────────────────────

_client: Optional[WorkerNatsClient] = None


def get_client() -> Optional[WorkerNatsClient]:
    return _client


def start_subscriber(ticket_id: str, role: str) -> Optional[WorkerNatsClient]:
    """Start the singleton NATS subscriber if WORKER_NATS_SUBSCRIBE=true.

    Returns the client when connected; None when disabled or unavailable.
    """
    global _client
    if os.environ.get("WORKER_NATS_SUBSCRIBE", "false").strip().lower() != "true":
        return None
    if _client is not None:
        return _client
    client = WorkerNatsClient(ticket_id=ticket_id, role=role)
    if not client.start():
        return None
    _client = client
    return _client


def stop_subscriber() -> None:
    global _client
    if _client is not None:
        _client.stop()
        _client = None
