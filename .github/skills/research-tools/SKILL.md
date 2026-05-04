---
name: research-tools
description: '**SKILL** — Context7-powered research for Turing OS. Use when: researching unfamiliar technologies, fetching latest documentation, tech stack exploration, framework comparison, or getting code examples for specific libraries. Triggers: "research", "Context7", "tìm hiểu công nghệ", "fetch docs", "library research"'
user-invocable: true
---

# Research Tools Skill

## When to Use

This skill handles technology research using Context7:
- Fetching latest documentation for libraries
- Getting code examples and best practices
- Comparing technology options
- Researching unfamiliar frameworks
- Updating outdated knowledge

## Context7 API

Context7 provides up-to-date library documentation via AI.

### API Endpoint

```
POST https://api.context7.io/v1/research
Headers: {"Authorization": "Bearer <api_key>"}
Body: {"library_name": "...", "topic": "..."}
```

API key stored in BookStack, injected at worker spawn.

## Usage in Workers

### Python (base-worker)

```python
# Via research_tools.py
TOOL_CALL: research_with_context7
ARGUMENTS: {"library_name": "fastapi", "topic": "authentication"}

# Response includes:
# - Latest documentation
# - Code examples
# - Best practices
```

### Research Tool Example

```python
# base-worker/src/tools/research_tools.py
async def research_with_context7(library_name: str, topic: str = None):
    """Fetch documentation from Context7 API"""
    api_key = get_secret("context7_api_key")
    response = httpx.post(
        "https://api.context7.io/v1/research",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"library_name": library_name, "topic": topic}
    )
    return response.json()
```

## Common Research Scenarios

| Task | Library | Topic |
|------|---------|-------|
| REST API auth | fastapi | authentication |
| Database ORM | sqlalchemy | async patterns |
| Testing | pytest | fixtures |
| Docker optimization | docker | multi-stage build |
| TypeScript types | typescript | generics |

## Skill Loading Integration

Before implementing unfamiliar tech:

```python
# 1. Load relevant skills
TOOL_CALL: load_skills_for_task
ARGUMENTS: {"skill_names": "python,fastapi,sql"}

# 2. Research unfamiliar parts
TOOL_CALL: research_with_context7
ARGUMENTS: {"library_name": "fastapi", "topic": "middleware"}

# 3. Implement with current best practices
```

## Why Context7?

| Without Research | With Context7 |
|-----------------|---------------|
| Generic knowledge | Framework-specific patterns |
| Potentially outdated | Always latest version |
| Trial-and-error | Documented best practices |
| Slower implementation | Faster, accurate code |

## Related Files

- `base-worker/src/tools/research_tools.py` — Research tool implementation
- `base-worker/src/index.py` — Skill loading at startup
- `roles/software-engineer.md` — Mandatory skill loading protocol