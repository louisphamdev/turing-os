"""Unit tests for HermesAgent.run_interactive tool execution (Task P1-1).

These verify that interactive chat mode ACTUALLY runs tools instead of
echoing the raw "TOOL_CALL:" text back to the admin:

  - A TOOL_CALL emitted by the model is parsed and the tool is executed.
  - The loop continues, feeds the tool result back, and the FINAL plain
    answer (not the raw TOOL_CALL text) is returned to the caller.
  - A first-response plain answer still returns immediately.

Hermetic: `_call_llm` is stubbed directly, no network. `_register_default_tools`
is patched to a no-op so the test does not depend on heavy tool imports / env.
"""

from unittest.mock import patch

from src.agent.hermes_loop import HermesAgent


def make_agent(role: str = "se") -> HermesAgent:
    """Build a HermesAgent without registering the heavy default toolset."""
    with patch.object(HermesAgent, "_register_default_tools", lambda self: None):
        agent = HermesAgent(ticket_id="T-1", role=role, max_iterations=5)
    # register_tool sets system_prompt_override = None as a side effect; ensure
    # interactive mode starts from a clean default-prompt state.
    agent.system_prompt_override = None
    return agent


def test_interactive_executes_tool_then_returns_final_answer():
    """Model emits a TOOL_CALL, tool runs, then a plain answer is returned."""
    agent = make_agent()

    calls = {"count": 0, "args": None}

    def fake_tool(city: str):
        """Return weather for a city."""
        calls["count"] += 1
        calls["args"] = city
        return "sunny, 25C"

    agent.register_tool("get_weather", fake_tool)

    responses = [
        # iteration 0: the model asks to call the tool
        {"content": 'TOOL_CALL: get_weather\nARGUMENTS: {"city": "Hanoi"}'},
        # iteration 1: the model uses the result and answers
        {"content": "DONE: The weather in Hanoi is sunny, 25C."},
    ]

    def fake_call_llm(messages=None):
        return responses.pop(0)

    with patch.object(agent, "_call_llm", side_effect=fake_call_llm):
        status, content = agent.run_interactive("What's the weather in Hanoi?")

    # (a) the fake tool WAS executed (exactly once, with parsed args)
    assert calls["count"] == 1
    assert calls["args"] == "Hanoi"

    # (b) the final returned content is the answer, not the raw TOOL_CALL text
    assert status == "done"
    assert "TOOL_CALL" not in content
    assert "sunny, 25C" in content
    # DONE: marker is stripped for a clean reply
    assert not content.startswith("DONE:")


def test_interactive_plain_answer_returns_immediately():
    """A first response with no tool calls returns straight away."""
    agent = make_agent()

    seen = {"calls": 0}

    def fake_call_llm(messages=None):
        seen["calls"] += 1
        return {"content": "Hello! I am the se worker. How can I help?"}

    with patch.object(agent, "_call_llm", side_effect=fake_call_llm):
        status, content = agent.run_interactive("hi")

    assert status == "done"
    assert content == "Hello! I am the se worker. How can I help?"
    # Only one LLM round-trip — we did not keep looping.
    assert seen["calls"] == 1


def test_interactive_blocked_signal_returned():
    """A BLOCKED: response is surfaced as a 'blocked' status."""
    agent = make_agent()

    def fake_call_llm(messages=None):
        return {"content": "BLOCKED: I need admin credentials to proceed."}

    with patch.object(agent, "_call_llm", side_effect=fake_call_llm):
        status, content = agent.run_interactive("delete prod database")

    assert status == "blocked"
    assert "BLOCKED:" in content


def test_interactive_prompt_includes_tool_format():
    """When a bare conversational override is given, run_interactive injects
    the TOOL_CALL format + tool schema so the model can emit tool calls."""
    agent = make_agent()

    def fake_tool():
        """A registered tool."""
        return "ok"

    agent.register_tool("my_tool", fake_tool)
    agent.system_prompt_override = "You are a friendly assistant. Be helpful."

    def fake_call_llm(messages=None):
        return {"content": "Hi there!"}

    with patch.object(agent, "_call_llm", side_effect=fake_call_llm):
        agent.run_interactive("hello")

    system_msg = agent.messages[0]
    assert system_msg.role == "system"
    assert "TOOL_CALL:" in system_msg.content
    assert "my_tool" in system_msg.content
    # Original override text is preserved.
    assert "You are a friendly assistant." in system_msg.content
