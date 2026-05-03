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
- Creates tickets in **Taiga** with automatic workflow

### 2. Automated Software Development
- **Workers** execute tasks using ReAct loop
- Multi-language support: Python, JavaScript, TypeScript, Go, Rust, .NET, Java
- Auto research with Context7 for unknown tech
- Tools: **Wiki.js** (docs), **Taiga** (tickets), sandbox terminal

### 3. Bidirectional Human-in-the-Loop (HITL)
- **Matrix** enables real-time two-way communication between admin and workers
- Admin sends messages in worker's Matrix room → routed to worker via orchestrator
- Workers ask questions, send progress updates, request human input
- Admin commands: `/status`, `/timeout-status`, `/unblock`, `/kill`, `/help`
- **Element Web** provides a modern chat interface for admin interaction

### 4. Self-Healing & Monitoring
- **Worker Health**: Auto restart dead workers
- **Priority Queue**: Running, queued, and paused task state is exposed via orchestrator APIs
- **Alert Manager**: Real-time monitoring of Docker lifecycle events (e.g., OOM kills) and system anomalies.
- **Auto-Scaling**: Orchestrator dynamically scales workers up/down based on CPU/RAM utilization and idle thresholds.

### 5. Advanced Security & Orchestration Gateway (NEW)
- **Centralized Gateway Proxy**: All worker traffic to external services (LLM, Taiga, Wiki.js, Matrix) is routed through the orchestrator.
- **Credential Vault & Consumer Tokens**: Workers authenticate using short-lived JWT tokens rather than direct API keys.
- **Role-Based Access Control (RBAC)**: Fine-grained permissions per role (e.g., `software-engineer` can write code, `qa` can only read).
- **Intent Parser**: LLM-powered module that reliably translates natural language admin commands via Matrix into structured actions.

### 6. Planned Orchestration Features
- **PM Failover**: Hot-standby PM takeover is documented but not implemented yet
- **Timeout / Retry / Escalation**: Policy exists in docs, runtime flow is partially shipped.
- **Retro Reports**: Post-execution reports are still a roadmap item.

---

## 🆚 Comparison with HiClaw

| Feature | HiClaw | Turing OS | Improvement |
|---------|--------|-----------|-------------|
| **Architecture** | Flat (Manager-Worker) | Hierarchy (PO→PM→HR→Workers) | ✅ Clearer separation |
| **Priority System** | ❌ None | ✅ P0-P3 with interrupt | ✅ Urgent requests handled |
| **Idempotency** | ❌ None | ✅ Registry-based deduplication | ✅ No duplicates |
| **Resource Scaling** | Manual | PM-controlled auto-scaling | ✅ Dynamic |
| **PM Failover** | ❌ None | ✅ Hot standby | ✅ No SPOF |
| **Worker Health** | ❌ None | ✅ Health monitor + auto restart | ✅ Self-healing |
| **Timeout/Escalation** | Manual | ✅ Auto timeout → escalate | ✅ Automated |
| **Bug Resolution** | User self-reports to GitHub | ✅ Doctor agent → fix or issue | ✅ Autonomous |
| **Communication** | Peer-to-peer (Matrix) | ✅ Bidirectional via Orchestrator | ✅ No deadlocks |
| **Documentation** | Generic roles | ✅ Domain-specific JDs | ✅ Accurate skills |

Current snapshot: Matrix HITL, worker health, priority routing, role loading, and BMAD workflow integration are shipped; PM failover, timeout escalation, and auto-scaling remain roadmap items.

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
| **Taiga** | 9000 | Ticket management & webhooks |
| **Wiki.js** | 6875 | Documentation & secrets storage |
| **Matrix (Synapse)** | 8008/8448 | Bidirectional admin ↔ worker communication |
| **Element Web** | 8080 | Web chat interface for Matrix |
| **Orchestrator** | 3001 | Event-driven API gateway & Matrix relay |
| **Workers** | Ephemeral | Docker containers, auto-remove |

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
1. Stakeholder creates ticket in Taiga
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
8. Complete → Taiga ticket updated → Retro report
```

---

## 🚀 Quick Start

### Guided Local Installer

**macOS / Linux:**
```bash
bash install/install.sh
```

**Windows (PowerShell):**
```powershell
.\install\install.ps1
```

### Manual Installation

```bash
# 1. Clone repository
git clone https://github.com/louisphamdev/turing-os.git
cd turing-os

