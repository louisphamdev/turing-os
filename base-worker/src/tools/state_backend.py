"""
StateBackend ABC — phase 1 of the Taiga->Plane migration.

Workers used to import taiga_tools directly. Phase 1 adds an abstract
interface so the active backend can be swapped via the STATE_BACKEND
env var (taiga | plane). Default remains taiga so existing deployments
are unaffected.

Plane backend is a skeleton — methods return a structured "not implemented"
error so the agent fails gracefully instead of crashing. Phase 2 will
flesh it out against a real Plane CE container.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Optional


class StateBackend(ABC):
    """Persistence layer for the project's tickets / user stories."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Short identifier used in logs and error messages."""

    @abstractmethod
    def update_ticket_status(self, ticket_id: str, new_status: str, comment: str = "") -> dict:
        """Change a ticket's status. Adds a comment when provided."""

    @abstractmethod
    def read_ticket(self, ticket_id: str) -> dict:
        """Return the canonical ticket payload (normalised across backends)."""

    @abstractmethod
    def list_tickets(self, status: Optional[str] = None) -> dict:
        """List tickets in the active project, optionally filtered by status."""

    @abstractmethod
    def add_comment(self, ticket_id: str, comment: str) -> dict:
        """Append a comment to the ticket."""


class TaigaBackend(StateBackend):
    """Thin wrapper around the existing taiga_tools functions."""

    name = "taiga"

    def update_ticket_status(self, ticket_id: str, new_status: str, comment: str = "") -> dict:
        from . import taiga_tools
        return taiga_tools.update_ticket_status(ticket_id, new_status, comment)

    def read_ticket(self, ticket_id: str) -> dict:
        from . import taiga_tools
        return taiga_tools.read_ticket(ticket_id)

    def list_tickets(self, status: Optional[str] = None) -> dict:
        from . import taiga_tools
        # taiga_tools doesn't expose list_tickets directly; fall back to a
        # safe error rather than guessing at the right helper.
        fn = getattr(taiga_tools, "list_tickets", None)
        if callable(fn):
            return fn(status)
        return {"error": "taiga_tools.list_tickets is not implemented"}

    def add_comment(self, ticket_id: str, comment: str) -> dict:
        from . import taiga_tools
        fn = getattr(taiga_tools, "add_comment", None)
        if callable(fn):
            return fn(ticket_id, comment)
        # Fallback: use update_ticket_status with the existing status and the
        # comment. Caller must supply the status separately if they need to
        # change it.
        return {"error": "taiga_tools.add_comment is not implemented"}


class PlaneBackend(StateBackend):
    """Skeleton for Plane CE — phase 2 will implement against real Plane API."""

    name = "plane"

    def __init__(self) -> None:
        self.api_url = os.environ.get("PLANE_API_URL", "")
        self.api_token = os.environ.get("PLANE_API_TOKEN", "")
        self.workspace = os.environ.get("PLANE_WORKSPACE_SLUG", "")
        self.project = os.environ.get("PLANE_PROJECT_ID", "")

    def _not_implemented(self, method: str) -> dict:
        return {
            "error": (
                f"PlaneBackend.{method} is not yet implemented. "
                f"This is phase-1 scaffolding; phase 2 wires it to a real Plane CE "
                f"instance at PLANE_API_URL={self.api_url or '<unset>'}."
            ),
            "backend": self.name,
        }

    def update_ticket_status(self, ticket_id: str, new_status: str, comment: str = "") -> dict:
        return self._not_implemented("update_ticket_status")

    def read_ticket(self, ticket_id: str) -> dict:
        return self._not_implemented("read_ticket")

    def list_tickets(self, status: Optional[str] = None) -> dict:
        return self._not_implemented("list_tickets")

    def add_comment(self, ticket_id: str, comment: str) -> dict:
        return self._not_implemented("add_comment")


def get_backend() -> StateBackend:
    """Return the active backend selected by STATE_BACKEND env var.

    STATE_BACKEND=taiga (default) returns TaigaBackend.
    STATE_BACKEND=plane returns PlaneBackend.
    """
    selected = (os.environ.get("STATE_BACKEND") or "taiga").strip().lower()
    if selected == "plane":
        return PlaneBackend()
    if selected == "taiga":
        return TaigaBackend()
    print(f"[StateBackend] WARNING: unknown STATE_BACKEND={selected!r}, falling back to taiga")
    return TaigaBackend()
