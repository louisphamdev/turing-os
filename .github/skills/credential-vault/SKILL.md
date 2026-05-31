---
name: credential-vault
description: '**SKILL** — Credential and secret management for Turing OS. Use when: storing API keys, managing secrets, rotating credentials, vault operations, or secure credential retrieval through the gateway. Triggers: "secret", "credential", "API key", "vault"'
user-invocable: true
---

# Credential Vault Skill

## When to Use

This skill handles secure credential management:
- Storing and retrieving secrets from the orchestrator vault
- Managing API keys and tokens
- Credential rotation
- Access control for secrets
- Gateway proxy credential flow

## Architecture

The orchestrator **credential vault** (`credential-vault.ts`) is the centralized
secret store: AES-256-encrypted on disk, imported from environment variables on
startup. Workers never read it directly — the gateway proxy injects credentials
server-side.

```
┌─────────────────────────────────────────────────────────┐
│              Orchestrator Credential Vault                 │
│  (AES-256 at rest, imported from env via                   │
│   importFromEnvironment())                                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Stored credential types                         │   │
│  │  • llm        (OPENAI/ANTHROPIC/MINIMAX/GOOGLE)  │   │
│  │  • plane      (PLANE_API_TOKEN)                  │   │
│  │  • bookstack  (BOOKSTACK_TOKEN)                  │   │
│  │  • matrix     (MATRIX_BOT_TOKEN)                 │   │
│  │  • github     (GITHUB_TOKEN)                     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         │  injected server-side by the gateway proxy
         ▼
   ┌──────────┐         ┌──────────┐
   │ Gateway  │ ◄────── │ Workers  │  (GATEWAY_URL + CONSUMER_TOKEN)
   │  proxy   │         │          │
   └──────────┘         └──────────┘
```

## Key Principle

> **Workers NEVER hold raw API keys.** They call `GATEWAY_URL/gateway/<service>/...`
> with `CONSUMER_TOKEN`; the gateway injects the vault credential server-side.

## Vault Credential Source

Credentials are imported from environment variables at startup by
`importFromEnvironment()`:

| Env var | Vault type / provider |
|---------|-----------------------|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` / `GOOGLE_API_KEY` | `llm` |
| `PLANE_API_TOKEN` | `plane` |
| `BOOKSTACK_TOKEN` | `bookstack` |
| `MATRIX_BOT_TOKEN` | `matrix` |
| `GITHUB_TOKEN` | `github` |

The master encryption key comes from `VAULT_MASTER_KEY` (required, ≥32 chars).

### Retrieve a Service (Workers)

```python
# Workers call the gateway, never the vault directly. The gateway injects the
# credential, so the worker only needs CONSUMER_TOKEN.
import os, requests
resp = requests.get(
    f"{os.environ['GATEWAY_URL']}/gateway/bookstack/books",
    headers={"Authorization": f"Bearer {os.environ['CONSUMER_TOKEN']}"},
)
```

## Gateway Proxy Pattern

```
Worker Request                          Gateway Behavior
─────────────────────────────────────────────────────────────────────
/gateway/<service>/<endpoint>   →  Validate consumer token + rate limit
                                →  Check RBAC (canAccessService + canPerformAction)
                                →  Inject the vault credential for <service>
                                →  Forward upstream, return (no raw key exposure)
```

### RBAC Enforcement

Service access is role-based (`rbac.ts`, `ROLE_PERMISSIONS`):

| Role | Services |
|------|----------|
| software-engineer | llm:*, plane (read/write), bookstack (read/write), github (read/write/repo) |
| qa | llm:read, plane (read/write), bookstack:read, github:read |
| devops | llm:read, plane:read, bookstack (read/write), github (read/write/repo), matrix |
| security | broad: plane:*, bookstack:*, github:*, matrix:* |

## Credential Rotation

The vault exposes rotation directly (`credential-vault.ts`):

```typescript
const vault = getCredentialVault();
await vault.rotateCredential(id, 'new-secret-value'); // re-encrypts, clears cache
await vault.revokeCredential(id);                     // marks expired immediately
```

To change a key permanently, update the env var and restart so
`importFromEnvironment()` re-imports it.

## Anti-Patterns

- **NEVER** hardcode API keys in worker code
- **NEVER** log credential values
- **NEVER** pass secrets as command-line arguments
- **NEVER** ship raw API keys into worker containers — workers use `GATEWAY_URL` + `CONSUMER_TOKEN` only

## Related Files

- `orchestrator/src/core/credential-vault.ts` — Vault implementation (encrypt, import, rotate)
- `orchestrator/src/core/gateway/proxy-handler.ts` — Proxy and credential injection
- `orchestrator/src/core/rbac.ts` — Access control