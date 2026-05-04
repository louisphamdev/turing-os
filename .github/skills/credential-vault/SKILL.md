---
name: credential-vault
description: '**SKILL** — Credential and secret management for Turing OS. Use when: storing API keys, managing secrets, rotating credentials, BookStack vault operations, or secure credential retrieval. Triggers: "secret", "credential", "API key", "vault", "BookStack secrets"'
user-invocable: true
---

# Credential Vault Skill

## When to Use

This skill handles secure credential management:
- Storing and retrieving secrets from BookStack
- Managing API keys and tokens
- Credential rotation
- Access control for secrets
- Gateway proxy credential flow

## Architecture

BookStack serves as the **centralized secret store**:

```
┌─────────────────────────────────────────────────────────┐
│                    BookStack (Port 6875)                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Secret Store                                    │   │
│  │  • matrix.access_token                          │   │
│  │  • context7.api_key                             │   │
│  │  • taiga.jwt_token                              │   │
│  │  • openai.api_key                               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐         ┌──────────┐         ┌──────────┐
   │Orchestrator│        │ Workers  │         │ Gateway  │
   │  (read)   │         │  (read)  │         │  (read) │
   └──────────┘         └──────────┘         └──────────┘
```

## Key Principle

> **Workers NEVER have direct API keys.** They request credentials through the orchestrator gateway proxy.

## BookStack Secret Storage

### Store Secret

```javascript
// Via BookStack API
POST /api/query
Body: {
  "operation": "create",
  "collection": "secrets",
  "document": {
    "key": "openai.api_key",
    "value": "sk-...",
    "tags": ["production", "llm"]
  }
}
```

### Retrieve Secret (Workers)

```python
# Via orchestrator gateway (not direct BookStack access)
response = requests.get(
    "http://orchestrator:3001/vault/openai.api_key",
    headers={"Authorization": "Bearer <worker_token>"}
)
api_key = response.json()["value"]
```

## Gateway Proxy Pattern

```
Worker Request                    Gateway Behavior
─────────────────────────────────────────────────────────────────
GET /vault/<key>    →  Validate worker token
                      →  Check RBAC permissions for key
                      →  Fetch from BookStack
                      →  Return (no raw key exposure)
```

### RBAC Enforcement

Workers have role-based access to secrets:

| Role | Allowed Secrets |
|------|-----------------|
| SE | context7.api_key, github.token |
| QA | context7.api_key, taiga.token |
| DevOps | dockerhub.token, aws.credentials |
| * (all) | No direct secret access |

## Credential Rotation

### Manual Rotation

```javascript
// Update in BookStack
PUT /api/query
Body: {
  "operation": "update",
  "collection": "secrets",
  "filter": {"key": "openai.api_key"},
  "update": {"value": "sk-new-..."}
}
```

### Automatic Rotation

For high-security keys, implement rotation in orchestrator:
1. Generate new credential
2. Update BookStack
3. Invalidate old credential
4. Notify affected services

## Anti-Patterns

- **NEVER** hardcode API keys in worker code
- **NEVER** log credential values
- **NEVER** pass secrets as command-line arguments
- **NEVER** store credentials in environment variables (use BookStack)

## Related Files

- `orchestrator/src/core/gateway/` — Proxy and vault
- `orchestrator/src/core/rbac.ts` — Access control
- `docs/bmad-integration.md` — Security best practices