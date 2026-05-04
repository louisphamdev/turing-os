#!/usr/bin/env pwsh
# Clean up Docker: remove dangling images, stopped containers, unused networks
# Usage: .\cleanup_docker.ps1
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Continue"

Write-Host "[cleanup_docker] Starting Docker cleanup..."

# Report before state
$beforeImg = (docker images -q -f dangling=true 2>$null | Measure-Object).Count
$beforeVol = (docker volume ls -qf dangling=true 2>$null | Measure-Object).Count
$beforeNet = (docker network ls -q 2>$null | Measure-Object).Count
Write-Host "[cleanup_docker] Before: $beforeImg dangling images, $beforeVol dangling volumes"

if (-not $DryRun) {
    # Remove stopped containers
    $containers = docker ps -aq -f status=exited 2>$null
    if ($containers) {
        docker rm $containers 2>$null | Out-Null
        Write-Host "[cleanup_docker] Removed $($containers.Count) stopped containers"
    }

    # Remove dangling images
    $images = docker images -q -f dangling=true 2>$null
    if ($images) {
        docker rmi $images 2>$null | Out-Null
        Write-Host "[cleanup_docker] Removed $beforeImg dangling images"
    }

    # Remove dangling volumes
    $volumes = docker volume ls -qf dangling=true 2>$null
    if ($volumes) {
        docker volume rm $volumes 2>$null | Out-Null
        Write-Host "[cleanup_docker] Removed $beforeVol dangling volumes"
    }

    # Remove unused networks (not default or ones used by active containers)
    docker network prune -f 2>$null | Out-Null
    Write-Host "[cleanup_docker] Pruned unused networks"
}

# Report disk usage after
$usage = docker system df --format '{{.Type}} {{.TotalCount}} {{.Size}}' 2>$null
Write-Host "[cleanup_docker] Final state: $usage"
Write-Host "[cleanup_docker] DONE"
exit 0