# 2. Create local env file
cp .env.example .env

# 3. Configure LLM provider in .env
#    For ollama, you can leave LLM_API_KEY blank and point LLM_BASE_URL to localhost.

# 4. Build images
docker build -t turing-worker-base:latest ./base-worker
docker compose build turing-orchestrator

# 5. Start services
docker compose up -d

# 6. Bootstrap Taiga + Matrix accounts
./init-admin-users.sh

# Windows PowerShell
.\init-admin-users.ps1

# 7. Verify service connections
bash install/config.sh test

# Windows PowerShell
.\install\config.ps1 -Service test

# 8. Verify orchestrator health
curl http://localhost:3001/health
```

### Access Services

| Service | URL |
|---------|-----|
| Taiga (Ticket Management) | http://localhost:9000 |
| Wiki.js (Documentation) | http://localhost:6875 |
| Element Web (Chat Interface) | http://localhost:8080 |
| Matrix Synapse (API) | http://localhost:8008 |
| Orchestrator (API) | http://localhost:3001/health |

---

## 📋 Directory Structure

```
turing-os/
├── install/                 # Installers (sh + ps1)
├── orchestrator/           # Node.js API gateway & Matrix relay
│   └── src/
│       ├── api/webhooks.ts  # Taiga, Matrix & worker-inbox endpoints
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
│       └── tools/          # Taiga, Wiki.js, Matrix, terminal
├── roles/                  # Agent definitions
│   ├── po.md, pm.md, hr.md
│   ├── software-engineer.md
│   └── languages/          # Tech stack skills
├── synapse/                # Matrix Synapse config
├── element_config/         # Element Web config
├── taiga-gateway/          # Taiga nginx config
├── .github/                # Issue templates
├── helm/                   # Kubernetes deployment
└── docs/                   # Architecture docs
```

---

## 🔧 Configuration

Tokens are managed separately via config manager:

```powershell
# Windows
.\install\config.ps1                    # Configure all
.\install\config.ps1 -Service taiga     # Taiga only
.\install\config.ps1 -Service test      # Test connections

# macOS/Linux
./install/config.sh                     # Configure all
./install/config.sh taiga               # Taiga only
./install/config.sh test                # Test connections
```

Services status:
```
╔══════════════════════════════════════╗
║     TURING OS SERVICE STATUS          ║
╠══════════════════════════════════════╣
║  Taiga:      ✓ Connected             ║
║  Matrix:     ✓ Connected (sync)      ║
║  Element:    ✓ Connected             ║
║  Wiki.js:    ✓ Connected             ║
║  Context7:   ✓ Connected             ║
╚══════════════════════════════════════╝
```

---

## 💬 Admin Commands (via Matrix/Element)

| Command | Description |
|---------|-------------|
| `/status` | Show all workers and system status |
| `/timeout-status` | Show workers currently waiting for admin replies |
| `/unblock <ticket_id>` | Restart a blocked worker |
| `/kill <ticket_id>` | Terminate a worker |
| `/help` | Show available commands |
| _(plain message)_ | Send message to worker in that room |

## ✅ First-Run Checklist

1. Run `docker compose up -d` from the repository root.
2. Bootstrap service users with `./init-admin-users.sh` on macOS/Linux or `.\init-admin-users.ps1` on Windows.
3. Verify tokens and service connections with `bash install/config.sh test` or `.\install\config.ps1 -Service test`.
4. Open Element at http://localhost:8080 and sign in with the admin account you configured.
5. Create a Taiga ticket in `TODO` state, then use `/status` in Element to confirm the orchestrator sees active workers.

---

## 📊 Roadmap

| Version | Goals |
|---------|-------|
| v1.0 | Core: Taiga + Workers + PM + HR |
| v1.1 | Matrix bidirectional HITL + Worker Health |
| v1.2 | Security Gateway Proxy + RBAC + Auto-scaling |
| v2.0 | PM failover + Timeout/Escalation hardening + Retro reports |

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md).

**Bug Reports**: [GitHub Issues](https://github.com/louisphamdev/turing-os/issues)
**LLM Feedback**: [LLM Feedback Template](https://github.com/louisphamdev/turing-os/issues/new?template=llm_feedback.yml)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.