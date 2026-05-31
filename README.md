# Turing OS - Multi-Agent IT Department OS

> **Vision**: Become the smartest IT department OS, surpassing HiClaw - fully automating the software development lifecycle with AI agents, from requirements gathering to production deployment.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/louisphamdev/turing-os)](https://github.com/louisphamdev/turing-os/stargazers)

---

## 🤔 What is Turing OS?

Turing OS is a **Multi-Agent Operating System** that simulates a complete IT department. Instead of simple LLM text communication, it uses an **event-driven architecture** to coordinate AI agents as a real IT team.

```
Stakeholder ──► [PO] ──► [PM] ──► [HR] ──► [Workers]
                    │        │
            │        ├──► Priority queue (P0-P3)
            │        ├──► Worker health monitoring
            │        ├──► Matrix HITL relay
            │        └──► Planned: timeout/escalation, failover, scaling
                    │
               [DOCTOR] ◄── User bug reports
```

---

## 🎯 What Can Turing OS Do?

### 1. Automated Requirements Management
- **PO (Product Owner)** receives requirements from stakeholders
- Priority classification (P0-P3)
- Creates tickets in **Plane** with automatic workflow

> 🗺️ **Roadmap**: The full hierarchical delegation chain (PO → PM → HR → Workers) at ticket intake is not yet implemented. Today, the Plane webhook spawns a single worker of the payload's role (default `software-engineer`); the PO→PM delegation chain is currently enforced only for Matrix-chat routing.

### 2. Automated Software Development
- **Workers** execute tasks using ReAct loop
- Multi-language support: Python, JavaScript, TypeScript, Go, Rust, .NET, Java
- Auto research with Context7 for unknown tech
- Tools: **BookStack** (docs), **Plane** (tickets), sandbox terminal

### 3. Bidirectional Human-in-the-Loop (HITL)
- **Matrix** enables real-time two-way communication between admin and workers
- Admin sends messages in worker's Matrix room → routed to worker via orchestrator
- Workers ask questions, send progress updates, request human input
- Admin commands: `/status`, `/timeout-status`, `/unblock`, `/kill`, `/help` — ✅ typed directly in Element chat and dispatched by the orchestrator. Commands are **admin-authorized** (only the configured `MATRIX_ADMIN_USER_ID` may run them; other senders are rejected). The same handler also backs the authenticated HTTP admin-command endpoint.
- **Element Web** provides a modern chat interface for admin interaction

### 4. Self-Healing & Monitoring
- **Worker Health**: Auto restart dead workers with 3-tier recovery:
  1. **Flapping Detection** — 3+ deaths/60min = stop, alert human
  2. **Doctor Diagnosis** — spawn temp Doctor to find root cause (OOM, crash, dependency)
  3. **Checkpoint Recovery** — restore agent state, resume from iteration N
- **Worker Checkpoint** — auto-saves every 5 iterations; compressed message history, iteration count, context
- **Priority Queue**: Running, queued, and paused task state is exposed via orchestrator APIs
- **Alert Manager**: Real-time monitoring of Docker lifecycle events (e.g., OOM kills) and system anomalies.
- **Auto-Scaling** 🧪 **Experimental**: Orchestrator scales workers based on CPU/RAM utilization and idle thresholds. Caveat: scale-up is currently capped to one worker per role, and scale-down stops the oldest running worker rather than the idle one.
- **Doctor Agent**: See Section 5 for the Doctor diagnosis & self-healing system.

### 5. Doctor Agent — System Diagnostics & Self-Healing (NEW)
Doctor is Turing OS's **system doctor** — a specialized worker that runs 24/7, diagnoses failures, and reports on the health of the system. It is a key differentiator of Turing OS.

> 🧪 **Implemented via gateway + orchestrator remediation; pending live-stack verification** — Diagnostics (health checks, log parsing, service-connectivity probes, container discovery via the orchestrator relay) are functional. Knowledge base / metrics / dashboard go through the **gateway BookStack REST proxy** (`/gateway/bookstack`, `CONSUMER_TOKEN`), GitHub escalation through the **`/gateway/github` proxy**, and admin confirmation through the **orchestrator Matrix relay** (`/webhooks/worker-message`) — no raw tokens in the worker. **Fix execution** is now **orchestrator-mediated**: Doctor calls `POST /remediation` on the orchestrator, which performs an allow-listed action via Dockerode with audit + RBAC (`remediation:execute`, doctor role only). The worker has no Docker socket and runs no local scripts. These paths are implemented and unit-tested but **not yet verified against a live stack** (real BookStack page round-trips, real GitHub issue creation, real container restarts).

#### What Doctor Does

```
Error detected ──► Doctor triages ──► Diagnoses root cause
                                              │
                    ┌─────────────────────────┼────────────────────────────┐
                    ▼                         ▼                            ▼
         Known Issues DB         Orchestrator remediation      Cross-Worker invocation
         (gateway BookStack)      POST /remediation:           devops.scale_worker
                                   restart_container            qa.run_tests
                                   check_disk_usage             se.analyze_code
                                   cleanup_docker [admin]
                    │                         │                            │
                    └─────────────────────────┼────────────────────────────┘
                                              ▼
                          (dynamic-script creation & arbitrary config patching
                           are DISABLED / gated for safety — see below)
                                              │
                    ┌─────────────────────────┴────────────────────────────┐
                    ▼                                                       ▼
              GitHub Issue (via /gateway/github proxy)            Human Escalation (Matrix relay)
                                              │
                                    System restored ──► Learns & tracks (gateway BookStack)
```

#### Doctor Tool Suite (21 tools)

| Tool | Capability |
|------|-----------|
| `check_system_health()` | CPU, memory, disk, Docker, network snapshot |
| `parse_docker_logs()` | Fetch & parse logs from any container (local or via orchestrator relay) |
| `check_service_connectivity()` | Plane, Wiki, Matrix, Context7, GitHub, Orchestrator |
| `check_recent_errors()` | Aggregate ERROR/WARN across ALL containers |
| `query_known_issues_db()` | Search BookStack for past errors & fixes |
| `save_to_known_issues()` | Record new learnings to BookStack |
| `create_github_issue()` | Structured GitHub issues via the `/gateway/github` proxy (no raw token in worker) |
| `run_fix_script()` | Map a fix name to an allow-listed action and `POST /remediation` on the orchestrator |
| `verify_fix()` | Confirm a fix worked |
| `track_metrics()` | Record success/failure rates to BookStack (via `/gateway/bookstack`) |
| `get_doctor_dashboard()` | Full system summary |
| `ask_user_confirmation()` | Yes/no questions to admin via the orchestrator Matrix relay |
| `run_self_healing_pipeline()` | Full diagnose→remediate→track workflow (remediation via orchestrator API) |
| `run_full_remediation()` | Auto-remediation: known issues → allow-listed remediation → cross-worker → escalate |
| `create_dynamic_fix_script()` | **DISABLED** for safety (no local write+exec) — escalate instead |
| `patch_config_file()` | **Gated** — workspace-only, opt-in via `DOCTOR_ALLOW_CONFIG_PATCH` (defaults off) |
| `invoke_worker_tool()` | Call tools from devops/qa/se/pm workers |
| `list_docker_containers()` | Discover ALL containers & classify by role |
| `get_container_inspect()` | Full `docker inspect` for any container |
| `tail_container_logs()` | Stream logs with ERROR/WARN filtering |
| `find_containers_by_role()` | Find containers by worker role |

#### Container Discovery Architecture

Doctor can inspect **any container** in the system — worker or infrastructure — regardless of whether it has a local Docker socket:

```
Doctor (on host) ── docker ps -a ──────────────────► Local Docker socket
Doctor (in container) ── GET /containers ──────────► Orchestrator relay
                        GET /containers/:name/logs
```

| Endpoint | Purpose |
|----------|---------|
| `GET /containers` | List all containers + role classification |
| `GET /containers/:name/logs` | Fetch logs from any container |

#### Remediation actions (orchestrator-mediated)

The Doctor worker has **no Docker socket** and runs **no local scripts**. Fix
execution goes through `POST /remediation` on the orchestrator, which performs a
small, closed **allow-list** of actions via Dockerode — every call is audited and
gated by RBAC (`remediation:execute`, doctor role only). `run_fix_script()` maps a
fix name onto one of these actions:

| Action | Trigger | Notes |
|--------|---------|-------|
| `restart_container` | Service unhealthy / returning 5xx / crashed | Worker containers only (`turing-worker=true` label); worker token OK |
| `check_disk_usage` | Disk alert | Read-only `docker system df`; worker token OK |
| `cleanup_docker` | Disk pressure | Prunes **dangling** images/volumes + unused networks only; requires `ADMIN_API_TOKEN` |

There is intentionally **no arbitrary-command action** — unknown actions are
rejected (HTTP 400). For safety, dynamic fix-script creation
(`create_dynamic_fix_script`) is **disabled** (no local write+exec) and arbitrary
config patching (`patch_config_file`) is **gated** (workspace-only, opt-in via
`DOCTOR_ALLOW_CONFIG_PATCH`, defaults off).

### 6. Advanced Security & Orchestration Gateway (NEW)
- **Centralized Gateway Proxy**: All worker traffic to external services (LLM, Plane, BookStack, Matrix) is routed through the orchestrator.
- **Credential Vault & Consumer Tokens**: Workers authenticate using short-lived JWT tokens rather than direct API keys.
- **Role-Based Access Control (RBAC)**: Fine-grained permissions per role (e.g., `software-engineer` can write code, `qa` can only read).

#### Required environment variables

The orchestrator now fails fast if any of these are missing or too short. Generate with `openssl rand -hex 32`.

| Variable | Min length | Purpose |
|----------|-----------:|---------|
| `JWT_SECRET` | 32 chars | Signs worker consumer tokens |
| `VAULT_MASTER_KEY` | 32 chars | AES-256-CBC key for the credential vault |
| `ADMIN_API_TOKEN` | 16 chars | Bearer token for admin-only gateway endpoints (`/gateway/tokens`, `/gateway/credentials`, …) |
| `GATEWAY_ENABLED` | — | Gateway is ON by default; set to `false` for legacy direct-key mode |

See `.env.example` for the full list.

### 6. Orchestration Features Status
- **PM Failover**: ✅ Doctor-managed via health-monitor → PMStateManager (no standby process needed)
- **Timeout / Retry / Escalation**: Policy exists in docs, runtime flow is partially shipped.
- **Retro Reports**: Post-execution reports are still a roadmap item.

---

## 🆚 Comparison with HiClaw

| Feature | HiClaw | Turing OS | Improvement |
|---------|--------|-----------|-------------|
| **Architecture** | Flat (Manager-Worker) | Hierarchy (PO→PM→HR→Workers) 🗺️ | ✅ Clearer separation (full intake delegation roadmap) |
| **Priority System** | ❌ None | ✅ P0-P3 with interrupt | ✅ Urgent requests handled |
| **Idempotency** | ❌ None | ✅ Registry-based deduplication | ✅ No duplicates |
| **Resource Scaling** | Manual | 🧪 Auto-scaling (experimental) | ✅ Dynamic (see caveats) |
| **PM Failover** | ❌ None | 🧪 Doctor-managed | No SPOF (diagnosis works; restart via orchestrator `restart_container`, pending live verification) |
| **Worker Health** | ❌ None | ✅ Health monitor + auto restart | ✅ Self-healing |
| **Worker Checkpoint** | ❌ None | ✅ Doctor-first + checkpoint restore | ✅ No work loss |
| **Timeout/Escalation** | Manual | 🧪 Auto timeout → escalate (partial) | Partially shipped |
| **Bug Resolution** | User self-reports to GitHub | 🧪 Doctor agent → diagnose + orchestrator-mediated fix | Diagnosis + allow-listed remediation implemented; pending live verification |
| **Communication** | Peer-to-peer (Matrix) | ✅ Bidirectional via Orchestrator | ✅ No deadlocks |
| **Documentation** | Generic roles | ✅ Domain-specific JDs | ✅ Accurate skills |

Legend: ✅ Shipped · 🧪 Experimental · 🗺️ Roadmap

Current snapshot: Matrix HITL, worker health, priority routing, role loading, and BMAD workflow integration are **shipped** (✅). Doctor diagnostics, auto-scaling, PM failover, and timeout/escalation are **experimental** (🧪) — see the notes in the sections above. Doctor's gateway-routed knowledge base / escalation and orchestrator-mediated fix execution (allow-listed `POST /remediation`) are **implemented and unit-tested but pending live-stack verification**. Full PO→PM→HR→Workers delegation at ticket intake and retro reports remain **roadmap** items (🗺️).

---

## 🤖 BMAD Integration

Turing OS integrates with **BMAD (Breakthrough Method for Agile AI Driven Development)** to provide structured development workflows.

### What is BMAD?

BMAD is an AI-driven development framework with **46k+ GitHub stars** providing:
- **Structured Workflows**: PRD → Architecture → Stories → Dev → QA gate
- **Specialized Agents**: 12+ domain experts (PM, Architect, Developer, UX, QA)
- **Scale-Adaptive**: Automatically adjusts planning depth to project complexity
- **Skills System**: Reusable skill modules for agents

### Integration Components

| Component | Description |
|-----------|-------------|
| **BMAD Workflow Templates** | Structured PRD, architecture, and story templates for PO |
| **BMAD Skills Registry** | Development, QA, and review skills for workers |
| **BMAD Agent Patterns** | Reference templates for specialized agent roles |

### BMAD Workflow in Turing OS

```
Stakeholder Request
       ↓
   [PO] ← BMAD PRD Template
   - Verify project (existing/new)
   - Use BMAD structured requirements
   - Confirm all details
       ↓
   [PO] ← BMAD Architecture Phase
   - System design using BMAD templates
   - Component specifications
       ↓
   [PO] ← BMAD Stories Phase
   - Break into user stories
   - Acceptance criteria (Given/When/Then)
       ↓
   [PM] ← Receives READY task
   - Create execution plan
   - Assign to workers
       ↓
   [Workers] ← BMAD Dev Standards
   - Load relevant skills
   - Follow BMAD development checklist
       ↓
   [QA] ← BMAD QA Gate
   - Risk-based testing
   - Quality validation
```

### Using BMAD in Turing OS

**PO can use BMAD templates:**
```markdown
# BMAD PRD Template - Use when creating new tasks
## Business Context
## Goals & Success Metrics
## Users & Stakeholders
## Requirements (Functional/Non-Functional)
## Constraints
## Risks & Mitigations
## Acceptance Criteria
```

**Workers can load BMAD skills:**
```python
# Load BMAD development skills + language-specific skills
TOOL_CALL: load_skills_for_task
ARGUMENTS: {"skill_names": "bmad-dev,python,fastapi"}
```

### Resources

| Resource | Link |
|----------|------|
| BMAD Documentation | https://docs.bmad-method.org/ |
| BMAD GitHub | https://github.com/bmad-code-org/BMAD-METHOD |
| Integration Guide | [docs/bmad-integration.md](docs/bmad-integration.md) |

---

## 🏗️ Architecture

### Infrastructure Stack

| Service | Port | Purpose |
|---------|------|---------|
| **Plane** | 9000 | Ticket management & webhooks |
| **BookStack** | 6875 | Documentation & secrets storage |
| **Matrix (Synapse)** | 8008 (localhost) | Bidirectional admin ↔ worker communication |
| **Element Web** | 8080 | Web chat interface for Matrix |
| **Orchestrator** | 3001 | Event-driven API gateway & Matrix relay |
| **Workers** | Ephemeral | Docker containers, auto-remove |
| **Orchestrator** `/containers` | 3001 | Doctor container discovery API |
| **Orchestrator** `/containers/:name/logs` | 3001 | Container log retrieval for Doctor |

### Communication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  BIDIRECTIONAL COMMUNICATION                     │
│                                                                  │
│  Admin (Element Web :8080)                                       │
│       │           ▲                                              │
│       ▼           │                                              │
│  Matrix Synapse (:8008) ─── Per-worker rooms                     │
│       │           ▲                                              │
│       ▼           │                                              │
│  Orchestrator (:3001) ─── /sync listener                         │
│       │           ▲                                              │
│       │           │   POST /webhooks/worker-message               │
│       ▼           │                                              │
│  GET /worker-inbox/{id}                                          │
│       │           │                                              │
│       ▼           │                                              │
│  Worker (ephemeral container)                                    │
│                                                                  │
│  Admin → Element → Matrix → Orchestrator → Worker Inbox → Worker │
│  Worker → Orchestrator → Matrix Room → Element → Admin           │
└─────────────────────────────────────────────────────────────────┘
```

### Event Flow

```
1. Stakeholder creates ticket in Plane
   ↓
2. Webhook triggers → Orchestrator
   ↓
3. PO approves → PM receives task
   ↓
4. PM dispatches → Workers execute
   ↓
5. Worker needs input? → ask_admin() → Matrix → Admin replies
   ↓
6. Worker blocked? → Matrix alert → Admin /unblock
   ↓
7. Task failed? → Doctor diagnosis → Fix or GitHub Issue
   ↓
8. Complete → Plane ticket updated → Retro report
```

---

## 🚀 Quick Start

```bash
# 1. Clone repository
git clone https://github.com/louisphamdev/turing-os.git
cd turing-os

# 2. Create local env file
cp .env.example .env

# 3. Configure LLM provider in .env
#    For ollama, you can leave LLM_API_KEY blank and point LLM_BASE_URL to localhost.

# 4. Build images and start services
make build
make up

# 5. Bootstrap Matrix admin/bot accounts + tokens
make bootstrap
# (equivalent to running ./init-admin-users.sh, or .\init-admin-users.ps1 on Windows)

# 6. Verify orchestrator health
curl http://localhost:3001/health
```

### Access Services

| Service | URL |
|---------|-----|
| Plane (Ticket Management) | http://localhost:9000 |
| BookStack (Documentation) | http://localhost:6875 |
| Element Web (Chat Interface) | http://localhost:8080 |
| Matrix Synapse (API) | http://localhost:8008 |
| Orchestrator (API) | http://localhost:3001/health |

---

## 📋 Directory Structure

```
turing-os/
├── orchestrator/           # Node.js API gateway & Matrix relay
│   └── src/
│       ├── api/webhooks.ts  # Plane, Matrix & worker-inbox endpoints
│       ├── core/
│       │   ├── matrix.ts   # Bidirectional Matrix communication hub
│       │   ├── docker.ts   # Worker container management
│       │   ├── registry.ts # Worker state tracking
│       │   └── health-monitor.ts
│       ├── agents/         # Role spec loader
│       └── config/         # Centralized configuration
├── base-worker/            # Python worker
│   └── src/
│       ├── agent/          # ReAct loop (Hermes)
│       └── tools/          # Plane, BookStack, Matrix, terminal
├── roles/                  # Agent definitions
│   ├── po.md, pm.md, hr.md
│   ├── software-engineer.md
│   └── languages/          # Tech stack skills
├── scripts/                # Orchestrator health, smoke tests, cron maintenance
├── synapse/                # Matrix Synapse config
├── element_config/         # Element Web config
├── .github/                # Issue templates
├── helm/                   # Kubernetes deployment (🗺️ roadmap stub — Chart.yaml + README only)
└── docs/                   # Architecture docs
```

---

## 🔧 Configuration

All configuration lives in `.env` (copy from `.env.example`). Matrix admin/bot
tokens are generated automatically by `init-admin-users.sh` (run via
`make bootstrap`); the Plane API token is obtained from the Plane onboarding UI
and pasted into `PLANE_API_TOKEN`. See `.env.example` for the full list of
variables.

To verify the stack is healthy:

```bash
curl http://localhost:3001/health
docker compose logs -f turing-orchestrator
```

---

## 💬 Admin Commands

| Command | Description |
|---------|-------------|
| `/status` | Show all workers and system status |
| `/timeout-status` | Show workers currently waiting for admin replies |
| `/unblock <ticket_id>` | Restart a blocked worker |
| `/kill <ticket_id>` | Terminate a worker |
| `/help` | Show the list of available admin commands |
| _(plain message in a worker room)_ | Send message to worker in that room |

> ✅ The commands above (plus `/help`) work as slash-commands typed directly in Element chat — the in-chat command handler dispatches them through the orchestrator and posts the result back into the room. They are **admin-authorized**: only the configured `MATRIX_ADMIN_USER_ID` may run them; other senders are rejected. The same `handleAdminCommand` logic also backs the authenticated HTTP admin-command endpoint, so the two surfaces never drift.

## ✅ First-Run Checklist

1. Build and start the stack with `make build && make up` (or `docker compose up -d`) from the repository root.
2. Bootstrap service users with `make bootstrap` (`./init-admin-users.sh` on macOS/Linux, `.\init-admin-users.ps1` on Windows).
3. Verify the orchestrator is healthy with `curl http://localhost:3001/health`.
4. Open Element at http://localhost:8080 and sign in with the admin account you configured.
5. Create a Plane ticket in `TODO` state to confirm the orchestrator spawns a worker (watch `docker compose logs -f turing-orchestrator`).

---

## 📊 Roadmap

| Version | Goals | Status |
|---------|-------|--------|
| v1.0 | Core: Plane + Workers + PM + HR | ✅ Shipped |
| v1.1 | Matrix bidirectional HITL + Worker Health + Flapping Detection | ✅ Shipped |
| v1.2 | Security Gateway Proxy + RBAC | ✅ Shipped; Auto-scaling 🧪 experimental; Doctor diagnostics 🧪 |
| v1.3 | Doctor orchestrator-mediated remediation + gateway-routed KB/escalation | 🧪 Implemented + unit-tested via `/gateway/*` and `POST /remediation`; pending live-stack verification. Dynamic-script creation disabled, config patching gated for safety. |
| v2.0 | PM failover (Doctor) + Timeout/Escalation hardening + Retro reports | In Progress (🧪/🗺️) |

Legend: ✅ Shipped · 🧪 Experimental · 🗺️ Roadmap

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md).

**Bug Reports**: [GitHub Issues](https://github.com/louisphamdev/turing-os/issues)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.