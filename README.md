# Project Turing - Multi-Agent IT Department OS

> An event-driven, AI-powered IT department simulation using Plane tickets, ephemeral Docker workers, and LLM-driven reasoning.

## Overview

Turing is a **Multi-Agent Operating System** that simulates an IT department. Instead of text-based LLM communication, it uses **event-driven architecture** through:

- **Plane.so** - Ticket management with webhooks
- **Docker** - Dynamic worker provisioning
- **Revolt** - Human-in-the-loop alerts
- **BookStack** - Documentation and secrets storage

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PROJECT TURING                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Stakeholder ──► [PO] ──► [PM] ──► [HR] ──► [Workers]               │
│                        │       │       │                            │
│                        │       │       └──► skills.sh + Context7    │
│                        │       │                                    │
│                        │       └──► Retro Reports ──► All Workers   │
│                        │                                            │
│                        └──► [DOCTOR] ◄── User Bug Reports           │
│                                 │                                   │
│  BookStack ◄────────────────────────────────────────────────────────│
│    • Roles & JD                                                     │
│    • Project Config                                                 │
│    • Retro Reports                                                  │
│    • Secrets (API keys)                                             │
│                                                                     │
│  Plane.so ◄─────────────────────────────────────────────────────────│
│    • Ticket Lifecycle                                               │
│    • State Machine (TODO → IN_PROGRESS → REVIEW/DONE/BLOCKED)       │
│                                                                     │
│  Revolt ◄───────────────────────────────────────────────────────────│
│    • Blocked Task Alerts                                            │
│    • Human Intervention (/unblock command)                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Architecture

### Infrastructure

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| **plane-api** | makeplane/plane | 3000 | Ticket API |
| **plane-web** | makeplane/plane | 80 | Ticket UI |
| **bookstack** | linuxserver/bookstack | 6875 | Docs & Secrets |
| **revolt** | revoltchat/server | 8080 | Alerts & Chat |
| **orchestrator** | custom | 3000 | API Gateway |
| **workers** | turing-worker-base | - | Ephemeral execution |

### Directory Structure

```
turing-os/
├── install/                    # Installer scripts
│   ├── install.sh             # macOS/Linux installer
│   ├── install.ps1           # Windows installer
│   ├── config.sh              # Linux/Mac config manager
│   └── config.ps1             # Windows config manager
├── docker-compose.yml          # All infrastructure
├── .env.example                # Environment template
├── project-config.md            # Execution modes & priorities
│
├── orchestrator/               # THE BRAIN (Node.js)
│   ├── src/
│   │   ├── api/
│   │   │   └── webhooks.ts     # Plane & Revolt listeners
│   │   ├── core/
│   │   │   ├── docker.ts       # Docker SDK wrapper
│   │   │   ├── registry.ts     # Idempotency enforcement
│   │   │   └── revolt.ts       # Revolt notification service
│   │   └── index.ts            # Entry point
│   └── Dockerfile
│
├── base-worker/                 # THE EXECUTOR (Python)
│   ├── src/
│   │   ├── agent/
│   │   │   └── hermes_loop.py  # ReAct tool-calling loop
│   │   └── tools/
│   │       ├── plane_tools.py   # Ticket operations
│   │       ├── bookstack_tools.py
│   │       ├── local_exec.py    # Sandbox terminal
│   │       └── research_tools.py # skills.sh + Context7
│   └── Dockerfile
│
└── roles/                      # Agent definitions
    ├── po.md                   # Product Owner
    ├── pm.md                   # Project Manager
    ├── hr.md                   # Human Resources
    ├── software-engineer.md    # Base SE skills
    ├── languages/              # Language-specific skills
    │   ├── dotnet.md
    │   ├── java.md
    │   └── react.md
    └── specializations/        # Specialization skills
        ├── backend.md
        └── frontend.md
```

## Installation

### Quick Start (One-Command)

**macOS / Linux:**
```bash
curl -sSL https://turing-os.ai/install.sh | bash
```

**Windows (PowerShell 7+):**
```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; iwr https://turing-os.ai/install.ps1 | iex
```

### Manual Installation

```bash
# 1. Clone repository
git clone https://github.com/YOUR_USERNAME/project-turing.git
cd project-turing

# 2. Copy and edit environment
cp .env.example .env
# Edit .env with your API keys

# 3. Build worker image
docker build -t turing-worker-base:latest ./base-worker

# 4. Start infrastructure
docker compose up -d
```

### Prerequisites

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Docker | 20.10+ | Latest |
| Docker Compose | 2.0+ | Latest |
| RAM | 4 GB | 8 GB |
| CPU | 2 cores | 4 cores |

### Installation Modes

