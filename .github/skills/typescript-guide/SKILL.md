---
name: typescript-guide
description: '**SKILL** — TypeScript and Express best practices for Turing OS orchestrator. Use when: writing TypeScript code for orchestrator, adding API endpoints, working with Express routes, using async/await patterns, implementing TypeScript strict mode, or debugging TypeScript issues. Triggers: "TypeScript", "Express route", "async await", "type safety", "orchestrator code"'
user-invocable: true
---

# TypeScript Guide for Turing OS

## When to Use

This skill covers TypeScript development for the orchestrator:
- Writing new API endpoints in Express
- Understanding existing orchestrator TypeScript code
- Type safety and strict mode patterns
- Async/await and error handling
- Working with Dockerode and other async libraries

## Orchestrator Tech Stack

| Package | Purpose | Import |
|---------|---------|--------|
| `express` | HTTP server | `import express from 'express'` |
| `dockerode` | Docker API | `import Docker from 'dockerode'` |
| `jsonwebtoken` | JWT auth | `import jwt from 'jsonwebtoken'` |
| `redis` | Cache / state | `import { createClient } from 'redis'` |
| `nats` | Messaging | `import { connect } from 'nats'` |

There is no third-party HTTP client (no `axios`); outbound calls use the
built-in `fetch`.

## Express Patterns

### Route Structure
```typescript
// orchestrator/src/api/webhooks.ts
import { Router } from 'express';
const router = Router();

router.post('/plane', async (req, res) => {
  try {
    const event = req.body;
    // Handle Plane webhook (ticket → worker provisioning)
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export { router as webhooksRouter };
```

### Async Error Handling
```typescript
// Always wrap async route handlers
router.get('/workers', async (req, res, next) => {
  try {
    const workers = await registry.getAllWorkers();
    res.json({ workers });
  } catch (err) {
    next(err); // Pass to error middleware
  }
});
```

### Request Validation
```typescript
interface PlaneWebhookPayload {
  ticket_id: string;
  status?: string;
  state?: { group?: string; name?: string };
  role?: string;
  priority?: string;
  description?: string;
}

router.post('/plane', (req, res) => {
  const payload = req.body as PlaneWebhookPayload;
  // TypeScript knows the shape of payload
});
```

## TypeScript Strict Mode

### Strict Configuration
```json
// orchestrator/tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### Null Safety
```typescript
// ❌ Bad
function getWorker(id: string) {
  return workers.get(id); // might be undefined
}

// ✅ Good
function getWorker(id: string): Worker | undefined {
  return workers.get(id);
}

// ✅ With nullish coalescing
const worker = getWorker(id) ?? defaultWorker;
```

## Common Patterns

### Dockerode Usage
```typescript
import Docker from 'dockerode';

const docker = new Docker();

async function spawnWorker(config: WorkerConfig) {
  const container = await docker.createContainer({
    Image: 'turing-worker:latest',
    Env: [
      `TICKET_ID=${config.ticketId}`,
      `ROLE=${config.role}`,
      // ...
    ],
    HostConfig: {
      Memory: 512 * 1024 * 1024, // 512MB
      CPUPeriod: 100000,
      CPUQuota: 50000, // 50% CPU
    }
  });
  await container.start();
  return container.id;
}
```

### Priority Queue Usage
```typescript
import { priorityQueue } from './core/priority-queue';

interface Task {
  id: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  data: any;
}

// Add task
priorityQueue.enqueue(task);

// Get next task
const next = priorityQueue.dequeue();

// Interrupt for P0
priorityQueue.interrupt(newP0Task);
```

## Validation

```powershell
# Build with TypeScript
Set-Location orchestrator
npm run build

# Type check only
npx tsc --noEmit

# Run tests
npm test
```

## Related Files

- `orchestrator/tsconfig.json` — TypeScript config
- `orchestrator/src/api/webhooks.ts` — API example
- `orchestrator/src/core/docker.ts` — Dockerode usage
- `orchestrator/src/core/priority-queue.ts` — Queue implementation