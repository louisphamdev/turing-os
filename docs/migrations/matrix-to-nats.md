# Migration Spec: Matrix/Synapse → NATS

Status: PROPOSAL — not started.
Author: audit pass, 2026-05-16.
Estimated effort: 5–8 working days of focused work.

## 1. Why migrate

Matrix/Synapse is doing two jobs in Turing OS today:

1. **Internal message bus** — workers report to PM, PM to PO, etc.
2. **Human-in-the-loop chat UI** — Element Web for admin ↔ agent conversation.

Synapse is heavy for job 1 (PostgreSQL backend, federation overhead, room-state
churn) and the federation features are unused. NATS JetStream is purpose-built
for job 1: sub-ms delivery, durable streams, simple subject hierarchy, single
binary, no DB.

Job 2 (Element chat) is what makes the migration risky — there is no
drop-in replacement for the admin UX.

## 2. Out of scope

- Replacing Element as the HITL chat client. The plan **keeps** Synapse and
  Element running only for admin ↔ orchestrator conversation. NATS handles
  every worker↔worker / worker↔orchestrator flow.
- Federation between deployments. Not used today, will not be added.

## 3. Target architecture

```
+----------------------+         +---------------------+
|    Admin (human)      |         |   Element Web (UI)  |
+----------+-----------+         +----------+----------+
           |                                |
           v                                v
+----------------------+         +---------------------+
|     Matrix Synapse    | <-----> |   Orchestrator      |
| (HITL chat only)     |  rooms  | (matrix relay only) |
+----------------------+         +----------+----------+
                                            |
                                            | NATS publish/subscribe
                                            v
                                  +---------------------+
                                  |    NATS JetStream   |
                                  +----------+----------+
                                             |
        +------------------+-----------------+------------------+
        v                  v                                    v
+---------------+  +---------------+                  +---------------+
|   PM worker   |  |   SE worker   |  ... (N workers) |  Doctor       |
+---------------+  +---------------+                  +---------------+
```

### Subject layout (proposed)

```
turing.pm.inbox                # tasks queued for PM
turing.pm.broadcast            # PM → all workers
turing.worker.{role}.{ticket}.inbox       # direct work for a worker
turing.worker.{role}.{ticket}.heartbeat   # 30s heartbeats
turing.worker.{role}.{ticket}.event       # status/blocker/done
turing.orchestrator.event      # spawn/kill/health events
turing.audit                   # mirror of audit-logger entries
```

Streams: `TURING_TASKS` (retention=workqueue), `TURING_EVENTS` (retention=limits,
max_age=72h), `TURING_AUDIT` (retention=limits, max_age=30d).

## 4. File-level impact

| File / module | Action |
|---|---|
| `orchestrator/src/core/matrix.ts` | Split: keep `MatrixService` for HITL only (admin DM + worker-room mirror). Move all worker↔worker traffic out. |
| `orchestrator/src/core/gateway/matrix-proxy.ts` | Becomes admin-only; rate-limit drops to "matrix DM only". |
| `orchestrator/src/core/nats.ts` (new) | `NatsService` wrapping `nats.connect`, `JetStreamManager`, publish/subscribe helpers, reconnect loop. |
| `orchestrator/src/core/orchestrator-agent.ts` | Replace direct `matrix.sendDM` for worker traffic with `nats.publish`. Keep DM for human admin. |
| `orchestrator/src/core/priority-queue.ts` | Source of `turing.pm.inbox` consumer. |
| `orchestrator/src/core/registry.ts` | Subscribe to `turing.worker.*.heartbeat`; expose `lastHeartbeat` from NATS. |
| `orchestrator/src/core/health-monitor.ts` | Heartbeat freshness now derived from NATS stream; remove Matrix-based heartbeat lookup. |
| `base-worker/src/tools/matrix_tools.py` | Strip worker↔PM helpers. Keep only `send_to_admin_room` for HITL bubble-up. |
| `base-worker/src/tools/nats_client.py` (new) | Thin wrapper over `nats-py` (asyncio). |
| `base-worker/src/agent/hermes_loop.py` | `report_to_pm`, `report_blocker`, `report_done` become NATS publishes. `await_pm_reply` becomes NATS request/reply on `turing.pm.inbox`. |
| `base-worker/src/health.py` | Heartbeat publishes to `turing.worker.{role}.{ticket}.heartbeat`. |
| `docker-compose.yml` | Add `nats:` service. Keep `synapse:` and `element:`. |
| `roles/*.md` | Replace any "post in your room" instructions with "publish on `turing.worker.{role}.{ticket}.event`". |

## 5. Phased rollout

### Phase 0 — Spike (1 day)
- Stand up a NATS JetStream container in `docker-compose.yml` on `turing_network`.
- Write a 50-line publish/subscribe smoke test from the orchestrator container.
- Decide whether to use core NATS or JetStream durable consumers for `turing.pm.inbox` (recommendation: JetStream, so a crashed PM does not drop in-flight tasks).

### Phase 1 — Dual write (1–2 days)
- Add `NatsService` to orchestrator.
- For every existing Matrix worker-message send, also publish to NATS.
- Workers keep reading Matrix; verify NATS stream contents match Matrix room contents in observability dashboard.

### Phase 2 — Worker read switch (2 days)
- Workers subscribe to NATS subjects in addition to Matrix.
- Confirm both paths deliver the same payloads.
- Flip a `WORKER_TRANSPORT=nats` env flag; workers stop reading Matrix.

### Phase 3 — Orchestrator write switch (1 day)
- Orchestrator stops dual-writing to Matrix worker rooms.
- Matrix rooms continue to mirror NATS for human visibility (one-way relay).

### Phase 4 — Cleanup (1 day)
- Delete the worker-room creation logic in `MatrixService`.
- Delete `base-worker/src/tools/matrix_tools.py` worker helpers.
- Remove `matrix-proxy.ts` worker permissions (admin-only now).
- Update docs: `worker-communication-protocol.md`, `README.md`, `pm-failover.md`.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Heartbeat dual-source drift during Phase 1–2 | Pick one as source of truth; the other is read-only mirror. Recommend Matrix until Phase 3. |
| Lost messages during cutover | JetStream durable consumers ack-only-on-process; restart-safe. |
| Admin loses visibility into worker chatter | Keep the Matrix relay rooms; orchestrator subscribes to `turing.worker.*.event` and forwards highlights as room messages. |
| Auth surface change | Workers no longer need a Matrix bot token. Replace with a NATS NKey or JWT issued by the orchestrator (similar to current consumer token pattern). |
| Tests | Add `orchestrator/tests/nats.test.ts` mocking `nats.connect`. Worker side: stub `nats.aio.Client` in pytest. |

## 7. Rollback

Phases 1 and 2 are reversible by flipping `WORKER_TRANSPORT` back to `matrix`.
Phases 3 and 4 require restoring deleted Matrix code paths from git — do not
start them until Phase 2 has been observed in production for at least 72h.

## 8. Open questions for the user

1. Is HITL on Element Web a hard requirement, or are you open to replacing it
   with a small custom admin web UI later? If yes, a follow-up spec can remove
   Synapse entirely.
2. Do you need NATS to be exposed outside the Docker network? If yes, mTLS
   setup adds ~1 day.
3. JetStream disk budget: a 50-worker fleet at 1 msg/s averages ~4 GB/month
   on `TURING_EVENTS` with 72h retention. Acceptable?
