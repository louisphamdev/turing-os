#!/usr/bin/env pwsh
# Restart a Docker Compose service
# Usage: .\restart_service.ps1 -ServiceName "taiga"
param(
    [string]$ServiceName = ""
)

$ErrorActionPreference = "Stop"
$COMPOSE_FILE = Join-Path $PSScriptRoot "..\..\docker-compose.yml"

if (-not $ServiceName) {
    Write-Host "[restart_service] Usage: .\restart_service.ps1 -ServiceName <name>"
    exit 1
}

Write-Host "[restart_service] Restarting service: $ServiceName"

# Check if service exists
$services = docker compose -f $COMPOSE_FILE ps --services 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[restart_service] ERROR: Cannot list services"
    exit 1
}

if ($ServiceName -notin $services) {
    Write-Host "[restart_service] ERROR: Service '$ServiceName' not found in docker-compose.yml"
    Write-Host "[restart_service] Available: $($services -join ', ')"
    exit 1
}

# Restart the service
docker compose -f $COMPOSE_FILE restart $ServiceName
if ($LASTEXITCODE -eq 0) {
    Write-Host "[restart_service] SUCCESS: $ServiceName restarted"
    exit 0
} else {
    Write-Host "[restart_service] FAILED: Exit code $LASTEXITCODE"
    exit 1
}
