---
name: taiga-integration
description: '**SKILL** — Taiga ticket management for Turing OS. Use when: creating tickets, updating task status, reading ticket details, managing sprints, tracking story points, or integrating with Taiga webhooks. Triggers: "tạo ticket", "cập nhật trạng thái", "Taiga webhook", "ticket management", "sprint planning"'
user-invocable: true
---

# Taiga Integration Skill

## When to Use

This skill handles Taiga ticket and project management:
- Creating and updating tickets
- Reading ticket details and comments
- Managing sprint boards
- Webhook handling for task events
- Story point estimation
- Status transitions

## Taiga Configuration

| Setting | Value |
|---------|-------|
| URL | Configured via `TAIGA_URL` in `taiga.env` |
| Port | 9000 |
| API | `/api/v1/` |
| Webhook Secret | Stored in BookStack |

## API Usage

### Authentication

```python
# Get JWT token
POST https://taiga.example.com/api/v1/auth
Body: {"username": "...", "password": "..."}

# Use token in requests
Headers: {"Authorization": "Bearer <token>"}
```

### Ticket Operations

```python
# Create ticket
POST /api/v1/userstories
Body: {
    "project": <project_id>,
    "subject": "Task title",
    "description": "Details...",
    "priority": <priority_id>,
    "status": <status_id>
}

# Update status
PATCH /api/v1/userstories/<id>
Body: {"status": <new_status_id>}

# Add comment
POST /api/v1/userstories/<id>/comments
Body: {"comment": "Progress update..."}
```

### Common Status Values

| Status | ID | Description |
|--------|-----|-------------|
| New | 1 | Just created |
| In Progress | 2 | Being worked on |
| Blocked | 3 | Waiting on something |
| Review | 4 | Waiting for review |
| Done | 5 | Completed |

## Webhook Events

Taiga sends webhooks to orchestrator on:
- `userstory.create` — New ticket created
- `userstory.change` — Status/field changed
- `userstory.delete` — Ticket deleted
- `task.create`, `task.change` — Task events

### Webhook Handler

```typescript
// orchestrator/src/api/webhooks.ts
app.post('/webhooks/taiga', (req, res) => {
  const event = req.body;
  switch (event.action) {
    case 'userstory.create':
      // New ticket from PO → queue for PM
    case 'userstory.change':
      // Status update → update tracking
  }
});
```

## Tool Integration (Worker Side)

Workers use Taiga tools in `base-worker/src/tools/taiga_tools.py`:

```python
TOOL_CALL: create_ticket
ARGUMENTS: {"title": "...", "description": "...", "priority": "P2"}

TOOL_CALL: update_ticket_status
ARGUMENTS: {"ticket_id": "TASK-123", "status": "in_progress"}

TOOL_CALL: add_comment
ARGUMENTS: {"ticket_id": "TASK-123", "comment": "Blocked on API approval"}
```

## Best Practices

1. **Always checkpoint** before status changes
2. **Use correct status IDs** (not strings) for API
3. **Add comments** for progress tracking
4. **Link related tickets** in description
5. **Set priority** explicitly (P0-P3)

## Related Files

- `taiga.env` — Environment configuration
- `base-worker/src/tools/taiga_tools.py` — Worker tools
- `pm-failover.md` — PM state sync to Taiga