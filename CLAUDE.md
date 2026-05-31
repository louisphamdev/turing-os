# CLAUDE.md — Turing OS

Canonical project memory for Claude Code and other coding agents. Keep this file
accurate against the code; if something here disagrees with the source, the
source wins — fix this file.

## Project overview

Turing OS is a multi-agent "IT department OS". An **orchestrator** spawns
ephemeral Python **worker** containers that run a ReAct loop ("Hermes"). Workers
never talk to the outside world directly — every external call goes through the
orchestrator **gateway**, which enforces RBAC and injects credentials. State
(tickets / user stories) lives in **Plane**.

## Architecture

### Orchestrator (`orchestrator/`, TypeScript / Express, port `3001`)
- Spawns ephemeral worker containers via Dockerode (auto-remove).
- **Gateway proxy** for all worker egress (LLM, Plane, BookStack, Matrix, GitHub
  — `/gateway/github` is the GitHub egress proxy for Doctor escalation).
- **RBAC** enforced on every proxied request.
- **Priority queue** (P0–P3) with P0 interrupt.
- **Health monitor**: heartbeat + flapping detection, checkpoint-based recovery.
- **Matrix relay**: bidirectional admin ↔ worker (per-worker rooms), admin
  slash-commands, structured-message injection.
- **Key endpoints**: `GET /metrics` (Prometheus exposition — workers-by-status,
  queue depth, gateway request/error counters; **unauthenticated by design,
  firewall to an internal scraper**), `POST /remediation` (Doctor allow-listed
  remediation, RBAC `remediation:execute`, **doctor role only**),
  `/gateway/github` (GitHub egress proxy).
- **Observability**: structured JSON logging with level gating via `LOG_LEVEL`
  (default `info`) + secret redaction, and an `X-Request-Id` request-correlation
  middleware. Metrics via `GET /metrics`.

### Worker (`base-worker/`, Python ReAct loop "Hermes")
- Agent loop in `base-worker/src/agent/hermes_loop.py`.
- Tools in `base-worker/src/tools/*` reach external services **only** through the
  orchestrator gateway, authenticating with a per-worker `CONSUMER_TOKEN` (a
  short-lived JWT). Workers never receive raw API keys.
- State backend is **Plane** (`base-worker/src/tools/state_backend.py`); calls
  route through `GATEWAY_URL/gateway/plane/...` with the consumer token.
- Checkpoint-based: agent state saved periodically and restored on recovery.
- NATS is an optional dual-publish channel for the admin→worker inbox; the
  **HTTP poll inbox is the source of truth**, NATS is best-effort with
  worker-side dedup.

### Infrastructure (`docker-compose.yml`)
| Service | Bind | Purpose |
|---------|------|---------|
| Plane | host `:9000` | tickets / state backend + webhooks |
| BookStack | `:6875` | docs / known-issues |
| Matrix (Synapse) | `127.0.0.1:8008` | admin ↔ worker comms (localhost-only) |
| Element Web | `:8080` | chat UI for Matrix |
| Orchestrator | `:3001` | gateway, container manager, Matrix relay |
| Redis | internal | queue / state |
| NATS | internal | optional dual-publish inbox |

## Build / test / dev loop

These mirror `.github/workflows/ci.yml` — keep them in sync with that file.

**Orchestrator** (`orchestrator/`):
```bash
cd orchestrator && npm ci && npx tsc --noEmit && npm test
```
- `npm test` runs Jest (CI uses `npm test -- --ci`).
- Dev server: `npm run dev` (ts-node). Build: `npm run build` (tsc).

**Base worker** (`base-worker/`):
```bash
cd base-worker && pip install -r requirements.txt && pytest
```
- CI also runs `python -m py_compile` on `src/index.py`,
  `src/tools/state_backend.py`, `src/tools/nats_client.py`,
  `src/tools/pm_monitor.py`.

**Compose validation** (repo root):
```bash
cp .env.example .env && docker compose -f docker-compose.yml config
```

**Run the stack** (Makefile, repo root): `make build`, `make up`, `make bootstrap`
(creates Matrix admin/bot users + tokens), `make down`, `make logs`,
`make status`. Health check: `curl http://localhost:3001/health`.

## Security rules (non-negotiable)

1. **Workers never get raw API keys.** All worker egress is gateway-only,
   authenticated with the per-worker `CONSUMER_TOKEN` (JWT). The gateway injects
   real credentials from the vault.
2. **PM-centralized worker comms.** No worker↔worker direct messaging; admin chats
   only with PM/PO, who route work. Do not add peer-to-peer worker channels.
3. **Admin endpoints require `ADMIN_API_TOKEN`** (bearer). In-chat admin
   slash-commands are authorized against `MATRIX_ADMIN_USER_ID` — non-admin
   senders are rejected.
4. **Worker→orchestrator webhooks require the worker JWT** (consumer token).
5. **Never commit secrets.** Use `.env` (copied from `.env.example`); the vault
   holds real keys.

### Required secrets (orchestrator fails fast if missing/short)
- `JWT_SECRET` (≥32 chars) — signs worker consumer tokens.
- `VAULT_MASTER_KEY` (≥32 chars) — AES-256-GCM key for the credential vault.
- `ADMIN_API_TOKEN` (≥16 chars) — bearer for admin-only gateway endpoints.