| Mode | Description |
|------|-------------|
| **Unattended** | Uses placeholder API keys, configure later |
| **Interactive** | Prompts for all configuration values |

### Post-Installation

1. **Configure Plane webhooks** (Settings → Webhooks)
   - URL: `http://your-server:3000/webhooks/plane`
   - Events: Ticket created, updated

2. **Create BookStack pages** for secrets and roles
   - Secrets page: `context7-api-key=sk-xxx`
   - Roles pages: Copy from `roles/` directory

3. **Access services**:
   - Plane: http://localhost:3000
   - BookStack: http://localhost:6875
   - Revolt: http://localhost:8080

### Configuration Management

**After installation, use the config manager to add/update tokens:**

```bash
# macOS/Linux
cd turing-os/install
./config.sh                    # Configure all services
./config.sh plane               # Configure Plane only
./config.sh test                # Test all connections

# Windows
cd turing-os/install
.\config.ps1                    # Configure all services
.\config.ps1 -Service plane     # Configure Plane only
.\config.ps1 -Service test      # Test all connections
```

**Config manager features:**
- Interactive prompts with current values as defaults
- Token validation before saving
- Service connectivity testing
- Status overview of all services

**Example output:**
```
╔══════════════════════════════════════════════════════╗
║            TURING OS SERVICE STATUS                 ║
╚══════════════════════════════════════════════════════╝

  Plane:      ✓ Connected
  Revolt:     ⚠ Not configured
  BookStack:  ⚠ Not configured
  Context7:   ✓ Connected
```

### Upgrading

```bash
# macOS/Linux
curl -sSL https://turing-os.ai/install.sh | bash

# Windows
irm https://turing-os.ai/install.ps1 | iex

# Manual
cd turing-os && git pull && docker compose up -d
```

### Uninstalling

```bash
# macOS/Linux
bash <(curl -fsSL https://turing-os.ai/install.sh) uninstall

# Windows
irm https://turing-os.ai/install.ps1 -uninstall
```

## Quick Start

### 1. Prerequisites

```bash
# Required
Docker & Docker Compose
Node.js 20+
Python 3.11+

# API Keys (add to .env)
- LLM API Key (OpenAI/Claude)
- Plane API Key
- Revolt Bot Token
- Context7 API Key (in BookStack secrets page)
```

### 2. Setup

```bash
# Clone and enter directory
cd turing-os

# Copy environment file
cp .env.example .env
# Edit .env with your API keys

# Build worker image
docker build -t turing-worker-base:latest ./base-worker

# Start infrastructure
docker compose up -d

# Access services
# Plane:    http://localhost
# BookStack: http://localhost:6875
# Revolt:   http://localhost:8080
# API:      http://localhost:3000
```

### 3. Create First Ticket

In Plane, create a ticket with:
- Status: **TODO**
- Title: "Hello World Test"
- Description: "Print 'Hello World' using Python"

The webhook will trigger → Orchestrator spawns worker → Worker executes task → Ticket marked **DONE**

## Core Concepts

### Agent Roles

| Role | Purpose |
|------|---------|
| **PO** | First contact for stakeholders. Verifies project, discusses requirements, confirms before handing to PM |
| **PM** | Executes tasks. Breaks down requirements, assigns to workers, manages timeline |
| **HR** | Manages worker lifecycle. Loads skills, creates workers, terminates idle workers |
| **DOCTOR** | System doctor. Receives bug reports, diagnoses, attempts fix, escalates to developers, classifies bugs |
| **Workers** | Execute tasks using Hermes ReAct loop with skills.sh and Context7 research |

### Ticket State Machine

```
TODO ──► IN_PROGRESS ──► DONE
              │
              ├──► REVIEW
              │
              └──► BLOCKED ──► (Human /unblock) ──► TODO
```

### Priority System

| Level | Name | Behavior |
|-------|------|----------|
| P0 | CRITICAL | Pause current task immediately |
| P1 | HIGH | Complete current, then this |
| P2 | MEDIUM | Normal queue (default) |
| P3 | LOW | Fill remaining capacity |

### Execution Modes

**Sequential** (default)
- One task at a time
- Lower resource cost
- P0 can interrupt

**Parallel**
- Multiple workers simultaneously
- Higher resource cost
- Faster completion

### Resource Scaling

PM controls how many workers are alive:

| Mode | Max Workers | Description |
|------|-------------|-------------|
| **conservative** | 2 | Keep minimum, scale on demand |
| **balanced** | 5 | Multiple roles, moderate cost |
| **aggressive** | 10 | Many workers, higher cost |
| **all** | unlimited | No limit, max parallelism |

**Core Roles (PO, PM)** are **ALWAYS alive**.  
**Dynamic Roles (workers)** scale up/down based on PM's decisions.

