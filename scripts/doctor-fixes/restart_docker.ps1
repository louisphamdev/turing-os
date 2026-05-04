#!/usr/bin/env pwsh
# Restart Docker daemon — USE WITH CAUTION
# Usage: .\restart_docker.ps1
param()

$ErrorActionPreference = "Stop"

Write-Host "[restart_docker] Restarting Docker daemon..."

if ($IsWindows -or ([Environment]::OSVersion.Platform -eq 'Win32NT')) {
    # Windows: use Docker Desktop management
    $service = Get-Service -Name "com.docker.service" -ErrorAction SilentlyContinue
    if ($service) {
        Restart-Service -Name "com.docker.service" -Force
        Start-Sleep -Seconds 5
        Write-Host "[restart_docker] Docker Desktop service restarted"
    } else {
        Write-Host "[restart_docker] WARNING: Docker Desktop service not found. Is Docker Desktop running?"
        Write-Host "[restart_docker] Try restarting Docker Desktop manually."
    }
} else {
    # Linux
    sudo systemctl restart docker
    Start-Sleep -Seconds 3
    Write-Host "[restart_docker] Docker daemon restarted"
}

# Verify
docker info 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[restart_docker] SUCCESS: Docker is responsive"
    exit 0
} else {
    Write-Host "[restart_docker] FAILED: Docker not responding"
    exit 1
}
