# Phase 2.5 — External Taiga Readers Inventory

Snapshot taken 2026-05-17. Lists every place in the repo that reads or writes
Taiga directly (i.e. bypasses the `StateBackend` abstraction). These must be
updated or kept on Taiga before flipping `STATE_BACKEND=plane` for everyone.

## Direct API callers (must migrate before cutover)

| File | Lines | Calls | Action for cutover |
|------|-------|-------|--------------------|
| `base-worker/src/tools/taiga_tools.py` | full file | All Taiga REST | Keep — wrapped by `TaigaBackend`. Switch via `STATE_BACKEND` only. |
| `base-worker/src/tools/pm_monitor.py` | 92, 136, 274 | `GET/POST /userstories` direct | **Refactor** to use `state_backend.get_backend()`. PM monitor bypasses abstraction today. |
| `base-worker/src/tools/state_backend.py` | full | Thin facade | Already abstracted. |
| `base-worker/src/index.py` | 238, 245, 293, 304, 404 | `from tools import taiga_tools` | Switch imports to `state_backend.get_backend()`. |
| `base-worker/src/agent/hermes_loop.py` | system prompt | Refers to Taiga by name | Update prompt text only (cosmetic). |
| `orchestrator/src/core/gateway/taiga-proxy.ts` | full | Gateway proxy | **Add parallel `plane-proxy.ts`** then update RBAC. |

## Health / discovery references (low risk)

| File | Lines | Notes |
|------|-------|-------|
| `base-worker/src/tools/doctor_tools.py` | 21, 22, 46, 47, 149, 295, 298, 305, 510, 2034 | Health-check endpoint references only. Update with `plane` entry when Plane lands. |
| `orchestrator/src/config/index.ts` | various | Service registry needs `plane` entry. |
| `orchestrator/src/core/docker.ts` | various | Worker env injection — add Plane vars. |
| `orchestrator/src/core/credential-vault.ts` | type union | Add `'plane'` to credential type. |
| `orchestrator/src/core/credential-rotator.ts` | type union | Same. |
| `orchestrator/src/core/consumer-token.ts` | type union | Already added `plane`-ready service set. |
| `orchestrator/src/core/rbac.ts` | grant rows | Add plane equivalents of taiga grants. |

## Install / bootstrap scripts (require manual swap)

These call Taiga during initial setup; Plane has different bootstrap so they
are not 1:1 swappable. Cutover requires a separate `init-plane.sh`/`.ps1`.

- `install/config.sh`, `install/config.ps1`
- `install/install.sh`, `install/install.ps1`
- `init-admin-users.sh`, `init-admin-users.ps1`
- `taiga-docker-entrypoint.sh`
- `taiga-gateway/taiga.conf`

## Docs that mention Taiga (cosmetic — rewrite during Phase 4)

- `README.md`, `QUICKSTART.md`, `base-worker/README.md`, `helm/turing-os/README.md`
- `worker-health.md`, `timeout-policy.md`, `worker-communication-protocol.md`
- `roles/doctor.md`
- `.github/skills/*/SKILL.md`, `.github/AGENTS.md`, `.github/agents/*`
- `docs/project_review.md`

## Tests

- `orchestrator/tests/rbac.test.ts`, `orchestrator/jest.setup.js` — already
  reference Taiga grants; add a parallel Plane suite when proxy lands.

## Cutover order (recommended)

1. Phase 2 (this commit): `PlaneBackend` body implemented; opt-in via env.
2. Phase 2.5: refactor `pm_monitor.py` + `base-worker/src/index.py` to use
   `state_backend.get_backend()` so both backends share the same call site.
3. Phase 3: stand up Plane CE on staging, flip `STATE_BACKEND=plane`, run
   in shadow mode for a week.
4. Phase 4: remove Taiga gateway proxy, install scripts, and docs.

No external integrations (webhook subscribers, CI hooks, dashboards) were
found in this repo — the user confirmed they don't know of any in production
either. Treat that as best-effort and add a feature flag rollback path.
