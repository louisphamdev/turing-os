# Contributing to Turing OS

Thanks for your interest in contributing to Turing OS! This guide describes the
**real, verified** developer workflow. Every command below mirrors what runs in
CI (`.github/workflows/ci.yml`), so if your changes pass locally they should
pass in CI as well.

> Repo: [`louisphamdev/turing-os`](https://github.com/louisphamdev/turing-os)
> License: MIT (see [`LICENSE`](LICENSE)).

---

## Prerequisites

- **Node.js 20+** (CI pins Node `20`) — for the orchestrator.
- **Python 3.12+** (CI pins Python `3.12`) — for the base worker.
- **Docker + Docker Compose** — for running the stack and validating compose files.

---

## Orchestrator (TypeScript)

The orchestrator lives in [`orchestrator/`](orchestrator/) and is built with
TypeScript + Jest.

```bash
cd orchestrator

# Install exact dependencies from package-lock.json
npm ci

# Type-check (no emit) — must be clean
npx tsc --noEmit

# Run the Jest test suite
npm test

# Build to dist/ (compiles with tsc)
npm run build
```

Notes:

- `npm test` runs `jest`. In CI it is invoked as `npm test -- --ci`; locally
  plain `npm test` is fine.
- `npm run build` runs `tsc`, emitting to `dist/`.

---

## Base Worker (Python)

The Python worker lives in [`base-worker/`](base-worker/).

```bash
cd base-worker

# Install dependencies
pip install -r requirements.txt

# Run the test suite
pytest -v
```

Notes:

- CI additionally runs `python -m py_compile` on a few core modules
  (`src/index.py`, `src/tools/state_backend.py`, `src/tools/nats_client.py`,
  `src/tools/pm_monitor.py`) as a fast syntax check before `pytest`. A green
  `pytest -v` plus a successful import of those modules covers this.

---

## Docker Compose Validation

CI validates that the compose file is well-formed. `docker compose` substitutes
`${VAR}` placeholders from a `.env` file **at config/validation time**, so a
`.env` must exist first — otherwise validation fails or warns on unset
variables. Seed one from the example:

```bash
# From the repository root
cp .env.example .env

# Validate the default stack (this is what CI runs)
docker compose -f docker-compose.yml config
```

If `config` prints the fully-resolved compose document without errors, the file
is valid. (CI redirects the output to `/dev/null`; locally you may want to read
it.)

---

## First Run / Bootstrap

There is **no `install/` directory**. The real entry points are the `Makefile`
and the `init-admin-users` scripts at the repository root:

```bash
# Create Matrix admin/bot users + tokens.
# make bootstrap dispatches to the right script for your OS:
#   - Linux/macOS -> bash ./init-admin-users.sh
#   - Windows     -> powershell .\init-admin-users.ps1
make bootstrap
```

You can also run the scripts directly:

```bash
# Linux / macOS
./init-admin-users.sh

# Windows (PowerShell)
.\init-admin-users.ps1
```

Other useful `make` targets: `make build` (build images), `make up` / `make down`
(start/stop the stack), `make logs`, `make status`.

---

## Conventions

- **PM-centralized communication.** Workers do not message peers directly. All
  inter-worker coordination is routed through the PM / orchestrator. Don't add
  worker-to-worker direct channels.
- **Gateway-only access.** Workers never receive raw API keys. All traffic to
  external services goes through the orchestrator gateway, and workers
  authenticate with short-lived JWT consumer tokens. Don't pass provider
  credentials into worker containers.
- **Conventional commits.** Use conventional-commit style messages, e.g.
  `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `refactor: ...`,
  `chore: ...`. Optionally scope them, e.g. `feat(orchestrator): ...`.

---

## Quality & Security Gates

CI runs these in addition to the test suites. You can run them locally:

- **ESLint (orchestrator):** `cd orchestrator && npm run lint`. Config:
  [`orchestrator/eslint.config.js`](orchestrator/eslint.config.js). Errors fail
  the build; some pre-existing rules are demoted to warnings (e.g.
  `no-explicit-any`) and can be tightened later (see the config header).
- **Ruff (base-worker):** `cd base-worker && ruff check .`. Config:
  [`base-worker/ruff.toml`](base-worker/ruff.toml). Conservative `E,F` ruleset;
  `E501` (line length) is deferred. This replaces the old `py_compile` step.
- **Secret scan (gitleaks):** `gitleaks detect --no-git --source . --config .gitleaks.toml`.
  Runs in **no-git mode** — it scans the working tree, **not git history** (see
  below). Allowlist: [`.gitleaks.toml`](.gitleaks.toml).
- **Vuln scan (Trivy):** filesystem scan, **report-only** for now (does not fail
  the build); can be enforced later.
- **Docs link-check (lychee):** verifies relative links in `README.md`,
  `CONTRIBUTING.md`, `QUICKSTART.md`. Config: [`.lychee.toml`](.lychee.toml).

---

## Secret hygiene & git history

> **Heads-up — secrets remain in git history.** The credentials that were
> recently moved to **placeholders** in the working tree (e.g. in
> `.env.example`, config templates, and bootstrap scripts) are **still present
> in earlier git commits**. The CI secret scan deliberately runs in **no-git
> mode** (`gitleaks detect --no-git`) so it validates the *current files* only —
> a default history scan would still flag the old values.
>
> **Before any public release / open-sourcing:**
>
> 1. **Purge the history** with [`git filter-repo`](https://github.com/newren/git-filter-repo)
>    or [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) to remove
>    the leaked values from every commit.
> 2. **Rotate every affected secret** (LLM/API keys, Matrix/Synapse tokens and
>    registration secret, Plane/BookStack DB passwords and app keys, `JWT_SECRET`,
>    `VAULT_MASTER_KEY`, `ADMIN_API_TOKEN`, `WORKER_INTERNAL_TOKEN`,
>    `PLANE_WEBHOOK_SECRET`, etc.). Assume anything that was ever committed is
>    compromised.
> 3. Force-push the rewritten history and have all collaborators re-clone.

Keep new secrets in your local (git-ignored) `.env`, never in tracked files.

---

## Before Opening a PR

Run through this checklist — it matches what CI enforces:

- [ ] **Type-check clean:** `cd orchestrator && npx tsc --noEmit` passes.
- [ ] **Lint clean:** `cd orchestrator && npm run lint` and
      `cd base-worker && ruff check .` both pass.
- [ ] **Jest green:** `cd orchestrator && npm test` passes.
- [ ] **Pytest green:** `cd base-worker && pytest -v` passes.
- [ ] **Compose valid:** `cp .env.example .env` then
      `docker compose -f docker-compose.yml config` succeeds.
- [ ] **No secrets committed:** no real API keys, tokens, or credentials in the
      diff. Keep secrets in your local (git-ignored) `.env`, never in tracked
      files. (See "Secret hygiene & git history" above.)

Thanks for contributing!
