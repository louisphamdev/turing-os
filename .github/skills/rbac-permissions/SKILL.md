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

### Resources and Actions

```typescript
// orchestrator/src/core/rbac.ts
interface Permission {
  resource: string;  // 'tickets', 'workers', 'vault', 'matrix'
  action: string;     // 'create', 'read', 'update', 'delete', 'execute'
}

const ROLE_PERMISSIONS = {
  'pm': [
    { resource: 'tickets', actions: ['create', 'read', 'update', 'delete'] },
    { resource: 'workers', actions: ['read', 'assign'] },
    { resource: 'queue', actions: ['enqueue', 'dequeue', 'interrupt'] },
  ],
  'software-engineer': [
    { resource: 'tickets', actions: ['read', 'update'] }, // Own tickets only
    { resource: 'tools', actions: ['execute'] },
    { resource: 'matrix', actions: ['send'] },
  ],
  // ...
};
```

## Checking Permissions

### In Gateway Proxy
```typescript
// orchestrator/src/core/gateway/proxy-handler.ts
import { getRBACService } from '../rbac';

function handleWorkerRequest(req: Request) {
  const workerRole = req.headers['x-worker-role'];
  const resource = req.path;
  const action = req.method.toLowerCase();

  const allowed = rbacService.canAccess(workerRole, resource, action);
  if (!allowed) {
    return { status: 403, body: { error: 'Permission denied' } };
  }
  return { status: 200 };
}
```

### Using RBAC Service
```typescript
import { getRBACService } from './core/rbac';

const rbac = getRBACService();

// Check if role can access resource
const result = rbac.canAccess('se', 'tickets', 'create');
// result: { allowed: true } or { allowed: false, reason: "SE cannot create tickets" }

// Check if role has any permission on resource
const perms = rbac.getPermissions('pm');
// perms: [{ resource: 'tickets', actions: ['create', 'read', ...] }]
```

## Adding New Role

### 1. Create Role Definition
```typescript
// orchestrator/src/core/rbac.ts

const ROLE_PERMISSIONS = {
  // ... existing roles ...

  'new-role': [
    { resource: 'tickets', actions: ['read'] },
    { resource: 'workers', actions: ['read'] },
  ],
};
```

### 2. Update Role Hierarchy
```typescript
const ROLE_HIERARCHY = {
  'po': 1,
  'pm': 2,
  'hr': 3,
  'new-role': 4,  // Same level as SE/QA
};
```

### 3. Add Worker Type (if needed)
```typescript
// In worker spawn config
const WORKER_ROLES = {
  'new-role': {
    image: 'turing-worker:latest',
    skills: ['new-role-skill'],
  },
};
```

## Debugging Permission Errors

### Common Error: "Permission denied"
```typescript
// Check worker role in request
console.log('Worker role:', req.headers['x-worker-role']);

// Check actual permissions
const perms = rbacService.getPermissions('se');
console.log('SE permissions:', perms);

// Check if resource/action exists
const can = rbacService.canAccess('se', 'tickets', 'delete');
console.log('Can SE delete tickets?', can);
// Expected: false (SE cannot delete tickets)
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
1. Worker makes request to /vault/<secret>
2. Gateway extracts token from header
3. Gateway validates token with consumer-token service
4. Gateway checks RBAC: can this role access /vault/*?
5. If allowed → fetch from BookStack, return value
6. If denied → 403 Forbidden
```

## Related Files

- `orchestrator/src/core/rbac.ts` — RBAC implementation
- `orchestrator/src/core/gateway/proxy-handler.ts` — Gateway enforcement
- `orchestrator/src/core/consumer-token.ts` — Token validation
- `roles/*.md` — Role definitions