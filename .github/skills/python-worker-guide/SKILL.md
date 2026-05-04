---
name: python-worker-guide
description: '**SKILL** — Python development guide for Turing OS base workers. Use when: writing Python code for workers, implementing new tools, using httpx/requests, implementing ReAct patterns, debugging worker behavior, or adding Python dependencies. Triggers: "Python worker", "tool implementation", "httpx", "ReAct agent", "worker code"'
user-invocable: true
---

# Python Worker Guide for Turing OS

## When to Use

This skill covers Python development for base workers:
- Writing new tools for workers
- Understanding ReAct agent implementation
- HTTP client patterns (httpx/requests)
- Async programming in Python
- Tool registry and persistence
- Worker skill loading

## Worker Tech Stack

| Package | Purpose | Import |
|---------|---------|--------|
| `httpx` | Async HTTP | `import httpx` |
| `requests` | Sync HTTP | `import requests` |
| `asyncio` | Async IO | `import asyncio` |
| `json` | JSON handling | `import json` |

## Tool Implementation Pattern

### Basic Tool Structure
```python
# base-worker/src/tools/my_tool.py
from typing import Any
from dataclasses import dataclass

@dataclass
class ToolResult:
    success: bool
    result: Any = None
    error: str = None

TOOL_NAME = "my_tool"

async def my_tool(arg1: str, arg2: int = 10) -> ToolResult:
    """
    Description of what the tool does.

    Args:
        arg1: Description of first argument
        arg2: Description of second argument (default: 10)

    Returns:
        ToolResult with success/result/error
    """
    try:
        # Tool logic here
        result = {"processed": arg1, "count": arg2}
        return ToolResult(success=True, result=result)
    except Exception as e:
        return ToolResult(success=False, error=str(e))
```

### Registering the Tool
```python
# base-worker/src/tools/tool_registry.py
from .my_tool import my_tool, TOOL_NAME

TOOL_REGISTRY = {
    TOOL_NAME: my_tool,
    # ... other tools
}
```

### Tool Calling from Agent
```python
# Text-based format in LLM prompt
TOOL_CALL: my_tool
ARGUMENTS: {"arg1": "value", "arg2": 5}
```

## HTTP Client Patterns

### Using httpx (Async)
```python
import httpx

async def fetch_data(url: str, headers: dict = None) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.json()
```

### Using requests (Sync)
```python
import requests

def fetch_data(url: str, token: str = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = requests.get(url, headers=headers, timeout=30)
    response.raise_for_status()
    return response.json()
```

### POST with JSON
```python
def notify_orchestrator(endpoint: str, data: dict):
    """Send notification to orchestrator"""
    try:
        requests.post(
            f'{ORCHESTRATOR_URL}/webhooks/{endpoint}',
            json=data,
            timeout=5,
        )
    except Exception as e:
        log(f"Failed to notify orchestrator: {e}", 'WARN')
```

## ReAct Loop Pattern

```python
# base-worker/src/agent/hermes_loop.py
class HermesAgent:
    async def think(self, task: str) -> str:
        """Main ReAct loop"""
        while not self.is_complete():
            # 1. Think - reason about task
            thought = await self.reason(task)

            # 2. Act - call tool or respond
            if self.should_act(thought):
                result = await self.execute_tool(thought)
                self.add_tool_result(result)
            else:
                # 3. Respond to user
                return thought

        return self.final_response()
```

## Async Patterns

### Running Async from Sync
```python
# index.py - entry point is sync but agent is async
agent = create_agent()
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
result = loop.run_until_complete(agent.think(task))
```

### Awaiting Multiple Coroutines
```python
async def fetch_all(urls: list) -> list:
    async with httpx.AsyncClient() as client:
        tasks = [client.get(url) for url in urls]
        responses = await asyncio.gather(*tasks)
        return [r.json() for r in responses]
```

## Validation

```powershell
# Python syntax check
.venv\Scripts\python.exe -m py_compile base-worker\src\tools\my_tool.py

# Run tests (when added)
python -m pytest base-worker/tests/ -v

# Install dependencies
pip install -r base-worker/requirements.txt
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `httpx` | ^0.25 | Async HTTP client |
| `requests` | ^2.31 | Sync HTTP client |
| `python-dotenv` | ^1.0 | Environment variables |

## Related Files

- `base-worker/src/tools/tool_registry.py` — Tool registration
- `base-worker/src/agent/hermes_loop.py` — ReAct implementation
- `base-worker/src/index.py` — Entry point
- `base-worker/requirements.txt` — Dependencies