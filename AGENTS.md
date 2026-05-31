# AGENTS.md — Turing OS

**Read [`CLAUDE.md`](./CLAUDE.md) first — it is the canonical project memory**
(architecture, build/test commands, key files, and shipped/experimental/roadmap
status). This file inlines only the non-negotiable guardrails so an agent that
reads nothing else still respects them.

## Non-negotiable security rules

1. **Workers never get raw API keys.** All worker egress is gateway-only,
   authenticated with the per-worker `CONSUMER_TOKEN` (JWT); the orchestrator
   gateway injects real credentials from the vault. Never wire a worker tool to
   call an external service directly.
2. **PM-centralized worker comms.** No worker↔worker direct messaging. Admin
   chats only with PM/PO, who route work. Do not add peer-to-peer worker channels.
3. **Admin endpoints require `ADMIN_API_TOKEN`** (bearer). In-chat admin
   slash-commands are authorized against `MATRIX_ADMIN_USER_ID`; non-admin
   senders are rejected.
4. **Worker→orchestrator webhooks require the worker JWT** (consumer token).
5. **Never commit secrets.** Use `.env` (from `.env.example`); the vault holds
   real keys.

## Build / test (mirror `.github/workflows/ci.yml`)

- Orchestrator: `cd orchestrator && npm ci && npx tsc --noEmit && npm test`
- Base worker: `cd base-worker && pip install -r requirements.txt && pytest`
- Compose: `cp .env.example .env && docker compose -f docker-compose.yml config`

State backend is **Plane** only. See `CLAUDE.md` for everything else.
