# Turing OS — Remediation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between what Turing OS *claims* and what it *does*, fix verified security/correctness bugs, and bring the project to a credible "enterprise-ready, safe-to-promote" baseline.

**Approach:** Four ordered tracks — **P0 (security + honesty, before any promotion)**, **P1 (correctness/reliability bugs)**, **P2 (enterprise hardening)**, **P3 (coding harness + observability + CI gates)**. Each task lists exact files, the concrete fix, a verification command, and an effort estimate. Every finding below was **independently verified by reading the cited code** (adversarial review), not assumed.

**Tech stack:** TypeScript/Express + Dockerode (orchestrator), Python ReAct worker, Docker Compose (Plane CE, BookStack, Synapse/Element, Redis, NATS), Jest + pytest, GitHub Actions.

**Effort legend:** ⏱️S = <1h · M = 1–4h · L = 0.5–2d · XL = >2d

---

## ⚠️ Decision needed first — the "Doctor" question (cost/benefit)

The Doctor "crown jewel" is **non-functional in the shipped Linux image** for several independent reasons (all verified):
- Worker image is `python:3.11-slim` with **no PowerShell and no docker CLI/socket** — every `.ps1` fix and every `docker …` subprocess raises `FileNotFoundError` (`base-worker/Dockerfile:1`, `docker.ts:130`).
- The `scripts/doctor-fixes/` dir is **never COPYed into the image**, and `FIX_SCRIPTS_DIR` mis-resolves to `/scripts/doctor-fixes` (`doctor_tools.py:1079-1080`).
- BookStack calls hit a **non-existent `/graphql` endpoint** with `Bearer` auth; the real proxy is REST `/api` with `Token` (`doctor_tools.py:771`, `bookstack-proxy.ts:54`).
- `BOOKSTACK_TOKEN`/`GITHUB_TOKEN`/`MATRIX_BOT_TOKEN` are **never injected** into workers (`docker.ts:62-118`).

| | **Option A — Fix for real** | **Option B — Descope to "experimental"** |
|---|---|---|
| **Work** | Port all `.ps1` → `.sh`; `COPY scripts/` into image; fix `FIX_SCRIPTS_DIR`; rewrite BookStack/GitHub/Matrix calls to go **through the gateway** (add `/gateway/github` route + REST BookStack path); add human-approval gate for write+exec tools | Edit README/roles to label Doctor "experimental/roadmap"; disable auto-remediation by default; keep code |
| **Effort** | **XL** (3–5 days) + depends on P2 hardening | **S** (<1h) |
| **Benefit** | Keeps the headline differentiator working | Honest, removes udefinite uy-tín risk immediately |
| **Risk** | **High**: a *working* self-healer runs LLM-generated scripts as **root** with `shell=True` and can `patch_config_file` arbitrary paths. Shipping this *before* P2 hardening is dangerous. | Low |

**Recommendation (em đề xuất):** **Option B now**, Option A later as a funded roadmap item — *sequenced after* P2 hardening (S3/S6/container least-privilege). Reason: making Doctor actually execute fixes while it still has unsandboxed root `shell=True` + arbitrary file-write would turn a marketing gap into a real RCE/blast-radius problem. Be honest first, harden, then re-enable. **Anh chọn A hay B?** (Plan below assumes B for P0; Option A is captured as Track P4.)

---

## Track P0 — Must fix before promoting (security + honesty)

### P0-1 — Authenticate container-control endpoints  ⏱️M · Sev: High (S1)
**Files:** `orchestrator/src/index.ts:327-525`
**Problem:** `/workers`, `/workers/:id/stop|start`, `DELETE /workers/:id`, `/containers`, `/containers/:name/logs` have **no auth** while `/gateway/*` use `requireAdmin`. Server binds `0.0.0.0` and compose publishes `3001:3001`.
- [ ] Add the existing `requireAdmin` guard (defined `index.ts:232`) to every mutating + log route, e.g.:
```ts
app.post('/workers/:ticketId/stop',  requireAdmin, async (req, res) => { /* ... */ });
app.post('/workers/:ticketId/start', requireAdmin, async (req, res) => { /* ... */ });
app.delete('/workers/:ticketId',     requireAdmin, async (req, res) => { /* ... */ });
app.get('/containers/:name/logs',    requireAdmin, async (req, res) => { /* ... */ });
```
- [ ] Put read-only enumeration (`GET /workers`, `GET /containers`) behind `requireAdmin` too (topology is recon-sensitive), or a dedicated read-only token if Doctor needs it (Doctor reaches `/containers` — see P4; for now Doctor runs as admin-tokened internal caller).
- [ ] **Verify:** `curl -s -o /dev/null -w "%{http_code}" localhost:3001/containers` → `401/503` (was `200`). Existing jest still passes: `cd orchestrator && npm test`.

