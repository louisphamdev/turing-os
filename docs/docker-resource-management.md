# Docker Resource Management - Turing OS

## Mục đích
Ngăn Docker containers phình ra theo thời gian bằng cách:
- **Internal cron** trong mỗi container (worker, orchestrator)
- Giới hạn log size
- Clear temp files định kỳ  
- Xóa unused resources
- Tối ưu memory với limits

## Cơ chế chính: Internal Cron (trong container)

Mỗi worker/container tự chạy cron daemon bên trong, không cần external scheduler.

### Files cho Internal Cron

| File | Container | Mục đích |
|------|-----------|----------|
| `base-worker/crontab` | worker | Cleanup schedule |
| `base-worker/docker-entrypoint.sh` | worker | Start cron + main process |
| `base-worker/src/tools/cleanup_runner.py` | worker | Python cleanup module |
| `orchestrator/crontab` | orchestrator | Cleanup schedule |

### Cleanup tasks trong cron

```
*/30 * * * *  →  Xóa temp files
0 3 * * *      →  Truncate logs > 10MB
*/15 * * * *   →  Health check/report
0 * * * *      →  Sync/drop caches (Linux)
```

## Cách hoạt động

```
┌─────────────────────────────────────────┐
│  Container                               │
│  ┌─────────────────────────────────┐    │
│  │  crond (cron daemon)            │    │
│  │  - Reads /etc/crontab           │    │
│  │  - Runs cleanup jobs            │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  Main Process (Python/Node)     │    │
│  │  - index.py / src/index.ts      │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

## Sử dụng

### 1. Build và chạy với resource limits

```bash
# Build base-worker
docker build -f base-worker/Dockerfile -t turing-worker:latest ./base-worker

# Build orchestrator  
docker build -f orchestrator/Dockerfile -t turing-orchestrator:latest ./orchestrator

# Chạy với optimized config
docker compose -f docker-compose.yml -f docker-compose.optimized.yml up -d
```

### 2. Test cleanup trong container

```bash
# Run cleanup once
docker exec turing-worker python /workspace/src/tools/cleanup_runner.py --once

# Health report
docker exec turing-worker python /workspace/src/tools/cleanup_runner.py --report
```

### 3. Kiểm tra cron jobs

```bash
# List cron jobs
docker exec turing-worker crontab -l

# View cron logs
docker exec turing-worker cat /var/log/cron.log
```

## Docker Compose Overlay

`docker-compose.optimized.yml` thêm:

```yaml
x-logging: &default-logging
  logging:
    driver: "json-file"
    options:
      max-size: "10m"
      max-file: "3"

x-limits: &default-limits
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: '0.5'
```

## Cleanup Tasks Schedule

| Task | Frequency | What it does |
|------|-----------|--------------|
| Temp cleanup | Every 30 min | `rm -rf /tmp/*`, `/workspace/tmp/*`, cache |
| Log truncate | Daily 3am | Truncate logs > 10MB |
| Health report | Every 15 min | Log container health metrics |
| Cache drop | Hourly | `sync; echo 3 > /proc/sys/vm/drop_caches` |

## Memory Limits per Service

| Service | Limit | Reservation |
|---------|-------|-------------|
| PostgreSQL | 1GB | 512MB |
| Taiga back | 1GB | 512MB |
| Taiga async | 768MB | - |
| Redis | 256MB | - |
| Worker | 512MB | 256MB |
| Orchestrator | 1GB | 512MB |

## Cleanup Files

| File | Purpose |
|------|---------|
| `scripts/docker-maintenance.ps1` | External cleanup (Windows host) |
| `scripts/docker-maintenance.sh` | External cleanup (Linux host) |
| `scripts/setup-scheduled-task.ps1` | Windows Task Scheduler setup |
| `docker-compose.optimized.yml` | Resource limits overlay |
| `base-worker/src/tools/cleanup_runner.py` | Python cleanup module |

## Disk Space Savings

Typical cleanup per container per run:
- Temp files: 10-50MB
- Log truncation: 0-500MB (if logs large)
- Cache cleanup: 5-20MB
