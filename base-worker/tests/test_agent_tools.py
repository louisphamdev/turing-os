"""Integration coverage for HermesAgent default-tool registration.

Regression guard for the FATAL worker-boot bug found by a live container
smoke test: `_register_default_tools` referenced module-level functions on
`tools.state_backend` (update_ticket_status, read_ticket, add_comment,
create_ticket, search_tickets) that did not exist — so the agent raised
AttributeError on construction and NO worker could run a task.

This class of bug was invisible to the unit tests in test_state_backend.py
because those test the PlaneBackend *class methods*, not the module-level
wrappers the agent actually registers. These tests lock in that every tool
the agent registers resolves to a real callable.

Hermetic: no network. The worker runtime imports tools via `from tools import
...` (src/ on sys.path), so we put src/ on the path. research_tools'
initializer is patched to a no-op so constructing the agent never reaches out.
"""

import os
import sys

# The worker runtime resolves tools as `from tools import ...` (src/ is the
# package root inside the container). Tests run from base-worker/, so add src/.
_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)


# The exact list the agent registers off tools.state_backend.
STATE_BACKEND_TOOL_NAMES = [
    "update_ticket_status",
    "read_ticket",
    "add_comment",
    "create_ticket",
    "search_tickets",
]


def test_state_backend_exposes_all_registered_tool_names():
    """Every state_backend.* name referenced in _register_default_tools must
    resolve to a module-level callable. This is the cheapest, most robust
    guard against the AttributeError that broke worker boot."""
    from tools import state_backend

    for name in STATE_BACKEND_TOOL_NAMES:
        attr = getattr(state_backend, name, None)
        assert callable(attr), f"state_backend.{name} is not a callable (got {attr!r})"


def test_register_default_tools_completes_without_attribute_error(monkeypatch):
    """Constructing a HermesAgent must run _register_default_tools to
    completion (no AttributeError). Every tool registered must be callable.

    research_tools.init_research_tools is patched to a no-op so construction
    stays hermetic (no network / no API-key side effects)."""
    from tools import research_tools

    monkeypatch.setattr(research_tools, "init_research_tools", lambda *a, **k: None)

    from agent.hermes_loop import HermesAgent

    # This is the call that crashed in production with:
    #   AttributeError: module 'tools.state_backend' has no attribute
    #   'update_ticket_status'
    agent = HermesAgent(ticket_id="T-1", role="se", max_iterations=3)

    assert agent.tools, "agent registered no tools"
    for name, func in agent.tools.items():
        assert callable(func), f"registered tool {name!r} is not callable"

    # The five state-backend tools that triggered the bug are all present.
    for name in STATE_BACKEND_TOOL_NAMES:
        assert name in agent.tools, f"tool {name!r} was not registered"
        assert callable(agent.tools[name])


def test_search_tickets_wraps_list_tickets(monkeypatch):
    """search_tickets delegates to the backend's list_tickets and applies a
    client-side text filter over title/description."""
    from tools import state_backend

    # Reset the lazily-cached backend so our fake takes effect.
    monkeypatch.setattr(state_backend, "_backend", None, raising=False)

    class FakeBackend:
        name = "plane"

        def __init__(self):
            self.calls = []

        def list_tickets(self, status=None):
            self.calls.append(status)
            return {"tickets": [
                {"id": "T-1", "title": "Fix login bug", "description": "auth broken"},
                {"id": "T-2", "title": "Add export", "description": "csv export"},
            ]}

    fake = FakeBackend()
    monkeypatch.setattr(state_backend, "get_backend", lambda: fake)

    # status filter is forwarded; text query filters client-side.
    result = state_backend.search_tickets(query="login", status="TODO")
    assert fake.calls == ["TODO"]
    assert [t["id"] for t in result["tickets"]] == ["T-1"]

    # empty query returns everything from list_tickets.
    result_all = state_backend.search_tickets()
    assert {t["id"] for t in result_all["tickets"]} == {"T-1", "T-2"}


def test_create_ticket_method_builds_post_to_issues(monkeypatch):
    """PlaneBackend.create_ticket POSTs to /issues/ with name/description_html
    and normalises the response — modelled on the verified read/update calls.

    NOTE: needs live-Plane verification; this only locks in the request shape."""
    from tools import state_backend

    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "test.jwt.token")

    backend = state_backend.PlaneBackend()

    calls = []

    def fake_request(method, endpoint, body=None):
        calls.append({"method": method, "endpoint": endpoint, "body": body})
        if endpoint == "/states/":
            return {"results": []}
        return {"id": "T-99", "name": "New thing", "state": None}

    monkeypatch.setattr(backend, "_request", fake_request)

    result = backend.create_ticket("New thing", "details here", priority="high")

    # The create call is a POST to /issues/ (state lookup for normalisation
    # may follow, so find the create call explicitly rather than asserting on
    # the last request).
    post = next(c for c in calls if c["method"] == "POST" and c["endpoint"] == "/issues/")
    assert post["body"]["name"] == "New thing"
    assert post["body"]["description_html"] == "details here"
    assert post["body"]["priority"] == "high"
    # Returned in the normalised read_ticket shape.
    assert result["id"] == "T-99"
    assert result["title"] == "New thing"


def test_create_ticket_missing_config_returns_error(monkeypatch):
    """create_ticket surfaces the shared structured error when gateway env is
    absent, like the other methods."""
    for var in ("GATEWAY_URL", "CONSUMER_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    from tools import state_backend

    backend = state_backend.PlaneBackend()
    result = backend.create_ticket("title")
    assert result["backend"] == "plane"
    assert "GATEWAY_URL" in result["error"] or "CONSUMER_TOKEN" in result["error"]