### P0-2 — Stop injecting the real Plane token into workers  ⏱️S · Sev: High (S2)
**Files:** `orchestrator/src/core/docker.ts:73`
**Problem:** `PLANE_API_TOKEN=${config.plane.apiToken}` (the real key) is pushed into **every** worker `Env`, contradicting the gateway-only guarantee at `docker.ts:86`. Workers don't use it (`state_backend.py` goes through the gateway).
- [ ] Delete the line:
```ts
// REMOVE this from envVars (docker.ts:73):
`PLANE_API_TOKEN=${config.plane.apiToken}`,
```
- [ ] Leave `PLANE_API_URL`, `PLANE_WORKSPACE_SLUG`, `PLANE_PROJECT_ID` (non-secret) and `GATEWAY_URL`/`CONSUMER_TOKEN`. The orchestrator's own `process.env.PLANE_API_TOKEN` still feeds `plane-proxy.ts:49` — unaffected.
- [ ] **Verify:** `grep -n PLANE_API_TOKEN orchestrator/src/core/docker.ts` → no match. Spawn a worker (or read code) and confirm `os.environ` has no `PLANE_API_TOKEN`. `npm test` green.

### P0-3 — Lock down Synapse defaults  ⏱️M · Sev: High (S4)
**Files:** `docker-compose.yml:241-252`, `synapse/homeserver.yaml:30,39-40`
**Problem:** open registration + guest access + no verification, ports on `0.0.0.0`, and a **hardcoded `registration_shared_secret` committed to the repo**.
- [ ] Default registration OFF, gate behind env:
```yaml
- SYNAPSE_ENABLE_REGISTRATION=${SYNAPSE_ENABLE_REGISTRATION:-false}
- SYNAPSE_ALLOW_GUEST_ACCESS=${SYNAPSE_ALLOW_GUEST_ACCESS:-false}
- SYNAPSE_REGISTRATION_WITHOUT_VERIFICATION=false
```
- [ ] Bind to localhost: `- "127.0.0.1:8008:8008"` (drop `8448` — Synapse only listens on 8008 per `homeserver.yaml:14-23`).
- [ ] Move the secret to env: `registration_shared_secret: "{{ REGISTRATION_SHARED_SECRET }}"` (or template from `.env`), and **rotate** the committed value.
- [ ] **Verify:** `docker compose config | grep -A2 8008` shows `127.0.0.1`; `grep -rn "IL+TIxnDlZ" synapse/` → no match.

### P0-4 — Make README/docs honest ("shipped vs roadmap")  ⏱️L · Sev: High (credibility)
**Files:** `README.md`, `QUICKSTART.md`, `roles/doctor.md`, `docs/comparison-hiclaw.md`
**Problem:** Several headline claims are aspirational (verified contradicted): Doctor crown jewel, PO→PM→HR intake chain, Matrix chat commands, Intent Parser (removed), Helm K8s deploy, `install/` quick start, `LICENSE`/`CONTRIBUTING`.
- [ ] Add a "Status" column / badges distinguishing ✅ Shipped vs 🧪 Experimental vs 🗺️ Roadmap for: Doctor (🧪 per Option B), PO→PM→HR delegation (🗺️ — see P1-5), Matrix chat commands (🧪 until P1-4), auto-scaling (🧪), Intent Parser (**remove the claim** — code gone).
- [ ] Fix Quick Start: remove `install/install.sh`/`install/config.sh` references; point to the real `init-admin-users.sh` / `make bootstrap`. Remove `install/` and `taiga-gateway/` from "Directory Structure".
- [ ] Fix Element port everywhere: `8081` (or change compose default — see P1-6). Pick one value.
- [ ] **Verify:** every path/URL in README exists: `for p in install taiga-gateway CONTRIBUTING.md LICENSE; do test -e "$p" && echo "$p OK" || echo "$p MISSING"; done` → all `OK` after P0-5, or references removed.

