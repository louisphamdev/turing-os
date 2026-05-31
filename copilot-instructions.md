---
name: turing-os-instructions
description: Project Turing OS agent instructions — multi-agent IT department simulation with Matrix/Synapse communication, Docker-based worker orchestration, and role-based task management.
applyTo:
  - "orchestrator/**"
  - "base-worker/**"
  - "roles/**"
  - "scripts/**"
  - "docker-compose*.yml"
  - "Makefile"
version: 1.0.1
---

# Project Turing OS — Agent Instructions

## Project Overview

Turing OS is a multi-agent operating system that simulates a complete IT department using an event-driven, role-based hierarchy. AI agents (PO → PM → HR → Workers) coordinate to automate the software development lifecycle.

**Key Paths:**
- Orchestrator: `orchestrator/` — TypeScript/Express API gateway, Docker container management
- Base Worker: `base-worker/` — Python ReAct agent containers
- Infrastructure: `docker-compose.yml` — Plane, BookStack, Matrix/Synapse, Element

## Architecture

```
PO → PM → HR → Workers (SE, QA, DevOps, Data, Security, ...)
```

- **Orchestrator** (port 3001): Central API gateway, spawns ephemeral worker containers via Docker Engine API
- **Base Worker**: Python ReAct agent with tools for Plane, BookStack, Matrix, local exec, research
- **Communication**: All worker↔worker communication MUST go through PM (no direct peer messaging)

## Key Technologies

| Component | Tech | Path |
|-----------|------|------|
| Orchestrator API | TypeScript, Express, Dockerode | `orchestrator/src/` |
| Worker Agent | Python, httpx, ReAct loop | `base-worker/src/` |
| Message Broker | Matrix/Synapse (ports 8008/8448) | `synapse/` |
| Ticket System | Plane (port 9000) | via docker-compose |
| Documentation | BookStack (port 6875) | via docker-compose |
| Chat UI | Element Web (port 8080) | `element_config/` |

## Critical Rules

1. **PM-Centralized Communication**: Workers report completions/blockers/conflicts to PM only
2. **Docker Socket Access**: Orchestrator accesses `/var/run/docker.sock` for container management
3. **HITL (Human-in-the-Loop)**: Admin↔Worker communication via Matrix relay
4. **Tool Call Format**: Text-based `TOOL_CALL: name ARGUMENTS: {...}` or native function calling

## Testing & Validation

- **Orchestrator Build**: `cd orchestrator; npm run build`
- **Python Lint**: `.venv\Scripts\python.exe -m py_compile <file>`
- **Shell Validation**: `bash -n <script>`
- **Docker Config Check**: `docker compose -f docker-compose.yml config`

## Key Configuration Files

| File | Purpose |
|------|---------|
| `project-config.md` | Execution modes (sequential/parallel), priority rules |
| `worker-communication-protocol.md` | PM-centralized routing rules |
| `timeout-policy.md` | 5min timeouts, 3 retries, escalation |
| `pm-failover.md` | Hot-standby PM with Plane state sync |
| `resource-scaling.md` | Conservative/Balanced/Aggressive modes |

## Development Methodology

Contributors (and the Claude Code contributor harness) follow **superpowers** as the single source of execution discipline:

> brainstorming → writing-plans → test-driven-development → systematic-debugging → verification-before-completion → code-review

Install it as a Claude Code plugin (`/plugin install superpowers@claude-plugins-official`) or use the team's vendored copy. Methodology source: [obra/superpowers](https://github.com/obra/superpowers) (MIT, © 2025 Jesse Vincent).

The runtime workers do **not** run superpowers directly — they follow a terse, tool-mapped translation bundled at `base-worker/skills/` (see its `NOTICE` for attribution). Superpowers is the contributor methodology; the bundled skills are the worker-facing equivalents loaded per role at runtime.

**Before claiming done, run `verification-before-completion`:** run the gates listed under *Testing & Validation* for what you touched and paste the actual output. Evidence before assertions — never claim "passing" without showing it.

## Messaging / Inbox

Admin→worker messages are written to the worker's HTTP inbox (`/webhooks/worker-inbox/:ticketId`), which is the **source of truth**. The orchestrator also dual-publishes those events to NATS; a worker can opt into a NATS subscriber by setting `WORKER_NATS_SUBSCRIBE=true` (see `base-worker/src/tools/nats_client.py`), but HTTP polling remains authoritative.

## Common Tasks

- **Add new tool to worker**: Edit `base-worker/src/tools/tool_registry.py`
- **Update Docker scaling**: Edit `docker-compose.yml` or `resource-scaling.md`
- **Change RBAC permissions**: Edit `orchestrator/src/core/rbac.ts`

## Anti-Patterns

- **DO NOT** add direct peer worker communication (must route through PM)
- **DO NOT** expose API keys directly in worker containers (use orchestrator gateway proxy)
- **DO NOT** use `applyTo: "**"` in instructions (burns context window)