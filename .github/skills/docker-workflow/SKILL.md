---
name: docker-workflow
description: '**SKILL** — Docker and container management for Project Turing OS. Use when: building worker containers, checking container health, troubleshooting Docker issues, scaling workers, viewing logs, or managing the local Docker socket. Triggers: "docker build", "docker compose", "container restart", "worker scaling", "docker logs", "docker inspect"'
user-invocable: true
---

# Docker Workflow Skill

## When to Use

This skill is for Docker and container management tasks in Project Turing OS:
- Building and deploying worker containers
- Checking container health and status
- Troubleshooting Docker-related issues
- Scaling worker containers up/down
- Viewing logs and inspecting containers
- Managing docker-compose configurations

## Key Commands

### Build & Run

```powershell
# Build orchestrator
Set-Location orchestrator; npm run build

# Validate docker-compose
docker compose -f docker-compose.yml config

# Start full stack
docker compose up -d

# Start specific service
docker compose up -d orchestrator
```

### Container Management

```powershell
# List running containers
docker ps

# View worker logs
docker logs <container_name>

# Inspect container
docker inspect <container_name>

# Restart specific container
docker restart <container_name>

# Stop and remove workers
docker compose -f docker-compose.yml down --remove-orphans
```

### Worker Scaling

```powershell
# Scale workers (edit docker-compose.override.yml)
# Or use orchestrator API: POST /api/workers/scale

# Check running workers
docker ps | Select-String "turing-worker"
```

### Health Monitoring

```powershell
# Check container health
docker inspect --format='{{.State.Health}}' <container>

# View orchestrator health endpoint
Invoke-RestMethod http://localhost:3001/health

# Check worker health
Invoke-RestMethod http://localhost:3001/api/workers
```

## Dockerfile Locations

| Service | Dockerfile Path |
|---------|----------------|
| Orchestrator | `orchestrator/Dockerfile` |
| Base Worker | `base-worker/Dockerfile` |

## Environment Variables

Key environment files:
- `taiga.env` — Taiga configuration
- `.env` — Local overrides

## Troubleshooting

### Container won't start
```powershell
# Check logs
docker logs <container>

# Check docker socket permissions
Get-Acl \\.\pipe\docker_engine

# Validate compose file
docker compose -f docker-compose.yml config
```

### Worker spawn failures
```powershell
# Check available resources
docker system df

# Check docker daemon
docker version

# Verify socket connection
Test-Path \\.\pipe\docker_engine
```

### Network issues
```powershell
# Check container networking
docker network ls
docker network inspect turing-os_default

# Check port bindings
Get-NetTCPConnection | Where-Object { $_.LocalPort -in 3001,8008,8080,9000,6875 }
```

## Related Files

- `docker-compose.yml` — Main stack definition
- `docker-compose.override.yml` — Local overrides
- `resource-scaling.md` — Scaling modes and configuration
- `worker-health.md` — Health monitoring protocol