### P0-5 — Add LICENSE + CONTRIBUTING  ⏱️S · Sev: Medium
**Files:** create `LICENSE`, `CONTRIBUTING.md`
- [ ] Add an MIT `LICENSE` (matches the badge) with the correct copyright holder/year.
- [ ] Add `CONTRIBUTING.md` with the **real** dev loop (mirrors `ci.yml`): `cd orchestrator && npm ci && npx tsc --noEmit && npm test`; `cd base-worker && pip install -r requirements.txt && pytest`; `cp .env.example .env && docker compose config`.
- [ ] **Verify:** README links resolve; `test -f LICENSE && test -f CONTRIBUTING.md`.

### P0-6 — Descope Doctor to experimental (if Option B)  ⏱️S · Sev: Medium
**Files:** `README.md:58-141`, `roles/doctor.md`, `docs/comparison-hiclaw.md`
- [ ] Reframe Doctor section as "🧪 Experimental — self-healing pipeline scaffolding; fix execution requires Linux-compatible scripts + gateway routing (roadmap)."
- [ ] Disable auto-remediation by default (don't auto-run `run_full_remediation`); keep diagnostics (`check_*`, container relay) which *do* work.

---

## Track P1 — Correctness & reliability bugs

### P1-1 — Interactive mode never runs tools  ⏱️M · Sev: Medium (B1)
**Files:** `base-worker/src/agent/hermes_loop.py:200-232`
**Problem:** `run_interactive` returns `('done', content)` on iteration 0 whenever content is non-empty — **before** parsing/executing tool calls, so chat-mode tools are dead code.
- [ ] Reorder: parse tool calls first; only early-return when there are **no** tool calls:
```python
content = response.get('content', '') or response.get('text', '')
self._add_message('assistant', content)
tool_calls = self._parse_tool_calls(response)
if not tool_calls:
    return ('done', content)          # plain answer, no tools
for tool_call in tool_calls:          # otherwise execute, then loop
    result = self._execute_tool(tool_call)
    self._add_message('user', f"TOOL_RESULT: {result[:4000]}")
```
- [ ] Include the `TOOL_CALL:`/`ARGUMENTS:` format spec + tool schema in the interactive system prompt (`index.py:326-330`) so the model emits parseable calls.
- [ ] **Verify:** add `base-worker/tests/test_hermes_interactive.py` asserting that a stubbed LLM returning a `TOOL_CALL` triggers tool execution (TDD). `pytest base-worker/tests/test_hermes_interactive.py -v`.

### P1-2 — `AutoRemove:true` breaks stop/start lifecycle  ⏱️M · Sev: Medium (B2)
**Files:** `orchestrator/src/core/docker.ts:127,270-316`; `orchestrator/src/core/registry.ts:136-151`
**Problem:** `AutoRemove:true` deletes the container on stop, but `stopWorker`/`startWorker` assume it persists → phantom STOPPED workers, false "RUNNING" on start.
- [ ] Choose one (recommend **a**):
  - **(a)** `AutoRemove: false` and ensure `deleteWorker`/`killZombies` explicitly remove containers; OR
  - **(b)** keep `AutoRemove:true` and make `startWorker` **recreate** the container (re-issue a fresh consumer token) instead of `.start()`.
- [ ] Make `reconcileWithDocker` prune STOPPED workers whose container is actually gone (don't preserve phantoms).
- [ ] **Verify:** unit test in `orchestrator/tests/registry.test.ts` for reconcile pruning; manual stop→start round-trip leaves a running container.

### P1-3 — `getHealthSummary()` not awaited  ⏱️S · Sev: Medium (B3)
**Files:** `orchestrator/src/api/webhooks.ts:429,569`
- [ ] Add `await` (handlers must be `async`):
```ts
const health = await healthMonitor.getHealthSummary();   // line 429
const summary = await healthMonitor.getHealthSummary();   // line 569
```
- [ ] **Verify:** `GET /webhooks/health/status` returns a populated `workers` array, not `{}`. Add a jest test mirroring the existing `/health/all` pattern.

### P1-4 — Wire Matrix chat commands (or stop advertising them)  ⏱️M · Sev: Medium (S3-map/V3)
**Files:** `orchestrator/src/index.ts:105`, `orchestrator/src/core/matrix.ts:457,610-621`, `orchestrator/src/api/webhooks.ts:399-448`
**Problem:** `setCommandHandler` is never called → `/status`, `/unblock`, `/kill` typed in Element are silently dropped; `/help` unimplemented. `notifyBlocked` literally tells admins to use `/unblock` — which does nothing.
- [ ] Wire a command handler in `index.ts` (reuse the `/webhooks/matrix` logic) that also enforces `sender === adminUserId` (currently no sender authz — see P2-5):
```ts
matrixService.setCommandHandler(async (command, args, roomId, sender) => {
  if (sender !== config.matrix.adminUserId) return;       // authz
  await handleAdminCommand(command, args, roomId);        // shared with HTTP route
});
```
- [ ] Implement `/help`. De-duplicate command logic so the HTTP route and chat handler share it.
- [ ] **Verify:** jest test that a `/status` room event invokes the handler; manual `/help` in Element returns the command list.

### P1-5 — Implement (or explicitly defer) PO→PM intake chain  ⏱️L · Sev: Medium (architecture claim)
**Files:** `orchestrator/src/api/webhooks.ts:55-184`
**Problem:** `/plane` webhook spawns a single worker of the payload's role (default `software-engineer`), **not** the advertised PO→PM→HR→Workers delegation. Either implement routing-to-PO-first, or mark roadmap (done in P0-4).
- [ ] If implementing: route new tickets to the PO room first; PO decision creates the PM task. (Design task — needs a short spec; recommend deferring to a roadmap milestone and keeping P0-4's honesty edit.)

### P1-6 — Element port mismatch  ⏱️S · Sev: Low (B6/V15)
**Files:** `docker-compose.yml:267` and/or docs
- [ ] Align on one value: either `- "${ELEMENT_PORT:-8080}:80"` in compose, **or** change all docs (README:279/389, QUICKSTART, Makefile:105, copilot-instructions:44) to `8081`. Recommend compose→8080 (matches all docs).
- [ ] **Verify:** `docker compose config | grep 8080`.

### P1-7 — `llm-proxy` null-deref on provider fallback  ⏱️S · Sev: Low (B5/V12)
**Files:** `orchestrator/src/core/gateway/llm-proxy.ts:112-120`
- [ ] Mirror the `bookstack-proxy` pattern — `let credential`, reassign the whole object:
```ts
let credential = await this.vault.getCredentialByType('llm', providerConfig.provider);
if (!credential) {
  const anyCredential = /* fetch any llm credential */;
  if (!anyCredential) throw httpError(503, 'No LLM credential configured');
  credential = anyCredential;          // was: credential.key = anyCredential.key (null deref)
}
```
- [ ] **Verify:** jest test: vault has only `openai`, request resolves `anthropic` → falls back, no `TypeError`.

### P1-8 — Complete graceful shutdown + stop handle leaks  ⏱️M · Sev: Medium (reliability)
**Files:** `orchestrator/src/index.ts:547-564`; singletons in `pm-state.ts`, `docker.ts:581`, `nats.ts:184`, `credential-rotator.ts:68`, `gateway/audit-logger.ts:85`, `gateway/rate-limiter.ts:23`, `registry.ts:31`
- [ ] In `shutdown()` also call: `pmStateManager.stopAutoPersist()`, `docker.stopEventMonitor()`, `await natsService.stop()`, and `stop()`/`clearInterval` on `credentialRotator`, `auditLogger`, `rateLimiter`.
- [ ] Add `.unref()` to long-lived intervals (e.g. `registry.ts:31` persistTimer) so tests/process can exit cleanly.
- [ ] **Verify:** `cd orchestrator && npx jest --detectOpenHandles` → **no** "open handle" / "worker failed to exit" warning.

---

## Track P2 — Enterprise hardening

### P2-1 — Harden worker containers (least privilege)  ⏱️M · Sev: High (S3 mitigation)
**Files:** `orchestrator/src/core/docker.ts:126-131`
- [ ] Add to `HostConfig`: `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`, `ReadonlyRootfs: true` (with a writable `/workspace` + `/tmp` tmpfs), and run as non-root user. Per-worker network isolation where feasible.
- [ ] **Verify:** spawn a worker; `docker inspect` shows `CapDrop:["ALL"]`, `no-new-privileges`. Smoke a normal task still works.

### P2-2 — Make `execute_terminal_command` safer  ⏱️M · Sev: High (S3)
**Files:** `base-worker/src/tools/local_exec.py:21-94`
- [ ] Treat the denylist as **not** a security boundary (document it). Real control is P2-1 container hardening + egress policy.
- [ ] Enforce `working_dir` containment (reuse `_resolve_workspace_path`, already used by `read_file`/`write_file`).
- [ ] Don't keep live secrets in the agent's reachable env: pass `CONSUMER_TOKEN` to the agent process but strip it from any child shell env, or fetch it from a file the shell can't read.
- [ ] **Verify:** `pytest` for working_dir escape rejection; confirm `env | grep CONSUMER_TOKEN` is empty in a spawned shell.

### P2-3 — Vault: authenticated encryption + proper KDF  ⏱️M · Sev: Medium (S6/V11)
**Files:** `orchestrator/src/core/credential-vault.ts:50-114`
- [ ] Switch `aes-256-cbc` → `aes-256-gcm` (store IV + authTag; verify on decrypt).
- [ ] Derive the key as **raw 32 bytes** via scrypt/HKDF (`...digest()`, not `digest('hex').slice(0,32)`).
- [ ] Drop the plaintext `keyHash` (or replace with a salted KDF if a non-decrypting check is truly needed).
- [ ] **Verify:** existing `audit-store`/vault tests pass; add a tamper test (flip a ciphertext byte → decrypt throws).

### P2-4 — Plane webhook: fail-closed + raw-body HMAC + replay guard  ⏱️M · Sev: Medium (S7/V13)
**Files:** `orchestrator/src/api/middleware.ts:106-133`, `orchestrator/src/index.ts:224`
- [ ] Capture raw body: `express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } })`; HMAC over `req.rawBody`.
- [ ] Make unset-secret **fail closed in production** (allow only when an explicit `ALLOW_UNSIGNED_PLANE_WEBHOOK=true` dev flag is set).
- [ ] Add timestamp/nonce replay protection.
- [ ] **Verify:** signed request with a real raw body passes; unsigned request → `401` unless dev flag.

### P2-5 — Bind worker token to ticket + add Matrix sender authz  ⏱️M · Sev: Medium (S8/V16)
**Files:** `orchestrator/src/api/middleware.ts:61-95`, `orchestrator/src/api/webhooks.ts:292-323`
- [ ] In `requireWorker`, compare the JWT `payload.meta.ticketId`/`workerId` to `req.params.ticketId`; reject mismatches. Attach `payload` to `req` for handlers.
- [ ] Remove or sunset the static `WORKER_INTERNAL_TOKEN` fallback (no per-worker identity).
- [ ] **Verify:** worker token for ticket A → `403` on `/worker-inbox/B/drain`. jest test.

### P2-6 — Strong secret defaults + secret manager path  ⏱️M · Sev: High
**Files:** `.env.example`, `docker-compose.yml` (`:-` fallbacks at `:12,:248`)
- [ ] Remove weak fallbacks (`change-me-in-production`, `Admin123!`) from compose; require the operator to set them (fail fast). Add a `make gen-secrets` that runs `openssl rand`.
- [ ] Document a path to a real secret manager (Docker secrets / Vault / cloud KMS).
- [ ] **Verify:** `docker compose config` without a `.env` fails on required secrets (or CI seeds explicitly).

### P2-7 — `import_module` allow-list  ⏱️S · Sev: Medium (S5/V10)
**Files:** `base-worker/src/agent/command_executor.py:347,483`, `tool_registry.py:264`
- [ ] Restrict importable modules to an allow-list (e.g. `base-worker/src/tools/*`); reject anything else. Namespace BookStack `/tools/*` pages per project to prevent cross-worker poisoning.
- [ ] **Verify:** `pytest` — `register_tool` with `tool_module="os"` is rejected.

### P2-8 — Scale-down/scale-up correctness  ⏱️M · Sev: Medium
**Files:** `orchestrator/src/index.ts:128-160`, `orchestrator/src/core/health-monitor.ts:432-475`
- [ ] Scale-down should stop the **idle** worker that triggered the decision, not the oldest RUNNING one. Make min-workers configurable. Fix scale-up `init-<role>` id collision so it can add capacity.
- [ ] **Verify:** unit test for victim selection (idle, not oldest).

---

## Track P3 — Coding harness + observability + CI gates

### P3-1 — Root `CLAUDE.md` + `AGENTS.md`  ⏱️M
**Files:** create `CLAUDE.md`, `AGENTS.md` (root)
- [ ] Accurate, concise: real architecture (Plane, gateway-only, NATS), real build/test commands (mirror `ci.yml`), security rules (no raw keys in workers, PM-centralized comms), and the shipped-vs-roadmap status. No Taiga/wikijs/`skills.sh`/`canAccess` (all stale).
- [ ] **Verify:** every command in the file runs; every file path exists.

### P3-2 — Fix/remove stale Copilot harness  ⏱️L
**Files:** `.github/agents/*`, `.github/skills/*`, `copilot-instructions.md`
- [ ] Remove/replace: `taiga_tools.py`, `/webhooks/taiga`, `taiga-integration` skill, `wikijs.get('/api/secrets')`, `/vault//taiga//context7/` handlers, `rbacService.canAccess(...)` (real: `canAccessService`/`getPermissionsForRole`), `skills.sh`, `axios` dependency.
- [ ] Add a NATS skill + the real gateway/consumer-token model. Fix `testing/SKILL.md` ("pytest not installed" is false) and the hardcoded `d:\Source\Project_Turing\...` path in `doctor/SKILL.md`.
- [ ] **Verify:** `grep -rin "taiga\|wikijs\|skills.sh\|canAccess\b\|axios" .github copilot-instructions.md` → no stale hits.

### P3-3 — CI gates  ⏱️M
**Files:** `.github/workflows/ci.yml`
- [ ] Add: ESLint (orchestrator), ruff + mypy (base-worker), gitleaks/trufflehog (secret scan), Trivy (image/dep scan), README link-check. Replace the 4-file `py_compile` with full-tree `ruff`/`pytest`.
- [ ] **Verify:** CI runs all jobs green on a clean branch.

### P3-4 — Observability  ⏱️L
**Files:** orchestrator (logger module), `base-worker/src` (logging)
- [ ] Replace `console.*`/`print` with a structured logger (levels, JSON, correlation/ticket IDs, secret redaction). Add a `/metrics` Prometheus endpoint (workers healthy/dead, queue depth, gateway latency, fix success rate).
- [ ] **Verify:** `curl localhost:3001/metrics` returns Prometheus text; logs are JSON with `ticketId`.

### P3-5 — Fix smoke test + healthcheck cosmetics  ⏱️S
**Files:** `scripts/smoke-test.sh`, `orchestrator/src/core/docker.ts:147`
- [ ] Remove Taiga checks from `smoke-test.sh`; align `EXPECTED_SERVICES`; add Plane/NATS/Redis checks.
- [ ] Fix worker healthcheck grep: `grep "[s]rc/index.py"` (was `[p]ython main.py`, never matches → all workers show unhealthy).
- [ ] **Verify:** `make test` passes against a healthy stack; `docker ps` shows workers healthy.

---

## Track P4 — (Optional) Make Doctor real  ⏱️XL · only after P2
- [ ] Port all `scripts/doctor-fixes/*.ps1` → `.sh`; `COPY scripts/ /app/scripts` in `base-worker/Dockerfile`; fix `FIX_SCRIPTS_DIR` resolution.
- [ ] Rewrite `doctor_tools._wiki_request` to call the gateway BookStack **REST** proxy with `CONSUMER_TOKEN` (drop GraphQL/`Bearer`).
- [ ] Add a `/gateway/github` route + proxy; route GitHub-issue creation through it.
- [ ] Route Matrix confirmations through the existing orchestrator relay (already works) — drop direct `MATRIX_BOT_TOKEN` use.
- [ ] **Gate** `create_dynamic_fix_script`/`run_fix_script`/`patch_config_file` behind `ask_user_confirmation` + path allow-list; never write outside an allow-listed config set.
- [ ] **Verify:** an injected error triggers a real `.sh` fix that runs and `verify_fix` confirms recovery, end-to-end, in a Linux worker.

---

## Sequencing & milestones

1. **Milestone "Safe to show" (P0):** P0-1 → P0-6. ~1–2 days. *Then promotion is defensible.*
2. **Milestone "Works as documented" (P1):** P1-1 → P1-8. ~2–3 days.
3. **Milestone "Enterprise baseline" (P2):** P2-1 → P2-8. ~1 week.
4. **Milestone "Polished" (P3):** harness + CI + observability. ~3–4 days.
5. **Optional (P4):** Doctor for real, post-hardening.

## Self-review notes
- Every P0/P1 task maps to a verified finding (S1/S2/S4, B1/B2/B3, V3/V12/V15) with exact `file:line`.
- Effort estimates assume one engineer familiar with the stack.
- TDD: P1-1, P1-2, P1-7, P2-x include a failing test first where behavior is testable.
- No git commits will be made without your explicit go-ahead.
