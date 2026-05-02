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
                    │        ├──► Auto resource scaling
                    │        ├──► Deadlock detection & resolution
                    │        ├──► Automatic timeout & escalation
                    │        └──► PM Failover (hot standby)
                    │
               [DOCTOR] ◄── User bug reports
```

---

## 🎯 What Can Turing OS Do?

### 1. Automated Requirements Management
- **PO (Product Owner)** receives requirements from stakeholders
- Priority classification (P0-P3)
- Creates tickets in Plane with automatic workflow

### 2. Automated Software Development
- **Workers** execute tasks using ReAct loop
- Multi-language support: Python, JavaScript, TypeScript, Go, Rust, .NET, Java
- Auto research with Context7 for unknown tech
- Tools: BookStack (docs), Plane (tickets), sandbox terminal

### 3. Human-in-the-Loop (HITL)
- **Revolt** alerts when worker gets blocked
- User can `/unblock` to intervene
- No circular communication - PM is the hub

### 4. Self-Healing & Monitoring
- **Worker Health**: Auto restart dead workers
- **PM Failover**: Standby PM takes over when primary fails
- **Doctor**: Auto diagnose and fix bugs or create GitHub Issue

### 5. Reporting & Retrospectives
- **Retro Reports** automatically aggregated from PM
- Pattern recognition: recurring issues, resource bottlenecks

---

## 🆚 Comparison with HiClaw

| Feature | HiClaw | Turing OS | Improvement |
|---------|--------|-----------|-------------|
| **Architecture** | Flat (Manager-Worker) | Hierarchy (PO→PM→HR→Workers) | ✅ Clearer separation |
| **Priority System** | ❌ None | ✅ P0-P3 with interrupt | ✅ Urgent requests handled |
| **Idempotency** | ❌ None | ✅ Registry-based deduplication | ✅ No duplicates |
| **Resource Scaling** | Manual | ✅ PM-controlled auto-scaling | ✅ Resource efficient |
| **PM Failover** | ❌ None | ✅ Hot standby auto-failover | ✅ Zero downtime |
| **Worker Health** | ❌ None | ✅ Zombie killer auto-restart | ✅ Workers always healthy |
| **Timeout/Escalation** | Manual | ✅ Auto 5min→retry→escalate | ✅ No lost tasks |
| **Bug Resolution** | User self-reports to GitHub | ✅ Doctor agent fix or create Issue | ✅ Better UX |
| **Communication** | Peer-to-peer (Matrix) | ✅ PM-centralized | ✅ No deadlocks |
| **Documentation** | Generic roles | ✅ Domain-specific JDs | ✅ Accurate skills |

**Score**: Turing OS: **45/50** vs HiClaw: **27/50**

---

## 🏗️ Architecture

### Infrastructure Stack

| Service | Port | Purpose |
|---------|------|---------|
| **Plane.so** | 3000/80 | Ticket management & webhooks |
| **BookStack** | 6875 | Documentation & secrets storage |
| **Revolt** | 8080 | Human-in-the-loop alerts |
| **Orchestrator** | 3001 | Event-driven API gateway |
| **Workers** | Ephemeral | Docker containers, auto-remove |

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
5. Worker blocked? → Revolt alert → User /unblock
   ↓
6. Task failed? → Doctor diagnosis → Fix or GitHub Issue
   ↓
7. Complete → Plane ticket updated → Retro report
```

---

## 🚀 Quick Start

### One-Command Installation

**macOS / Linux:**
```bash
curl -sSL https://turing-os.ai/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://turing-os.ai/install.ps1 | iex
```

### Manual Installation

```bash
# 1. Clone repository
git clone https://github.com/louisphamdev/turing-os.git
cd turing-os

# 2. Build worker image
docker build -t turing-worker-base:latest ./base-worker

# 3. Start services
docker compose up -d

# 4. Configure tokens
cd install && .\config.ps1
```

---

## 📋 Directory Structure

```
turing-os/
├── install/                 # Installers (sh + ps1)
├── orchestrator/           # Node.js API gateway
│   └── src/
│       ├── api/webhooks.ts  # Plane & Revolt listeners
│       └── core/           # Docker, Registry, Revolt
├── base-worker/            # Python worker
│   └── src/
│       ├── agent/          # ReAct loop
│       └── tools/          # Plane, BookStack, terminal
├── roles/                  # Agent definitions
│   ├── po.md, pm.md, hr.md
│   ├── software-engineer.md
│   └── languages/          # Tech stack skills
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
.\install\config.ps1 -Service plane     # Plane only
.\install\config.ps1 -Service test      # Test connections

# macOS/Linux
./install/config.sh                     # Configure all
./install/config.sh plane               # Plane only
./install/config.sh test                # Test connections
```

Services status:
```
╔══════════════════════════════════════╗
║     TURING OS SERVICE STATUS          ║
╠══════════════════════════════════════╣
║  Plane:      ✓ Connected             ║
║  Revolt:     ✓ Connected              ║
║  BookStack:  ✓ Connected              ║
║  Context7:   ✓ Connected              ║
╚══════════════════════════════════════╝
```

---

## 📊 Roadmap

| Version | Goals |
|---------|-------|
| v1.0 | Core: Plane + Workers + PM + HR |
| v1.1 | Revolt HITL + Doctor agent |
| v1.2 | PM Failover + Worker Health |
| v2.0 | Auto-scaling + Retro reports |

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md).

**Bug Reports**: [GitHub Issues](https://github.com/louisphamdev/turing-os/issues)
**LLM Feedback**: [LLM Feedback Template](https://github.com/louisphamdev/turing-os/issues/new?template=llm_feedback.yml)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.