HR coordinates with PM before terminating idle workers to avoid conflicts.

### Skills Loading (MANDATORY)

Every worker **MUST** load skills before executing:

```python
# 1. Load from skills.sh
skills = await load_skills_for_task("python,fastapi,sql")

# 2. Research with Context7 if unfamiliar
docs = await research_with_context7("fastapi", topic="authentication")

# 3. Then proceed with task
```

## Configuration

### Project Config (`project-config.md`)

```yaml
execution:
  mode: sequential  # or parallel
  allow_interrupt: true
  
parallel:
  max_concurrent_workers: 3
  
queue:
  default_priority: P2
  
resources:
  max_workers: 5
  reserved_for_emergency: 1
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `LLM_API_KEY` | OpenAI/Claude API key |
| `LLM_PROVIDER` | 'openai' or 'anthropic' |
| `WORKER_TIMEOUT_MINUTES` | Kill workers after N minutes (default: 15) |
| `REVOLT_ADMIN_USER_ID` | User to receive blocked alerts |
| `CONTEXT7_API_KEY` | Stored in BookStack secrets page |

### Worker Communication Protocol

**ALL task decisions go through PM. Workers NEVER communicate directly.**

```
Worker A ── ✗ ── Worker B    (FORBIDDEN)
     │                      │
     └──────────┬───────────┘
                │
                ▼
         ┌─────────────┐
         │      PM     │ ← SINGLE SOURCE OF TRUTH
         └─────────────┘
```

Workers report to PM → PM coordinates → No peer-to-peer communication.

See: [worker-communication-protocol.md](worker-communication-protocol.md)

## Human-in-the-Loop

### When a Task is Blocked

1. Worker calls `update_ticket_status('BLOCKED', reason)`
2. Orchestrator receives webhook notification
3. Revolt DM sent to admin with:
   - Ticket ID
   - Block reason
   - `/unblock <ticket_id>` command

### To Unblock

In Revolt, send:
```
/unblock TICKET-123
```

Orchestrator will:
- Reset ticket to TODO
- Restart worker

## Retro Reports

After each task, PM creates a **Retro Report**:
- What went well
- What could improve
- Blockers encountered
- Lessons learned

Reports are:
1. Sent to all workers
2. Stored in BookStack (`/retro/[year]/[quarter]/`)
3. Workers acknowledge and update their memory

## Doctor - System Diagnostics

**Doctor** is the system doctor that handles bug reports from users.

### Doctor Workflow

```
User Report Error
       │
       ▼
┌───────────────────┐
│ TRIAGE            │
│ • Categorize      │
│ • Check known     │
│ • Assess urgency  │
└───────────────────┘
       │
       ▼
┌───────────────────┐
│ DIAGNOSE          │
│ • Gather logs     │
│ • Find root cause │
│ • Identify fix    │
└───────────────────┘
       │
       ▼
┌───────────────────┐
│ ATTEMPT FIX       │
│ • Apply solution  │
│ • Test result     │
│ • Document fix    │
└───────────────────┘
       │
   ┌────┴────┐
   │         │
FIXED    CAN'T FIX
   │         │
   ▼         ▼
┌────────┐ ┌────────────────┐
│CLASSIFY│ │ ESCALATE       │
│ • LLM  │ │ • Send email   │
│ • Proj │ │ • Wait for fix │
│ • User │ │ • Test when done│
└────────┘ └────────────────┘
```

### Bug Classification

| Type | Description | Action |
|------|-------------|--------|
| **PROJECT_BUG** | Error in Turing OS code/config | Fix in code, update Doctor |
| **LLM_BUG** | Error caused by LLM hallucination | Report to LLM developer |
| **USER_ERROR** | User misused the system | Educate user |

### User Reporting

Users create a ticket in Plane with:
- Title: "Bug: [brief description]"
- Category label: `doctor-report`
- Description: Full error details, steps to reproduce

### Developer Escalation

If Doctor can't fix:
1. **PROJECT_BUG**: Fix required in Turing OS code → email to developer
2. **LLM_BUG**: Feedback to LLM developer for improvement

```
Email contains:
- Error description
- Steps to reproduce
- Logs and context
- Classification (project_bug / llm_bug)
```

See: [roles/doctor.md](roles/doctor.md)

## Timeout & Escalation Policy

Workers operate with bounded wait times. If responses don't arrive within SLA, the system escalates automatically.

### Timeout Rules

| Action | Timeout | Max Retries | Escalation |
|--------|---------|-------------|------------|
| Worker → PM: Request coordination | 5 min | 3 | PM escalates to PO |
| PM → Worker: Task assignment | 2 min | 1 | PM reassigns |
| Worker → Worker: Dependency response | 5 min | 3 | PM force-resolve |
| Health check: Worker heartbeat | 2 min | 1 | Warning, then investigate |

### Escalation Triggers

- 3 retries with no response → PO decision required
- Task blocked > 15 min → PO review
- Worker unresponsive → kill and respawn
- Resource exhaustion → PO budget decision
- Conflict unresolved > 10 min → PO force resolution

See: [timeout-policy.md](timeout-policy.md)

## PM Failover System

PM is the single point of failure. A **hot standby** takes over if primary fails.

### Architecture

```
┌─────────────────────────────────────┐
│           PRIMARY PM                 │
│  • Writes state to Plane every 30s  │
│  • Heartbeat ping every 30s          │
└─────────────────────────────────────┘
                  │
           State sync (30s)
                  │
                  ▼
