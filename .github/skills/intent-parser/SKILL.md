---
name: intent-parser
description: '**SKILL** — Intent parsing and natural language command processing for Project Turing OS. Use when: parsing user commands, extracting structured intent from natural language, handling Vietnamese language input, routing commands to appropriate handlers, or debugging intent parser behavior. Triggers: "parse intent", "extract command", "natural language to structured", "Vietnamese parsing", "intent detection"'
user-invocable: true
---

# Intent Parser Skill

## When to Use

This skill handles natural language → structured command parsing in the orchestrator:
- Parsing admin commands from Matrix/Synapse
- Extracting structured intent from user messages
- Handling Vietnamese language input
- Routing commands to appropriate role handlers
- Debugging intent parser behavior

## Architecture

The intent parser lives in `orchestrator/src/core/intent-parser.ts` and is used by:
- Matrix webhook handler (`orchestrator/src/api/webhooks.ts`)
- Direct API endpoint (`POST /api/intent/parse`)

## Usage

### API Endpoint

```typescript
POST /api/intent/parse
Body: { "message": "string", "role": "string" }
Response: {
  "intent": "string",
  "entities": {},
  "confidence": number,
  "routing": { "role": "string", "action": "string" }
}
```

### Direct Usage in Code

```typescript
import { IntentParser } from './core/intent-parser';

const parser = new IntentParser(config);
const result = await parser.parse('Tạo ticket cho việc fix bug login', 'admin');

// result.intent = 'create_ticket'
// result.entities = { title: 'fix login bug', priority: 'P2' }
// result.routing = { role: 'PM', action: 'queue_task' }
```

## Supported Intents

| Intent | Vietnamese | English | Entities |
|--------|------------|---------|----------|
| `create_ticket` | tạo ticket | create ticket | title, priority, assignee |
| `query_status` | trạng thái | status | task_id |
| `escalate` | leo cấp | escalate | reason, priority |
| `assign_task` | giao việc | assign task | target_role, task_id |
| `report_blocker` | báo cáo | report blocker | description |

## Confidence Thresholds

- **≥ 0.8**: High confidence, auto-execute
- **0.5–0.8**: Medium confidence, ask for confirmation
- **< 0.5**: Low confidence, fallback to help mode

## Vietnamese Language Support

The parser uses keyword matching for Vietnamese:
- `tạo` / `tạo ticket` → `create_ticket`
- `trạng thái` / `xem` → `query_status`
- `leo cấp` / `báo cáo` → `escalate`

## Debugging

```typescript
// Enable debug mode
const parser = new IntentParser({ ...config, debug: true });

// Get all matched patterns
const analysis = parser.analyze('your message here');
console.log(analysis.matchedPatterns);
console.log(analysis.confidence);
```

## Related Files

- `orchestrator/src/core/intent-parser.ts` — Main implementation
- `orchestrator/src/api/webhooks.ts` — Matrix webhook consumer
- `worker-communication-protocol.md` — Communication rules