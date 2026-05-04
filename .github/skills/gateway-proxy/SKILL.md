---
name: gateway-proxy
description: '**SKILL** — Gateway proxy and credential vault for Turing OS. Use when: understanding secure API access, vault patterns, consumer tokens, secret management via BookStack, or troubleshooting 401/403 errors. Triggers: "gateway", "vault", "proxy", "consumer token", "secret", "BookStack"'
user-invocable: true
---

# Gateway Proxy Skill

## When to Use

This skill covers the gateway proxy and credential vault:
- Understanding secure API access patterns
- Vault and secret management
- Consumer token system
- BookStack integration for secrets
- Troubleshooting authentication errors
- Adding new protected endpoints

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
│  │  BookStack   │     │   Token    │     │    Role     │        │
│  │  (secrets) │     │   Store    │     │ Permissions │        │
│  └────────────┘     └────────────┘     └────────────┘        │
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

// Generate short-lived token for worker
const token = consumerTokenManager.generateToken({
  workerId: 'se-001',
  role: 'software-engineer',
  permissions: ['tickets:read', 'tools:execute', 'matrix:send'],
  expiresIn: '1h',
});
```

### Credential Vault

```typescript
// orchestrator/src/core/credential-vault.ts

// Workers NEVER have direct API keys
// They request through vault:

async function getSecret(workerId: string, key: string): Promise<string | null> {
  // 1. Check RBAC - can this worker access this key?
  const allowed = rbacService.canAccess(workerRole, 'vault', 'read');
  if (!allowed) {
    throw new Error('Permission denied');
  }

  // 2. Fetch from BookStack
  const doc = await wikijs.get('/api/secrets', { key });

  // 3. Return value (not the key)
  return doc.value;
}
```

### Proxy Handlers

```typescript
// orchestrator/src/core/gateway/proxy-handler.ts
const handlers = {
  '/vault/': handleVaultRequest,      // Secret access
  '/taiga/': handleTaigaRequest,        // Taiga API proxy
  '/context7/': handleContext7Request,  // Research API proxy
};
```

## Request Flow

### Worker Request: Get Secret

```
1. Worker → GET /vault/openai.api_key
   Headers: { Authorization: "Bearer <consumer_token>" }

2. Gateway validates token
   - Token valid? Not expired?
   - Token belongs to worker?

3. Gateway checks RBAC
   - Can 'se' role access '/vault/*'?

4. Gateway fetches from BookStack
   - GET /api/query?key=openai.api_key

5. Gateway returns secret value
   - Response: { value: "sk-..." }
```

### Worker Request: Create Taiga Ticket

```
1. Worker → POST /taiga/userstories
   Headers: { Authorization: "Bearer <consumer_token>" }
   Body: { subject: "...", project: 1 }

2. Gateway validates token + RBAC
   - Can 'se' role create tickets?

3. Gateway forwards to Taiga
   - Adds system auth headers
   - Strips worker credentials

4. Gateway returns Taiga response
```

## Consumer Token Format

```typescript
interface JWTPayload {
  sub: string;      // worker ID
  role: string;     // software-engineer
  perms: string[];  // ['tickets:read', 'tools:execute']
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
// Valid token but no permission
const allowed = rbacService.canAccess(role, resource, action);
if (!allowed) {
  return {
    status: 403,
    body: { error: `Role '${role}' cannot '${action}' on '${resource}'` }
  };
}
```

### Vault Key Not Found
```typescript
// Secret doesn't exist in BookStack
const doc = await wikijs.get('/api/secrets', { key });
if (!doc) {
  return { status: 404, body: { error: 'Secret not found' } };
}
```

## BookStack Secret Structure

```javascript
// BookStack collection: 'secrets'
{
  key: "openai.api_key",           // Unique identifier
  value: "sk-...",                 // The actual secret
  tags: ["production", "llm"],     // For filtering
  allowedRoles: ["se", "qa"],      // Who can access
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z"
}
```

## Adding New Vault Key

1. Store in BookStack:
   ```
   POST /api/query
   {
     "collection": "secrets",
     "document": {
       "key": "my-new-api-key",
       "value": "secret-value",
       "tags": ["development"],
       "allowedRoles": ["se"]
     }
   }
   ```

2. Update RBAC if needed:
   ```typescript
   // In rbac.ts
   const ROLE_PERMISSIONS = {
     'se': [
       // ... existing ...
       { resource: 'vault', actions: ['read'], keys: ['my-new-api-key'] },
     ],
   };
   ```

## Related Files

- `orchestrator/src/core/gateway/proxy-handler.ts` — Main proxy logic
- `orchestrator/src/core/credential-vault.ts` — Vault implementation
- `orchestrator/src/core/consumer-token.ts` — Token management
- `orchestrator/src/core/rbac.ts` — Permission checking