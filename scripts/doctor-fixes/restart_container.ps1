#!/usr/bin/env pwsh
# Restart a specific container by name
# Usage: .\restart_container.ps1 -ContainerName "turing-orchestrator"
param(
    [string]$ContainerName = ""
)

$ErrorActionPreference = "Stop"

if (-not $ContainerName) {
    Write-Host "[restart_container] Usage: .\restart_container.ps1 -ContainerName <name>"
    exit 1
}

Write-Host "[restart_container] Restarting container: $ContainerName"

$containerId = docker ps -aq -f "name=$ContainerName" 2>$null
if (-not $containerId) {
    Write-Host "[restart_container] ERROR: No running container found matching: $ContainerName"
    exit 1
}

docker restart $ContainerName
if ($LASTEXITCODE -eq 0) {
    Write-Host "[restart_container] SUCCESS: $ContainerName restarted"
    exit 0
} else {
    Write-Host "[restart_container] FAILED: Exit code $LASTEXITCODE"
    exit 1
}