┌─────────────────────────────────────┐
│           STANDBY PM                 │
│  • Monitors primary heartbeat        │
│  • If offline > 60s → TAKEOVER      │
└─────────────────────────────────────┘
```

### Failover Trigger Conditions

| Condition | Trigger | Action |
|-----------|---------|--------|
| Primary heartbeat missing | > 60 seconds | Standby activates |
| Primary PM process dead | System detects | Standby promoted |
| Primary unreachable | > 3 sync cycles | Standby promoted |

### Takeover Sequence

1. Standby logs: "Primary PM dead, initiating takeover"
2. Standby updates Plane: marks self as primary
3. Standby broadcasts to workers: new PM active
4. Standby reads full state from Plane
5. Standby resumes operations

See: [pm-failover.md](pm-failover.md)

## Worker Health Monitoring

PM monitors worker health via heartbeats and progress indicators.

### Health States

| State | Criteria | Action |
|-------|----------|--------|
| **HEALTHY** | Heartbeat < 2 min ago, progress recent | Normal |
| **WARNING** | Missed 1-2 heartbeats | Log, monitor |
| **STUCK** | No heartbeat > 6 min OR no progress > 10min | Investigate |
| **DEAD** | Missed 3+ heartbeats | Kill + respawn |

### Heartbeat Protocol

- Workers send heartbeat every 2 minutes
- Miss 1 → WARNING
- Miss 3 → DEAD → PM kills and HR respawns

### Stuck Worker Handling

1. Get current task status from Plane
2. If task BLOCKED → don't kill (expected)
3. If not blocked → try ping worker
4. If no response → KILL + RESPAWN

### Zombie Killer

Cron job every 5 minutes:
- Kill containers with no heartbeat > 15 minutes
- Force restart dead workers

See: [worker-health.md](worker-health.md)

## BookStack Setup

### Required Pages

**Secrets Page** (for API keys):
```
context7-api-key=sk-xxxxxxxxxxxx
```

**Roles Pages**:
- `/roles/software-engineer.md`
- `/roles/hr.md`
- etc.

**Retro Reports**:
- `/retro/2026-Q2/`
- `/retro/2026-Q3/`

## Development

### Run Orchestrator Locally

```bash
cd orchestrator
npm install
npm run dev
```

### Run Worker Locally

```bash
cd base-worker
pip install -r requirements.txt
TICKET_ID=test LLM_API_KEY=sk-xxx python -m src.index
```

### Test Webhook

```bash
# Simulate Plane webhook
curl -X POST http://localhost:3000/webhooks/plane \
  -H "Content-Type: application/json" \
  -d '{"ticket_id": "TEST-001", "status": "TODO", "role": "software-engineer"}'
```

## Verification Phases

| Phase | Description | Verification |
|-------|-------------|--------------|
| 1 | Infrastructure | `docker compose up -d` works |
| 2 | Idempotency | Same ticket_id sent twice → only 1 container |
| 3 | Base Worker | Task completes → DONE status |
| 4 | Revolt | BLOCKED → DM sent → /unblock works |
| 5 | Timeout Policy | Retries exhausted → escalation to PO |
| 6 | PM Failover | Primary dies → standby takes over |
| 7 | Health Monitoring | Worker DEAD → PM kills and HR respawns |

## Strict Rules

1. **Zero-State Workers**: No global variables. All state in Plane/BookStack.
2. **API Key Isolation**: Keys injected at runtime, never baked into image.
3. **Idempotency**: Webhook handlers check registry first.
4. **Zombie Prevention**: Cronjob kills containers >15 min.
5. **PM-Centralized Communication**: Workers NEVER communicate directly. All via PM.
6. **Timeout Enforcement**: No indefinite waits. Escalation after SLA breach.
7. **PM Failover**: Standby PM ready for primary failure.
8. **Worker Health**: PM monitors heartbeats and kills stuck workers.

## License

MIT
