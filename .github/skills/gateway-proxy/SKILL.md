---
name: gateway-proxy
description: '**SKILL** — Gateway proxy and credential vault for Turing OS. Use when: understanding secure API access, vault patterns, consumer tokens, secret management via BookStack, or troubleshooting 401/403 errors. Triggers: "gateway", "vault", "proxy", "consumer token", "secret", "BookStack"'
user-invocable: true
---

# Gateway Proxy Skill

## When to Use

This skill covers the gateway proxy and credential vault:
- Understanding secure API access patterns
- Vault and secret management (env-imported credentials)
- Consumer token system
- Service proxies (LLM / Plane / BookStack / Matrix)
- Troubleshooting authentication errors
- Adding new protected services

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Gateway Proxy                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Proxy Handler                         │   │
│  │  1. Validate consumer token                              │   │
│  │  2. Check RBAC permissions                               │   │
│  │  3. Route to appropriate handler                         │   │
│  │  4. Return response                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                    │                    │              │
│         ▼                    ▼                    ▼              │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐        │
│  │ Credential  │     │  Consumer  │     │    RBAC     │        │
│  │   Vault    │     │   Token    │     │   Service   │        │
│  └─────┬──────┘     └─────┬──────┘     └─────┬──────┘        │
│        │                  │                  │                 │
│        ▼                  ▼                  ▼                 │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐        │
│  │  Env-       │     │   Token    │     │    Role     │        │
│  │  imported  │     │   Store    │     │ Permissions │        │
│  │  secrets   │     │            │     │             │        │
│  └────────────┘     └────────────┘     └────────────┘        │
│        │                                                       │
│        ▼  proxies                                              │
│   LLM · Plane · BookStack · Matrix                             │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### Consumer Token Manager

```typescript
// orchestrator/src/core/consumer-token.ts
interface ConsumerToken {
  workerId: string;
  role: string;
  permissions: string[];
  expiresAt: Date;
}

// Generate short-lived token for worker. Permissions follow the
// <service>:<action> scheme from rbac.ts (llm/plane/bookstack/matrix/github).
const token = consumerTokenManager.generateToken({
  workerId: 'se-001',
  role: 'software-engineer',
  permissions: ['llm:*', 'plane:read', 'plane:write', 'bookstack:read'],
  expiresIn: '1h',
});
```

### Credential Vault

```typescript
// orchestrator/src/core/credential-vault.ts

// Workers NEVER hold API keys. The vault stores credentials encrypted
// (AES-256), imported from environment variables on startup via
// importFromEnvironment() (OPENAI_API_KEY, PLANE_API_TOKEN, BOOKSTACK_TOKEN,
// MATRIX_BOT_TOKEN, GITHUB_TOKEN, ...). The proxy fetches the credential and
// injects it server-side — workers never see the raw key.

const vault = getCredentialVault();
const cred = await vault.getCredentialByType('plane'); // { key, authHeader, ... }
```

### Service Proxies

```typescript
// orchestrator/src/core/gateway/proxy-handler.ts
// Path scheme: /gateway/<service>/<endpoint>. The handler dispatches by service:
//   /gateway/llm/...       → LLMProxy
//   /gateway/plane/...     → PlaneProxy
//   /gateway/bookstack/... → BookStackProxy
//   /gateway/matrix/...    → MatrixProxy
//   /gateway/health        → liveness check
```

## Request Flow

### Worker Request: LLM Completion

```
1. Worker → POST /gateway/llm/chat/completions
   Headers: { Authorization: "Bearer <consumer_token>" }

2. Gateway validates token
   - Token valid? Not expired? Rate limit OK?

3. Gateway checks RBAC
   - canAccessService('software-engineer', 'llm')?

4. Gateway injects the vault LLM credential and forwards upstream
   - Worker never sees the raw API key

5. Gateway returns the upstream response
```

### Worker Request: Create Plane Ticket

```
1. Worker → POST /gateway/plane/issues
   Headers: { Authorization: "Bearer <consumer_token>" }
   Body: { name: "...", project: "<id>" }

2. Gateway validates token + RBAC
   - canAccessService(role, 'plane') AND canPerformAction(role, 'plane', 'write')

3. Gateway forwards to Plane
   - Injects the vault Plane token, strips worker credentials

4. Gateway returns the Plane response
```

## Consumer Token Format

```typescript
interface JWTPayload {
  sub: string;      // worker ID
  role: string;     // software-engineer
  perms: string[];  // ['llm:*', 'plane:read', 'plane:write', 'bookstack:read']
  iat: number;      // issued at
  exp: number;       // expires at
}

// Token is signed with orchestrator secret
// Workers cannot forge tokens (signature verification)
```

## Troubleshooting

### 401 Unauthorized
```typescript
// Token missing or invalid
const token = req.headers['authorization'];
if (!token) {
  return { status: 401, body: { error: 'No token provided' } };
}

// Token expired
try {
  jwt.verify(token, secret);
} catch (err) {
  if (err.name === 'TokenExpiredError') {
    return { status: 401, body: { error: 'Token expired' } };
  }
}
```

### 403 Forbidden
```typescript
// Valid token but no permission for this service/action
const rbac = getRBACService();
if (!rbac.canAccessService(role, service)) {
  return { status: 403, body: { error: `Access denied for service: ${service}` } };
}
if (service !== 'llm' && !rbac.canPerformAction(role, service, methodToAction(method))) {
  return { status: 403, body: { error: `Role '${role}' lacks ${service} permission` } };
}
```

### Missing Credential
```typescript
// The vault has no credential for this service (env var not set on startup)
const cred = await vault.getCredentialByType(service);
if (!cred) {
  return { status: 500, body: { error: `No ${service} credential configured` } };
}
```

## Vault Credential Source

Credentials are stored encrypted in the vault and imported from environment
variables at startup (`credential-vault.ts` `importFromEnvironment`):

| Env var | Vault type / provider |
|---------|-----------------------|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` / `GOOGLE_API_KEY` | `llm` |
| `PLANE_API_TOKEN` | `plane` |
| `BOOKSTACK_TOKEN` | `bookstack` |
| `MATRIX_BOT_TOKEN` | `matrix` |
| `GITHUB_TOKEN` | `github` |

## Adding a New Credential / Service Permission

1. Add the env var to `.env` / `.env.example` and the `envMappings` list in
   `importFromEnvironment()` (`credential-vault.ts`).

2. Grant the service to roles in `rbac.ts`:
   ```typescript
   // In ROLE_PERMISSIONS
   'software-engineer': [
     // ... existing ...
     'github:read', 'github:write',
   ],
   ```

## Related Files

- `orchestrator/src/core/gateway/proxy-handler.ts` — Main proxy logic
- `orchestrator/src/core/credential-vault.ts` — Vault implementation
- `orchestrator/src/core/consumer-token.ts` — Token management
- `orchestrator/src/core/rbac.ts` — Permission checking