The gateway is **mandatory / always on** — every worker gets a per-spawn consumer
token and all egress is proxied. The legacy `GATEWAY_ENABLED=false` direct-key
mode has been removed; there is no direct-key path.

## Key files map

| Area | Path |
|------|------|
| Gateway proxy + handlers | `orchestrator/src/core/gateway/*` (`proxy-handler.ts`, `llm-proxy.ts`, `plane-proxy.ts`, `bookstack-proxy.ts`, `matrix-proxy.ts`, `rate-limiter.ts`, `audit-logger.ts`) |
| RBAC | `orchestrator/src/core/rbac.ts` |
| Matrix relay + command dispatch | `orchestrator/src/core/matrix.ts` |
| Admin-command handler (shared HTTP + in-chat) | `orchestrator/src/api/webhooks.ts` (`handleAdminCommand`) |
| App wiring / routes | `orchestrator/src/index.ts` |
| Container management | `orchestrator/src/core/docker.ts` |
| Health monitor | `orchestrator/src/core/health-monitor.ts` |
| Worker agent loop (Hermes) | `base-worker/src/agent/hermes_loop.py` |
| Worker tools | `base-worker/src/tools/*` |
| Ticket state (Plane) | `base-worker/src/tools/state_backend.py` |

### RBAC — real API
`orchestrator/src/core/rbac.ts` exposes the `RBACService` class (singleton via
`getRBACService()`). Use these methods — do not invent others:
- `canAccessService(role, service)` — `service` ∈ `llm | plane | bookstack | matrix | github`.
- `getPermissionsForRole(role)` — returns the role's `Permission[]`.
- Also available: `hasPermission(role, permission)`,
  `canPerformAction(role, service, action)`, `getRateLimitForRole`,
  `getTokenExpiryForRole`, `validateRole`, `validatePermission`, `getAllRoles`.
- Helper: `methodToAction(method)` maps HTTP method → `read | write`.

Roles: `software-engineer`, `qa`, `devops`, `data`, `security`, `hr`, `pm`,
`po`, `network`, `doctor`. Permission strings are `service:action` (e.g.
`plane:write`, `llm:*`, `*`).

## Status: Shipped / Experimental / Roadmap

### ✅ Shipped & working
- Gateway proxy (LLM / Plane / BookStack) + RBAC enforcement + consumer-token JWT.
- Priority queue P0–P3 with P0 interrupt.
- Health monitor (heartbeat) + flapping detection.
- Checkpoint save/restore.
- Matrix HITL relay (admin ↔ PM/PO rooms).
- Matrix chat slash-commands `/status`, `/unblock`, `/kill`, `/timeout-status`,
  `/help` — typed directly in chat, admin-authorized.
- Interactive in-chat tool execution.
- NATS dual-publish + worker-side dedup.
- Credential vault (AES-256-GCM).

### 🧪 Experimental
- **Doctor self-healing** — diagnostics + container relay work; knowledge base /
  GitHub escalation / Matrix confirmation are gateway/relay-routed, and **fix
  execution is orchestrator-mediated** (`POST /remediation`, allow-listed actions
  via Dockerode; `create_dynamic_fix_script` disabled, `patch_config_file` gated).
  Implemented + unit-tested but **pending live-stack verification**.
- **Auto-scaling** — scale-down now stops the most-idle worker and respects
  `MIN_WORKERS`; scale-up is still capped to one worker per auto-start role. Not
  yet exercised under real load.

### 🗺️ Roadmap
- PO→PM→HR delegation at ticket intake (the Plane webhook currently spawns one
  worker of the payload's role).
- Helm / Kubernetes deploy (stub only).
- Timeout / escalation hardening.
- Retro reports.
- Automatic credential rotation.
- AES-256-GCM vault (upgrade from CBC).
- Container least-privilege hardening.

## Conventions

- Orchestrator is TypeScript; type-check with `npx tsc --noEmit` and test with
  Jest before claiming done.
- Worker is Python 3.12; lint via `py_compile` and test with `pytest`.
- Plane is the only state backend — do not reintroduce other backends.
- When changing build/test commands here, also update `.github/workflows/ci.yml`.

## Development methodology

Contributors follow **superpowers** as the single source of execution discipline:
brainstorming → writing-plans → test-driven-development → systematic-debugging →
verification-before-completion → code-review. Install it as a Claude Code plugin
(`/plugin install superpowers@claude-plugins-official`) or use the team's vendored
copy. Methodology source: [obra/superpowers](https://github.com/obra/superpowers)
(MIT, © 2025 Jesse Vincent).

The runtime workers do **not** run superpowers directly — they follow a terse,
tool-mapped translation bundled at `base-worker/skills/` (see its `NOTICE` for
attribution). Superpowers is the contributor methodology; the bundled skills are
the worker-facing equivalents.

**Before claiming done, run `verification-before-completion`:** run the gates for
what you touched (`npx tsc --noEmit` + `npm test` in `orchestrator/`, `pytest` in
`base-worker/`, `docker compose config` for compose changes) and paste the actual
output. Evidence before assertions — never claim "passing" without showing it.
