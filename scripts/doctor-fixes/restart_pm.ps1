#!/usr/bin/env pwsh
# Restart PM (Project Manager) worker container
# This is used when PM dies and Doctor has diagnosed the cause.
# The orchestrator will restore the queue state after respawn via PMStateManager.
# Usage: .\restart_pm.ps1
# No parameters needed — PM is always the 'pm' role container.

$ErrorActionPreference = "Stop"
$PM_CONTAINER_PATTERN = "pm"

Write-Host "[restart_pm] Locating PM container..."

$containerId = docker ps -aq -f "name=$PM_CONTAINER_PATTERN" 2>$null
if (-not $containerId) {
    Write-Host "[restart_pm] No running PM container found matching pattern: $PM_CONTAINER_PATTERN"
    # Try harder - look for any container with 'pm' in name
    $allPm = docker ps -a --format '{{.Names}}' | Where-Object { $_ -match 'pm' }
    if ($allPm) {
        Write-Host "[restart_pm] Found PM containers: $($allPm -join ', ')"
        $containerId = docker ps -aq -f "name=$($allPm[0])"
    }
}

if (-not $containerId) {
    Write-Host "[restart_pm] ERROR: PM container not found"
    exit 1
}

Write-Host "[restart_pm] Restarting PM container: $containerId"

docker restart $containerId
if ($LASTEXITCODE -eq 0) {
    Write-Host "[restart_pm] SUCCESS: PM container restarted"
    # Give PM a moment to come up before health checks
    Start-Sleep -Seconds 5
    $status = docker ps -f "name=$PM_CONTAINER_PATTERN" --format '{{.Status}}' 2>$null
    Write-Host "[restart_pm] PM status after restart: $status"
    exit 0
} else {
    Write-Host "[restart_pm] FAILED: Exit code $LASTEXITCODE"
    exit 1
}
