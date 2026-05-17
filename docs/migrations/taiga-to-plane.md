# Migration Spec: Taiga → Plane

Status: IN PROGRESS — Phase 0+1+2+2.5 completed 2026-05-17.
Author: audit pass, 2026-05-16. Decisions chốt 2026-05-17.
Estimated effort: 6–10 working days (includes new inventory step).

## Progress

- [x] Phase 0 — Spike (skeleton stack added under `--profile plane`).
- [x] Phase 1 — `StateBackend` ABC + `TaigaBackend` + `PlaneBackend` skeleton.
- [x] Phase 2 — `PlaneBackend` body implemented against Plane CE REST API.
- [x] Phase 2.5 — External Taiga readers inventory (see `taiga-readers-inventory.md`).
- [ ] Phase 3 — Cutover (requires real Plane CE container + shadow-run).
- [ ] Phase 4 — Cleanup (delete `taiga-*` services + scripts).

## Decisions locked in (2026-05-17)

| Open question | Decision |
|---|---|
| Preserve closed-ticket history? | **No.** Only OPEN tickets get migrated. Closed-ticket data is acceptable loss. |
| Third-party readers of Taiga? | **Unknown — must inventory before cutover.** A new pre-cutover step (see Phase 2.5) enumerates webhooks, dashboards, and CI scripts that hit Taiga directly. |
| Plane variant | Self-hosted Plane CE (`makeplane/plane`). |

## 1. Why migrate

Taiga is doing one job: ticket / user-story persistence and the implicit
"source of truth" for PM failover. It works but has costs:

- 6+ containers in the stack (`taiga-db`, `taiga-back`, `taiga-async`,
  `taiga-front`, `taiga-events`, `taiga-protected`, `taiga-async-rabbitmq`,
  `taiga-events-rabbitmq`).
- First-boot bootstrap is fragile — the project already ships
  `taiga-docker-entrypoint.sh`, `init-admin-users.{sh,ps1}` to paper over it.
- API surface is heavy; the codebase only uses a small subset (CRUD on
  user stories, statuses, members).

Plane (`makeplane/plane`) is a modern alternative:

- Single-process API container + simple Postgres, no RabbitMQ requirement.
- REST API is straightforward; SDK exists.
- Smaller surface to host and update.

## 2. Out of scope

- Replacing BookStack. That is staying.
- Importing Taiga's complete history. The plan is a clean cutover with only
  *open* tickets migrated.

## 3. Target architecture

The Taiga silo (`taiga_network`) shrinks dramatically:

```
Before:                          After:
+------------------+             +------------------+
| taiga-db (PG)    |             | plane-db (PG)    |
+------------------+             +------------------+
+------------------+             +------------------+
| taiga-events-rmq |             |    plane-api     |
+------------------+             +------------------+
+------------------+             +------------------+
| taiga-async-rmq  |             |   plane-worker   |
+------------------+             | (existing image) |
+------------------+             +------------------+
| taiga-back       |
+------------------+
+------------------+
| taiga-async      |
+------------------+
+------------------+
| taiga-front      |
+------------------+
+------------------+
| taiga-events     |
+------------------+
+------------------+
| taiga-protected  |
+------------------+
+------------------+
| taiga-gateway    |
+------------------+

= 9 containers                  = 3 containers
```

## 4. API surface used today

Audit of `base-worker/src/tools/taiga_tools.py` shows the worker needs:

| Operation | Taiga endpoint | Plane equivalent |
|---|---|---|
| list user stories | `GET /userstories?project=…` | `GET /workspaces/{ws}/projects/{p}/issues/` |
| get user story | `GET /userstories/{id}` | `GET /workspaces/{ws}/projects/{p}/issues/{id}/` |
| create user story | `POST /userstories` | `POST /workspaces/{ws}/projects/{p}/issues/` |
| update status | `PATCH /userstories/{id}` with `status` slug | `PATCH .../issues/{id}/` with `state` UUID |
| comment | `POST /userstories/{id}/comments` | `POST .../issues/{id}/comments/` |
| list members | `GET /memberships?project=…` | `GET /workspaces/{ws}/members/` |

The orchestrator (`orchestrator/src/core/pm-state.ts` and TaigaGateway sidecar)
adds nothing extra — it only proxies the same set.

## 5. File-level impact

| File / module | Action |
|---|---|
| `base-worker/src/tools/taiga_tools.py` | Rename to `plane_tools.py`. Rewrite `_make_request` to Plane base URL + token. Adapt status-id resolution (Plane uses state UUIDs, not slugs). |
| `orchestrator/src/core/gateway/taiga-proxy.ts` | Rename to `plane-proxy.ts`. Update env var (`TAIGA_API_URL` → `PLANE_API_URL`). |
| `orchestrator/src/core/gateway/proxy-handler.ts` | Service union `'taiga'` → `'plane'`. |
| `orchestrator/src/core/credential-vault.ts` | `type: 'taiga'` → `type: 'plane'`; env mapping `TAIGA_API_KEY` → `PLANE_API_TOKEN`. |
| `orchestrator/src/core/rbac.ts`, `consumer-token.ts`, `audit-logger.ts` | Service-union rename across permissions. |
| `orchestrator/src/core/orchestrator-agent.ts` | If it references Taiga for backfill, route to Plane. |
| `taiga-gateway/` | Delete. Plane has its own auth-aware API. |
| `taiga-docker-entrypoint.sh`, `taiga.env` | Delete. |
| `init-admin-users.{sh,ps1}` | Rewrite the Taiga section to bootstrap a Plane workspace + project + API token. |
| `docker-compose.yml` | Remove every `taiga-*` service. Add `plane-api`, `plane-worker`, `plane-db`. |
| `.env.example` | Replace `TAIGA_*` with `PLANE_*`. |
| `roles/*.md`, `worker-communication-protocol.md`, README | Replace "Taiga ticket" with "Plane issue". |
| `pm-failover.md` | The state path is already local JSON; only the in-PM logic that *reads back from Taiga* needs updating (see below). |

