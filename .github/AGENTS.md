# Turing OS — Custom Agents Registry

This file registers custom agents for Project Turing OS.

## Agents

| Agent | File | Description |
|-------|------|-------------|
| `turing-orchestrator` | [.github/agents/turing-orchestrator.agent.md](.github/agents/turing-orchestrator.agent.md) | Orchestrator: TypeScript/Express, Docker, worker lifecycle |
| `turing-worker` | [.github/agents/turing-worker.agent.md](.github/agents/turing-worker.agent.md) | Worker: Python ReAct, tools, skill loading |
| `turing-devops` | [.github/agents/turing-devops.agent.md](.github/agents/turing-devops.agent.md) | DevOps: Docker, CI/CD, infrastructure, scaling |
| `turing-code-review` | [.github/agents/turing-code-review.agent.md](.github/agents/turing-code-review.agent.md) | Code review: TypeScript/Python, tests, security |
| `turing-security` | [.github/agents/turing-security.agent.md](.github/agents/turing-security.agent.md) | Security: auth, RBAC, prompt injection |


## Skills

| Skill | File | Description |
|-------|------|-------------|
| `typescript-guide` | [.github/skills/typescript-guide/SKILL.md](.github/skills/typescript-guide/SKILL.md) | TypeScript/Express: patterns, async, strict mode |
| `python-worker-guide` | [.github/skills/python-worker-guide/SKILL.md](.github/skills/python-worker-guide/SKILL.md) | Python worker: httpx, ReAct, tool implementation |
| `rbac-permissions` | [.github/skills/rbac-permissions/SKILL.md](.github/skills/rbac-permissions/SKILL.md) | RBAC: role permissions, access control |
| `gateway-proxy` | [.github/skills/gateway-proxy/SKILL.md](.github/skills/gateway-proxy/SKILL.md) | Gateway: vault, consumer tokens, BookStack |
| `docker-workflow` | [.github/skills/docker-workflow/SKILL.md](.github/skills/docker-workflow/SKILL.md) | Docker: container management, health, scaling |
| `intent-parser` | [.github/skills/intent-parser/SKILL.md](.github/skills/intent-parser/SKILL.md) | Intent parsing: NL → structured (Vietnamese support) |
| `testing` | [.github/skills/testing/SKILL.md](.github/skills/testing/SKILL.md) | Testing: Jest, pytest, syntax validation |
| `taiga-integration` | [.github/skills/taiga-integration/SKILL.md](.github/skills/taiga-integration/SKILL.md) | Taiga: ticket CRUD, webhooks, sprint management |
| `research-tools` | [.github/skills/research-tools/SKILL.md](.github/skills/research-tools/SKILL.md) | Context7: tech research, documentation fetching |
| `credential-vault` | [.github/skills/credential-vault/SKILL.md](.github/skills/credential-vault/SKILL.md) | BookStack vault: secret storage, credential rotation |

## Usage

### Invoking Agents

```
/turing-orchestrator <question>  # Orchestrator architecture, API
/turing-worker <question>       # Worker implementation, tools
/turing-devops <question>       # Docker, CI/CD, infra
/turing-code-review <file>      # Review code changes
/turing-security <area>         # Security audit
```

### Invoking Skills (Slash Commands)

```
/typescript-guide               # TypeScript/Express patterns
/python-worker-guide            # Python worker development
/rbac-permissions               # Role permissions & access
/gateway-proxy                  # Vault & consumer tokens
/docker-workflow                # Container management
/intent-parser                  # Intent parsing
/testing                        # Testing & validation
/taiga-integration              # Ticket management
/research-tools                 # Tech research
/credential-vault               # Secrets management
```

### Global Instructions

See [copilot-instructions.md](copilot-instructions.md) for project-wide agent instructions.