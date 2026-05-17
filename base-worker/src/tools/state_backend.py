"""
StateBackend — single backend (Plane CE).

Workers persist ticket / user-story state in Plane CE. The ABC is kept so
future swaps don't ripple through callers, but Taiga is gone — selecting
STATE_BACKEND=taiga prints a warning and falls back to PlaneBackend.

Plane CE REST API (verified against plane-ce v0.21):
  - Base:    {PLANE_API_URL}/workspaces/{slug}/projects/{project_id}/...
  - Auth:    `X-API-Key: <PLANE_API_TOKEN>` header
  - Issues:  GET/POST /issues/, GET/PATCH /issues/{issue_id}/
  - States:  GET /states/ → list of states (id, name, group)
  - Comments: GET/POST /issues/{issue_id}/comments/
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


# Map abstract status names to Plane state group hints. Plane states are
# project-defined; we match by group first then by name within the group.
_PLANE_STATUS_TO_GROUP: dict[str, tuple[str, list[str]]] = {
    "TODO": ("unstarted", ["todo", "backlog", "open"]),
    "IN_PROGRESS": ("started", ["in progress", "in-progress", "doing"]),
    "REVIEW": ("started", ["in review", "review", "code review"]),
    "DONE": ("completed", ["done", "completed", "closed"]),
    "BLOCKED": ("cancelled", ["blocked", "cancelled", "canceled"]),
}


class PlaneBackend(StateBackend):
    """Plane CE backend wired against the public REST API."""

    name = "plane"

    def __init__(self) -> None:
        self.api_url = os.environ.get("PLANE_API_URL", "").rstrip("/")
        self.api_token = os.environ.get("PLANE_API_TOKEN", "")
        self.workspace = os.environ.get("PLANE_WORKSPACE_SLUG", "")
        self.project = os.environ.get("PLANE_PROJECT_ID", "")
        self._state_cache: Optional[list[dict]] = None

    # ─── Public API ────────────────────────────────────────────────────────

    def update_ticket_status(self, ticket_id: str, new_status: str, comment: str = "") -> dict:
        err = self._missing_config()
        if err:
            return err

        state_id = self._resolve_state_id(new_status)
        if not state_id:
            return self._error(f"could not resolve Plane state for status '{new_status}'")

        result = self._request("PATCH", f"/issues/{ticket_id}/", {"state": state_id})
        if "error" in result:
            return result

        if comment:
            comment_result = self.add_comment(ticket_id, comment)
            if "error" in comment_result:
                result["comment_error"] = comment_result["error"]

        return result

    def read_ticket(self, ticket_id: str) -> dict:
        err = self._missing_config()
        if err:
            return err

        result = self._request("GET", f"/issues/{ticket_id}/")
        if "error" in result:
            return result
        state_lookup = {str(s.get("id")): s for s in self._load_states()}
        return self._normalise_issue(result, state_lookup)

    def list_tickets(self, status: Optional[str] = None) -> dict:
        err = self._missing_config()
        if err:
            return err

        params: dict[str, str] = {}
        if status:
            state_id = self._resolve_state_id(status)
            if state_id:
                params["state"] = state_id

        endpoint = "/issues/"
        if params:
            from urllib.parse import urlencode
            endpoint = f"{endpoint}?{urlencode(params)}"

        result = self._request("GET", endpoint)
        if "error" in result:
            return result

        items = result if isinstance(result, list) else result.get("results", [])
        state_lookup = {str(s.get("id")): s for s in self._load_states()}
        return {"tickets": [self._normalise_issue(i, state_lookup) for i in items]}

    def add_comment(self, ticket_id: str, comment: str) -> dict:
        err = self._missing_config()
        if err:
            return err
        return self._request(
            "POST",
            f"/issues/{ticket_id}/comments/",
            {"comment_html": comment, "comment_stripped": comment},
        )

    # ─── Helpers ───────────────────────────────────────────────────────────

    def _missing_config(self) -> Optional[dict]:
        missing = []
        if not self.api_url:
            missing.append("PLANE_API_URL")
        if not self.api_token:
            missing.append("PLANE_API_TOKEN")
        if not self.workspace:
            missing.append("PLANE_WORKSPACE_SLUG")
        if not self.project:
            missing.append("PLANE_PROJECT_ID")
        if missing:
            return self._error(f"Plane env vars not configured: {', '.join(missing)}")
        return None

    def _error(self, message: str) -> dict:
        return {"backend": self.name, "error": message}

    def _base_path(self) -> str:
        return f"/workspaces/{self.workspace}/projects/{self.project}"

    def _request(self, method: str, endpoint: str, body: Optional[dict] = None) -> dict:
        """Perform a REST call against the Plane API."""
        try:
            import requests
        except ImportError:
            return self._error("requests library not available")

        url = f"{self.api_url}{self._base_path()}{endpoint}"
        headers = {
            "X-API-Key": self.api_token,
            "Content-Type": "application/json",
        }

        try:
            if method == "GET":
                resp = requests.get(url, headers=headers, timeout=10)
            elif method == "POST":
                resp = requests.post(url, headers=headers, json=body or {}, timeout=10)
            elif method == "PATCH":
                resp = requests.patch(url, headers=headers, json=body or {}, timeout=10)
            elif method == "DELETE":
                resp = requests.delete(url, headers=headers, timeout=10)
            else:
                return self._error(f"unsupported method: {method}")

            if resp.status_code == 204:
                return {"success": True}

            if resp.status_code >= 400:
                return self._error(f"HTTP {resp.status_code}: {resp.text[:300]}")

            return resp.json() if resp.content else {"success": True}
        except Exception as exc:
            return self._error(str(exc))

    def _resolve_state_id(self, status_name: str) -> Optional[str]:
        """Resolve abstract status (TODO/IN_PROGRESS/...) to a Plane state UUID."""
        states = self._load_states()
        if not states:
            return None

        upper = status_name.upper()
        group_hint, name_hints = _PLANE_STATUS_TO_GROUP.get(upper, ("", [status_name.lower()]))

        # Exact name match first (case-insensitive).
        for state in states:
            if state.get("name", "").strip().lower() == status_name.lower():
                return str(state.get("id"))

        # Then name hints.
        for state in states:
            sname = state.get("name", "").strip().lower()
            if sname in name_hints:
                return str(state.get("id"))

        # Then group fallback (first state of the matching group).
        if group_hint:
            for state in states:
                if state.get("group", "").lower() == group_hint:
                    return str(state.get("id"))

        return None

    def _load_states(self) -> list[dict]:
        if self._state_cache is not None:
            return self._state_cache
        result = self._request("GET", "/states/")
        if "error" in result:
            return []
        states = result if isinstance(result, list) else result.get("results", [])
        self._state_cache = states or []
        return self._state_cache

    @staticmethod
    def _normalise_issue(issue: dict, state_lookup: Optional[dict] = None) -> dict:
        """Normalise a Plane issue to the shape callers expect from read_ticket."""
        state_id = issue.get("state")
        status_name = ""
        if state_id and state_lookup:
            state = state_lookup.get(str(state_id)) or {}
            status_name = state.get("name", "")
        return {
            "id": issue.get("id"),
            "ref": issue.get("sequence_id") or issue.get("ref"),
            "title": issue.get("name") or issue.get("title", ""),
            "description": issue.get("description_html") or issue.get("description_stripped") or "",
            "status": state_id,
            "status_name": status_name,
            "project": issue.get("project"),
            "assigned_to": issue.get("assignees") or issue.get("assigned_to"),
            "owner": issue.get("created_by") or issue.get("owner"),
            "priority": issue.get("priority"),
            "tags": issue.get("labels") or issue.get("tags", []),
            "created_date": issue.get("created_at") or issue.get("created_date"),
            "modified_date": issue.get("updated_at") or issue.get("modified_date"),
        }


def get_backend() -> StateBackend:
    """Return the active backend. Plane is the only implementation now."""
    selected = (os.environ.get("STATE_BACKEND") or "plane").strip().lower()
    if selected and selected not in ("plane", ""):
        print(f"[StateBackend] WARNING: STATE_BACKEND={selected!r} is no longer supported. Falling back to plane.")
    return PlaneBackend()