## 6. Status / state model differences

| Concept | Taiga | Plane |
|---|---|---|
| Ticket id | numeric, project-scoped | sequence id + UUID; UUID is what API uses |
| Status | slug like `in-progress` | state UUID, fetched from `/workspaces/{ws}/projects/{p}/states/` |
| Assignment | `assigned_to: <user_id>` (single) | `assignees: [<user_id>...]` (multi) |
| Comments | `/userstories/{id}/comments` | `/issues/{id}/comments/` (same shape) |

The most invasive change is the **status model**. The code resolves status by
name today (`_resolve_status_id` in `taiga_tools.py`). For Plane, you fetch the
states list once at startup, cache `{slug → uuid}`, and look up by slug.

## 7. PM-failover impact

`pm-state.ts` writes its queue snapshot to a local JSON file
(`/tmp/turing-pm-state.json`). It does **not** persist queue state in Taiga
today — that was an aspirational note in the old `pm-failover.md`. So the
PM-failover code itself is unaffected by switching Taiga → Plane.

What does change: any worker tool that reads "the canonical task list" must
now read it from Plane. The only place this matters is when PM rebuilds the
queue from scratch after losing the local state file.

## 8. Phased rollout

### Phase 0 — Spike (1 day)
- Stand up a Plane container alongside Taiga on `taiga_network` (network can
  later be renamed `state_network`).
- Write 30 lines of `plane_smoke_test.py`: create issue, update status, comment, list.

### Phase 1 — Adapter shim (2 days)
- Add `base-worker/src/tools/state_backend.py` with a `StateBackend` ABC and
  two concrete classes: `TaigaBackend`, `PlaneBackend`.
- Refactor `taiga_tools.py` so all functions go through `StateBackend`.
- Choose backend at startup from `STATE_BACKEND=taiga|plane` env var. Default
  remains `taiga`.

### Phase 2 — Plane backend complete (2 days)
- Implement `PlaneBackend` for every method in the ABC.
- Run the same unit tests against both backends.
- Smoke-test workers with `STATE_BACKEND=plane` in a non-prod compose stack.

### Phase 2.5 — External-integration inventory (0.5 day)
- Audit external systems that read Taiga directly. Required checks:
  - `git log --all --source -- ':!docs/**'` for `taiga` URL references outside the repo's own tools.
  - Search for outgoing webhooks configured in the Taiga admin UI
    (`Settings → Webhooks`).
  - Ask the team for any Metabase / Grafana / custom dashboards pointed at
    Taiga's Postgres or REST API.
  - Search CI configs (`.github/workflows/`, Jenkinsfiles) for Taiga API calls.
- Output: `docs/migrations/taiga-integrations.md` listing every found
  consumer and its required Plane equivalent. Blocks Phase 3 until reviewed.

### Phase 3 — Cutover (1 day)
- Export **only OPEN** Taiga tickets via `taiga export`, import into Plane
  via `plane CLI`. Closed tickets are dropped per locked-in decision.
- Flip `STATE_BACKEND=plane` in production `.env`.
- Stop the `taiga-*` services in `docker-compose.yml` but do not delete the
  volume — keep `taiga_db_data` for at least 30 days as rollback insurance.

### Phase 4 — Cleanup (1–2 days)
- Delete `taiga-*` services from `docker-compose.yml`.
- Delete `taiga-gateway/`, `taiga.env`, `taiga-docker-entrypoint.sh`.
- Rewrite `init-admin-users.*` to bootstrap Plane.
- Update env-var names everywhere (`TAIGA_*` → `PLANE_*`).
- Rename `taiga-proxy.ts` → `plane-proxy.ts`, update RBAC service unions.
- Update docs.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Status-slug → state-UUID mismatch silently mis-categorises tickets | In Phase 2, log every status update in both backends and diff them. |
| Plane API rate limits | Plane self-hosted has no enforced limit, but the orchestrator gateway should still rate-limit per-token to match Taiga's behaviour. |
| Lost comment history | Migration script imports comments via the Plane API; closed tickets accepted as data loss. |
| `pm-state.ts` queue stored task IDs that were Taiga numeric ids | Re-key the queue file on first boot post-cutover; tasks without a mapping get re-queued from Plane. |

## 10. Rollback

Phases 1–2 are safe — both backends are wired and selected by env var.
Phase 3 rollback requires restarting Taiga services and flipping
`STATE_BACKEND=taiga`; data created in Plane during the cutover window
is lost. Acceptable if cutover happens during a quiet period.
Phase 4 is the point of no return — schedule at least a week between
Phase 3 and Phase 4.

## 11. Open questions

All resolved — see "Decisions locked in" at the top of this file. The
third-party-readers question is handled by the new Phase 2.5 inventory step.
