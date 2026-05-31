---
name: rbac-permissions
description: '**SKILL** — RBAC permission system for Turing OS. Use when: understanding role permissions, adding new roles, modifying access control, debugging permission denied errors, or configuring worker capabilities. Triggers: "RBAC", "permissions", "access control", "role", "denied"'
user-invocable: true
---

# RBAC Permissions Skill

## When to Use

This skill covers the role-based access control system:
- Understanding existing role permissions
- Adding new roles or permissions
- Debugging "permission denied" errors
- Configuring worker capabilities
- Gateway proxy access control

## Architecture

RBAC is enforced at the **orchestrator gateway** level:

```
Worker Request
     │
     ▼
Gateway Proxy
     │
     ├── Validate worker token
     ├── Check RBAC permissions
     │
     ▼
Allowed? ──── No ──── 403 Forbidden
     │
    Yes
     │
     ▼
Execute request
```

## Permission Structure

### Roles (from `roles/` directory)

| Role | Level | Description |
|------|-------|-------------|
| `po` | 1 | Product Owner - business decisions |
| `pm` | 2 | Project Manager - task coordination |
| `hr` | 3 | HR - skill matching |
| `software-engineer` | 4 | Developer |
| `qa` | 4 | Quality Assurance |
| `devops` | 4 | Infrastructure |
| `data` | 4 | Data analyst |
| `security` | 4 | Security engineer |

### Services and Permissions

Permissions are `<service>:<action>` strings, where service ∈
`llm | plane | bookstack | matrix | github` and action ∈ `read | write | *`
(plus the global `*`). `ROLE_PERMISSIONS` maps each role to a flat list.

```typescript
// orchestrator/src/core/rbac.ts
type Permission =
  | 'llm:read' | 'llm:write' | 'llm:*'
  | 'plane:read' | 'plane:write' | 'plane:create-task' | 'plane:*'
  | 'bookstack:read' | 'bookstack:write' | 'bookstack:*'
  | 'matrix:read' | 'matrix:write' | 'matrix:*'
  | 'github:read' | 'github:write' | 'github:repo' | 'github:*'
  | '*';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  'pm': [
    'llm:read',
    'plane:*',
    'bookstack:read', 'bookstack:write',
    'matrix:read', 'matrix:write',
  ],
  'software-engineer': [
    'llm:*',
    'plane:read', 'plane:write', 'plane:create-task',
    'bookstack:read', 'bookstack:write',
    'github:read', 'github:write', 'github:repo',
  ],
  // ...
};
```

## Checking Permissions

### In Gateway Proxy
```typescript
// orchestrator/src/core/gateway/proxy-handler.ts
import { getRBACService, methodToAction } from '../rbac';

// Path is /gateway/<service>/<endpoint>; role comes from the validated token.
const rbac = getRBACService();
if (!rbac.canAccessService(role, service)) {
  res.status(403).json({ error: `Access denied for service: ${service}` });
  return;
}
// Non-LLM services also get a method-level action check.
if (service !== 'llm' && !rbac.canPerformAction(role, service, methodToAction(method))) {
  res.status(403).json({ error: `Access denied: role '${role}' lacks ${service} permission` });
  return;
}
```

### Using RBAC Service
```typescript
import { getRBACService } from './core/rbac';

const rbac = getRBACService();

// Check if a role can access a service ('llm'|'plane'|'bookstack'|'matrix'|'github')
const allowed = rbac.canAccessService('software-engineer', 'plane'); // boolean

// Check a method-level action
const canWrite = rbac.canPerformAction('software-engineer', 'plane', 'write'); // boolean

// List a role's permissions
const perms = rbac.getPermissionsForRole('pm');
// perms: ['llm:read', 'plane:*', 'bookstack:read', 'bookstack:write', ...]
```

## Adding New Role

### 1. Add Role to the `Role` Union and `ROLE_PERMISSIONS`
```typescript
// orchestrator/src/core/rbac.ts

export type Role = /* ...existing... */ | 'new-role';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // ... existing roles ...

  'new-role': [
    'llm:read',
    'plane:read',
    'bookstack:read',
  ],
};
```

### 2. Add Matching Rate Limit and Token Expiry
```typescript
// Same file: ROLE_RATE_LIMITS and ROLE_TOKEN_EXPIRY are also Record<Role, ...>,
// so a new role must have entries there too or TypeScript will fail to compile.
ROLE_RATE_LIMITS['new-role'] = { requests: 30, windowMs: 60000 };
ROLE_TOKEN_EXPIRY['new-role'] = 24;
```

## Debugging Permission Errors

### Common Error: "Permission denied"
```typescript
const rbac = getRBACService();

// Check actual permissions for the role
const perms = rbac.getPermissionsForRole('software-engineer');
console.log('SE permissions:', perms);

// Check service access + method-level action
console.log('Can SE reach plane?', rbac.canAccessService('software-engineer', 'plane'));
console.log('Can SE write plane?', rbac.canPerformAction('software-engineer', 'plane', 'write'));
```

### Error Codes
| Code | Meaning |
|------|---------|
| 401 | Unauthorized - no/invalid token |
| 403 | Forbidden - valid token but no permission |
| 404 | Resource not found |
| 500 | Internal error |

## Gateway Proxy Flow

```
1. Worker calls /gateway/<service>/<endpoint> (e.g. /gateway/plane/issues)
2. Gateway extracts the consumer token from the Authorization header
3. Gateway validates the token (consumer-token service)
4. Gateway checks RBAC: canAccessService(role, service) + canPerformAction(...)
5. If allowed → proxy injects the vault credential and forwards to the service
6. If denied → 403 Forbidden
```

## Related Files

- `orchestrator/src/core/rbac.ts` — RBAC implementation
- `orchestrator/src/core/gateway/proxy-handler.ts` — Gateway enforcement
- `orchestrator/src/core/consumer-token.ts` — Token validation
- `roles/*.md` — Role definitions