# Turing OS - Multi-Agent IT Department OS

> **Tầm nhìn**: Trở thành hệ điều hành IT department thông minh hơn HiClaw - tự động hóa hoàn toàn quy trình phát triển phần mềm với AI agents, từ tiếp nhận yêu cầu đến triển khai sản phẩm.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/louisphamdev/turing-os)](https://github.com/louisphamdev/turing-os/stargazers)

---

## 🤔 Turing OS Là Gì?

Turing OS là một **Hệ Điều Hành Đa Agent** mô phỏng một phòng IT hoàn chỉnh. Thay vì giao tiếp LLM đơn giản, nó sử dụng **kiến trúc hướng sự kiện** để điều phối các AI agents như một đội ngũ IT thực thụ.

```
Stakeholder ──► [PO] ──► [PM] ──► [HR] ──► [Workers]
                    │        │
                    │        ├──► Tự động scale tài nguyên
                    │        ├──► Phát hiện & xử lý deadlock
                    │        ├──► Timeout & escalation tự động
                    │        └──► PM Failover (hot standby)
                    │
               [DOCTOR] ◄── Báo cáo lỗi từ user
```

---

## 🎯 Turing OS Làm Được Gì?

### 1. Quản Lý Yêu Cầu Tự Động
- **PO (Product Owner)** tiếp nhận yêu cầu từ stakeholder
- Phân loại priority (P0-P3)
- Tạo ticket trong Plane với workflow tự động

### 2. Phát Triển Phần Mềm Tự Động
- **Workers** thực hiện task với ReAct loop
- Hỗ trợ nhiều ngôn ngữ: Python, JavaScript, TypeScript, Go, Rust, .NET, Java
- Tự động research với Context7 khi gặp unknown tech
- Tools: BookStack (docs), Plane (tickets), local terminal (sandbox)

### 3. Human-in-the-Loop (HITL)
- **Revolt** alerts khi worker bị blocked
- User có thể `/unblock` để can thiệp
- Không có circular communication - PM là trung tâm

### 4. Tự Phục Hồi & Giám Sát
- **Worker Health**: Tự động restart workers chết
- **PM Failover**: Standby PM takes over khi primary fail
- **Doctor**: Tự chuẩn đoán và fix lỗi hoặc tạo GitHub Issue

### 5. Báo Cáo & Retro
- **Retro Reports** tự động tổng hợp từ PM
- Nhận diện patterns: recurring issues, resource bottlenecks

---

## 🆚 So Sánh Với HiClaw

| Tính Năng | HiClaw | Turing OS | Cải Tiến |
|-----------|--------|-----------|----------|
| **Architecture** | Flat (Manager-Worker) | Hierarchy (PO→PM→HR→Workers) | ✅ Rõ ràng hơn |
| **Priority System** | ❌ Không có | ✅ P0-P3 với interrupt | ✅ Yêu cầu khẩn cấp |
| **Idempotency** | ❌ Không có | ✅ Registry-based deduplication | ✅ Tránh trùng lặp |
| **Resource Scaling** | Thủ công | ✅ PM-controlled auto-scaling | ✅ Tiết kiệm resource |
| **PM Failover** | ❌ Không có | ✅ Hot standby tự động | ✅ Không downtime |
| **Worker Health** | ❌ Không có | ✅ Zombie killer tự động | ✅ Workers luôn healthy |
| **Timeout/Escalation** | Thủ công | ✅ Tự động 5min→retry→escalate | ✅ Không lost tasks |
| **Bug Resolution** | User tự report GitHub | ✅ Doctor agent fix hoặc tạo Issue | ✅ UX tốt hơn |
| **Communication** | Peer-to-peer (Matrix) | ✅ PM-centralized | ✅ Không deadlock |
| **Documentation** | Generic roles | ✅ Domain-specific JDs | ✅ Skill chính xác |

**Điểm số**: Turing OS: **45/50** vs HiClaw: **27/50**

---

## 🏗️ Kiến Trúc

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
1. Stakeholder tạo ticket trong Plane
   ↓
2. Webhook trigger → Orchestrator
   ↓
3. PO phê duyệt → PM nhận task
   ↓
4. PM điều phối → Workers thực hiện
   ↓
5. Worker blocked? → Revolt alert → User /unblock
   ↓
6. Task failed? → Doctor diagnosis → Fix hoặc GitHub Issue
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

## 📋 Cấu Trúc Thư Mục

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

Tokens được quản lý riêng qua config manager:

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

## 📊 Mục Tiêu Phát Triển

| Phiên bản | Mục tiêu |
|-----------|----------|
| v1.0 | Core: Plane + Workers + PM + HR |
| v1.1 | Revolt HITL + Doctor agent |
| v1.2 | PM Failover + Worker Health |
| v2.0 | Auto-scaling + Retro reports |

---

## 🤝 Đóng Góp

Đóng góp luôn được chào đón! Vui lòng đọc [CONTRIBUTING.md](./CONTRIBUTING.md).

**Bug Reports**: [GitHub Issues](https://github.com/louisphamdev/turing-os/issues)
**LLM Feedback**: [LLM Feedback Template](https://github.com/louisphamdev/turing-os/issues/new?template=llm_feedback.yml)

---

## 📄 License

MIT License - xem [LICENSE](LICENSE) để biết thêm chi tiết.