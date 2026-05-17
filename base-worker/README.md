# Base Worker

Ephemeral container that runs a Hermes agent to process tickets.

## Architecture

```
Worker Container
├── index.py          # Entry point, creates agent
├── agent/
│   └── hermes_loop.py   # ReAct reasoning engine + LLM integration
└── tools/
    ├── state_backend.py      # Ticket management
    ├── bookstack_tools.py      # Document access (BookStack)
    └── local_exec.py       # Sandbox command execution
```

## Hermes Agent

The `HermesAgent` is the core reasoning engine. It uses a ReAct loop:

1. **Think** - Build prompt with available tools
2. **Act** - Call a tool based on LLM decision
3. **Observe** - Get tool result
4. **Repeat** - Until task is complete

### Agent Types

| Agent | LLM Provider | Usage |
|-------|-------------|-------|
| `HermesAgent` | Base class | Extend for custom LLM |
| `OpenAIAgent` | OpenAI GPT-4 | `LLM_PROVIDER=openai` |
| `AnthropicAgent` | Claude | `LLM_PROVIDER=anthropic` |

## Tool Registration

Tools are registered at agent initialization:

```python
from agent.hermes_loop import OpenAIAgent

agent = OpenAIAgent(ticket_id="123", api_key="sk-...", role="coder")
# Tools are auto-registered via _register_default_tools()
```

To add custom tools:

```python
def my_custom_tool(arg1: str) -> str:
    """My tool description"""
    return f"Result: {arg1}"

agent.register_tool('my_tool', my_custom_tool)
# or
agent.register_tools({'my_tool': my_custom_tool, ...})
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TICKET_ID` | Yes | Ticket to process |
| `ROLE` | No | Worker role (default: "default") |
| `LLM_API_KEY` | Yes | API key for LLM provider |
| `LLM_PROVIDER` | No | "openai" or "anthropic" (default: openai) |
| `PLANE_API_URL` | No | Plane API URL (http://turing_plane_api:8000/api/v1) |
| `PLANE_API_TOKEN` | No | Plane auth token (auto from init-admin-users.sh) |
| `PLANE_WORKSPACE_SLUG` | No | Plane project slug |

## Message History

The agent maintains a conversation history via `AgentMessage` dataclass:

```python
agent = OpenAIAgent(...)
agent.run()
history = agent.get_history()  # List[AgentMessage]

for msg in history:
    print(f"{msg.role}: {msg.content}")
```

## Zero-State Rule

**IMPORTANT**: Worker containers are ephemeral. On exit:
- No files persist
- No memory retained
- All state MUST be stored in Plane or BookStack

The container's `HostConfig.AutoRemove: true` ensures cleanup.

## Exit Codes

| Code | Meaning |
|------|--------|
| 0 | Success |
| 1 | Error (task blocked or fatal error) |

## Building

```bash
docker build -t turing-worker-base:latest .
```

The image does NOT contain API keys - these are injected at runtime by the orchestrator.