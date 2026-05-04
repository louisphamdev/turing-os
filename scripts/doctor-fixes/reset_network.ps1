#!/usr/bin/env pwsh
# Reset Docker networking (remove unused networks + recreate if needed)
# Usage: .\reset_network.ps1
param(
    [string]$NetworkName = ""
)

$ErrorActionPreference = "Continue"

Write-Host "[reset_network] Docker networking reset"

# Remove unused networks
$unused = docker network ls -q -f dangling=true 2>$null
if ($unused) {
    docker network prune -f 2>$null | Out-Null
    Write-Host "[reset_network] Pruned $(@($unused).Count) unused networks"
} else {
    Write-Host "[reset_network] No unused networks to prune"
}

# List active networks
Write-Host ""
Write-Host "[reset_network] Active networks:"
docker network ls 2>$null | Select-Object -Skip 1 | ForEach-Object {
    Write-Host "  $_"
}

if ($NetworkName) {
    Write-Host ""
    Write-Host "[reset_network] Inspecting network: $NetworkName"
    docker network inspect $NetworkName 2>$null | ConvertTo-Json -Depth 2 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[reset_network] Network '$NetworkName' is healthy"
    } else {
        Write-Host "[reset_network] WARNING: Network '$NetworkName' not found or unhealthy"
    }
}

Write-Host ""
Write-Host "[reset_network] DONE"
exit 0
