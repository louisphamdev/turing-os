"""Gateway-routing coverage for doctor_tools (Task P4c).

Doctor's credentialed paths must NOT touch BookStack GraphQL or read raw
provider tokens (BOOKSTACK_TOKEN / GITHUB_TOKEN / MATRIX_BOT_TOKEN). Every
credentialed call routes through the orchestrator gateway with the worker's
CONSUMER_TOKEN:

  * BookStack known-issues / metrics / fix-outcomes reuse bookstack_tools, which
    hits {GATEWAY_URL}/gateway/bookstack/<rest> with `Bearer {CONSUMER_TOKEN}`.
  * create_github_issue POSTs to {GATEWAY_URL}/gateway/github/repos/.../issues
    with `Bearer {CONSUMER_TOKEN}`.
  * ask_user_confirmation relays through {ORCHESTRATOR_URL}/webhooks/... and has
    no direct-Matrix fallback.

Hermetic: no network. The worker runtime resolves tools as `from tools import
...` (src/ is the package root in the container), so we add src/ to the path.
"""

import os
import sys
from unittest.mock import MagicMock, patch

# Match the worker runtime import root: `from tools import ...`.
_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src"))
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from tools import doctor_tools  # noqa: E402


def _fake_response(status_code=200, json_body=None, content=b"{}"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.json.return_value = json_body if json_body is not None else {}
    resp.text = "" if content is None else (content.decode() if isinstance(content, bytes) else str(content))
    return resp


# ─── BookStack: known issues via gateway REST (not GraphQL) ────────────────────

def test_save_to_known_issues_uses_gateway_bookstack_rest(monkeypatch):
    """save_to_known_issues must create a page via bookstack_tools' gateway REST
    path — not a /graphql mutation, and never with `Bearer BOOKSTACK_TOKEN`."""
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")

    from tools import bookstack_tools

    captured = []

    def fake_make_request(method, endpoint, data=None, params=None):
        captured.append({"method": method, "endpoint": endpoint, "data": data, "params": params})
        if method == "GET" and endpoint == "search":
            return {"data": []}  # no existing page
        if method == "GET" and endpoint == "books":
            return {"data": [{"id": 7, "name": "Doctor", "slug": "doctor"}]}
        if method == "POST" and endpoint == "pages":
            return {"page": {"id": 99, "name": data["name"], "slug": "ki"}}
        raise AssertionError(f"unexpected bookstack call: {method} {endpoint}")

    with patch.object(bookstack_tools, "_make_request", side_effect=fake_make_request):
        result = doctor_tools.save_to_known_issues(
            error_key="ECONNREFUSED",
            symptoms="cannot connect",
            causes="service down",
            fix="restart service",
            pattern="ECONNREFUSED",
        )

    assert result["success"] is True
    assert result["page_id"] == 99

    # The create must go through the REST `pages` endpoint, never GraphQL.
    endpoints = [c["endpoint"] for c in captured]
    assert "pages" in endpoints
    assert all("graphql" not in (e or "") for e in endpoints)

    # Title encodes the known-issue convention.
    create_call = next(c for c in captured if c["method"] == "POST" and c["endpoint"] == "pages")
    assert create_call["data"]["name"] == "Known Issue: ECONNREFUSED"


def test_save_to_known_issues_builds_bearer_consumer_token_url(monkeypatch):
    """End-to-end through bookstack_tools._gateway_target: the request URL must be
    /gateway/bookstack/... and the header `Bearer {CONSUMER_TOKEN}`."""
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")

    from tools import bookstack_tools

    seen = {"urls": [], "auth": []}

    def fake_request(method):
        def _inner(url, headers=None, params=None, json=None, timeout=None):
            seen["urls"].append(url)
            seen["auth"].append((headers or {}).get("Authorization"))
            if "search" in url:
                return _fake_response(json_body={"data": []})
            if url.rstrip("/").endswith("/books"):
                return _fake_response(json_body={"data": [{"id": 7, "name": "Doctor", "slug": "doctor"}]})
            return _fake_response(json_body={"page": {"id": 5, "name": "Known Issue: X", "slug": "x"}})
        return _inner

    with patch.object(bookstack_tools.requests, "get", side_effect=fake_request("GET")), \
         patch.object(bookstack_tools.requests, "post", side_effect=fake_request("POST")):
        result = doctor_tools.save_to_known_issues("X", "s", "c", "f", "p")

    assert result["success"] is True
    assert all(url.startswith("http://orchestrator:3001/gateway/bookstack/") for url in seen["urls"])
    assert all("graphql" not in url for url in seen["urls"])
    assert all(auth == "Bearer consumer.jwt.token" for auth in seen["auth"])


def test_query_known_issues_db_reads_via_gateway_rest(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")

    from tools import bookstack_tools

    def fake_make_request(method, endpoint, data=None, params=None):
        if method == "GET" and endpoint == "search":
            return {"data": [
                {"id": 11, "type": "page", "name": "Known Issue: ECONNREFUSED", "url": "u", "excerpt": ""},
            ]}
        if method == "GET" and endpoint == "pages/11":
            return {"page": {
                "id": 11,
                "name": "Known Issue: ECONNREFUSED",
                "markdown": (
                    "| Error Key | ECONNREFUSED |\n"
                    "| Pattern | ECONNREFUSED |\n"
                    "| Symptoms | cannot connect |\n"
                    "| Fix | restart service |\n"
                ),
            }}
        raise AssertionError(f"unexpected bookstack call: {method} {endpoint}")

    with patch.object(bookstack_tools, "_make_request", side_effect=fake_make_request):
        results = doctor_tools.query_known_issues_db("ECONNREFUSED")

    assert len(results) == 1
    assert results[0]["error_key"] == "ECONNREFUSED"
    assert results[0]["page_id"] == 11


def test_track_metrics_upserts_via_gateway_rest(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")

    from tools import bookstack_tools

    calls = []

    def fake_make_request(method, endpoint, data=None, params=None):
        calls.append((method, endpoint))
        if method == "GET" and endpoint == "search":
            return {"data": []}
        if method == "GET" and endpoint == "books":
            return {"data": [{"id": 7, "name": "Doctor", "slug": "doctor"}]}
        if method == "POST" and endpoint == "pages":
            return {"page": {"id": 42, "name": data["name"], "slug": "m"}}
        raise AssertionError(f"unexpected bookstack call: {method} {endpoint}")

    with patch.object(bookstack_tools, "_make_request", side_effect=fake_make_request):
        result = doctor_tools.track_metrics("error_count", 3.0)

    assert result["success"] is True
    assert result["page_path"] == "Metric: error_count"
    assert ("POST", "pages") in calls
    assert all("graphql" not in ep for _, ep in calls)


# ─── GitHub issue creation via the gateway ─────────────────────────────────────

def test_create_github_issue_posts_to_gateway_with_consumer_token(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")
    monkeypatch.setenv("GITHUB_REPO", "louisphamdev/turing-os")
    # Reload so module-level GATEWAY_URL/CONSUMER_TOKEN pick up the env.
    import importlib
    dt = importlib.reload(doctor_tools)

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        return _fake_response(
            status_code=201,
            json_body={"html_url": "https://github.com/louisphamdev/turing-os/issues/7", "number": 7},
        )

    with patch("requests.post", side_effect=fake_post):
        result = dt.create_github_issue("Title", "Body", labels=["bug"])

    assert result["success"] is True
    assert result["issue_number"] == 7
    assert captured["url"] == (
        "http://orchestrator:3001/gateway/github/repos/louisphamdev/turing-os/issues"
    )
    assert captured["headers"]["Authorization"] == "Bearer consumer.jwt.token"
    assert captured["json"]["title"] == "Title"
    assert captured["json"]["labels"] == ["bug"]
    # Restore env-driven module state for other tests.
    importlib.reload(doctor_tools)


def test_create_github_issue_requires_gateway_env(monkeypatch):
    for var in ("GATEWAY_URL", "CONSUMER_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    import importlib
    dt = importlib.reload(doctor_tools)

    result = dt.create_github_issue("Title", "Body")
    assert result["success"] is False
    assert "GATEWAY_URL" in result["error"] or "CONSUMER_TOKEN" in result["error"]
    importlib.reload(doctor_tools)


# ─── ask_user_confirmation: orchestrator relay only, no direct Matrix ──────────

def test_ask_user_confirmation_uses_orchestrator_relay(monkeypatch):
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")
    monkeypatch.setenv("TICKET_ID", "T-1")
    import importlib
    dt = importlib.reload(doctor_tools)

    posts = []

    def fake_post(url, json=None, headers=None, timeout=None):
        posts.append((url, headers))
        return _fake_response(status_code=200, json_body={"ok": True})

    def fake_get(url, params=None, headers=None, timeout=None):
        return _fake_response(
            status_code=200,
            json_body={"messages": [{"content": "yes, proceed", "sender": "admin", "timestamp": "t"}]},
        )

    try:
        with patch("requests.post", side_effect=fake_post), patch("requests.get", side_effect=fake_get):
            result = dt.ask_user_confirmation("Restart the service?")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is True
    assert result["confirmed"] is True
    # Relay posted to the orchestrator webhook with the CONSUMER_TOKEN bearer.
    assert posts[0][0] == "http://orchestrator:3001/webhooks/worker-message"
    assert posts[0][1]["Authorization"] == "Bearer consumer.jwt.token"


def test_ask_user_confirmation_returns_clear_error_when_relay_unreachable(monkeypatch):
    monkeypatch.setenv("ORCHESTRATOR_URL", "http://orchestrator:3001")
    monkeypatch.setenv("CONSUMER_TOKEN", "consumer.jwt.token")
    monkeypatch.setenv("TICKET_ID", "T-1")
    import importlib
    dt = importlib.reload(doctor_tools)

    def fake_post(url, json=None, headers=None, timeout=None):
        return _fake_response(status_code=503)

    try:
        with patch("requests.post", side_effect=fake_post):
            result = dt.ask_user_confirmation("Restart the service?")
    finally:
        importlib.reload(doctor_tools)

    assert result["success"] is False
    assert result["confirmed"] is None
    assert "could not reach admin" in result["error"].lower()


def test_no_direct_matrix_or_graphql_or_provider_tokens():
    """Regression guard: the dead direct-Matrix path and raw provider-token reads
    must not exist anywhere in the module source."""
    src = doctor_tools.__file__
    with open(src, "r", encoding="utf-8") as fh:
        text = fh.read()

    assert "_ask_via_direct_matrix" not in text
    assert "graphql" not in text.lower()
    assert "MATRIX_BOT_TOKEN" not in text
    assert "BOOKSTACK_TOKEN" not in text
    assert "GITHUB_TOKEN" not in text
    assert not hasattr(doctor_tools, "_ask_via_direct_matrix")
    assert not hasattr(doctor_tools, "_wiki_request")
    assert not hasattr(doctor_tools, "_get_github_token")
