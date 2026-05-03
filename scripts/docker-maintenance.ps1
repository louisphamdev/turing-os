# =============================================================================
# Docker Maintenance Script - Turing OS (PowerShell for Windows)
# Mục đích: Dọn dẹp Docker resource để tránh phình theo thời gian
# Hướng dẫn: Chạy manual hoặc setup Task Scheduler
# =============================================================================

param(
    [switch]$Force,
    [int]$LogRetentionDays = 7,
    [int]$MaxLogSizeMB = 50
)

$ErrorActionPreference = "Continue"

$LogFile = "$PSScriptRoot\..\logs\docker-maintenance.log"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] $Message"
    Write-Host $logMessage
    Add-Content -Path $LogFile -Value $logMessage -ErrorAction SilentlyContinue
}

# Ensure logs directory exists
$logsDir = Split-Path $LogFile -Parent
if (!(Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

Write-Log "=== Docker Maintenance Started ==="

# =============================================================================
# 1. Container Log Cleanup - Windows Docker Desktop stores logs differently
# =============================================================================
function Cleanup-ContainerLogs {
    Write-Log "==> Cleaning container logs..."
    
    $containers = docker ps --format "{{.Names}}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "  Warning: Could not list containers"
        return
    }
    
    foreach ($container in $containers) {
        try {
            $logPath = docker inspect --format '{{.LogPath}}' $container 2>$null
            if ($logPath -and (Test-Path $logPath)) {
                $sizeMB = (Get-Item $logPath).Length / 1MB
                if ($sizeMB -gt $MaxLogSizeMB) {
                    Write-Log "  Truncating log for $container (size: $([math]::Round($sizeMB, 2)) MB)"
                    [System.IO.File]::WriteAllText($logPath, "")
                }
            }
        } catch {
            # Silently continue for individual container errors
        }
    }
    
    Write-Log "  Container logs cleaned"
}

# =============================================================================
# 2. Clean temp files in containers
# =============================================================================
function Cleanup-TempFiles {
    Write-Log "==> Cleaning temp files in containers..."
    
    $containers = docker ps -q 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Log "  Warning: Could not list containers"
        return
    }
    
    foreach ($container in $containers) {
        $name = docker inspect --format '{{.Name}}' $container 2>$null
        $name = $name -replace '^/', ''
        
        try {
            # Clean /tmp
            docker exec $container powershell -Command "Remove-Item -Path 'C:\tmp\*' -Recurse -Force -ErrorAction SilentlyContinue" 2>$null
            # Clean Windows temp
            docker exec $container powershell -Command "Remove-Item -Path 'C:\Windows\Temp\*' -Recurse -Force -ErrorAction SilentlyContinue" 2>$null
            Write-Log "  Cleaned temp for: $name"
        } catch {
            # Silently continue
        }
    }
    
    Write-Log "  Temp files cleaned"
}

# =============================================================================
# 3. Dọn unused images, volumes, networks
# =============================================================================
function Cleanup-UnusedResources {
    Write-Log "==> Cleaning unused Docker resources..."
    
    # Remove stopped containers
    $stopped = docker ps -f status=exited -q 2>$null | Measure-Object
    if ($stopped.Count -gt 0) {
        docker container prune -f 2>$null | Out-Null
        Write-Log "  Removed stopped containers"
    }
    
    # Remove dangling images
    $dangling = docker images -f dangling=true -q 2>$null | Measure-Object
    if ($dangling.Count -gt 0) {
        docker image prune -f 2>$null | Out-Null
        Write-Log "  Removed dangling images"
    }
    
    # Remove unused volumes
    $unused = docker volume ls -f dangling=true -q 2>$null | Measure-Object
    if ($unused.Count -gt 0) {
        docker volume prune -f 2>$null | Out-Null
        Write-Log "  Removed unused volumes"
    }
    
    # Remove unused networks
    docker network prune -f 2>$null | Out-Null
    
    Write-Log "  Unused resources cleaned"
}

# =============================================================================
# 4. System cleanup
# =============================================================================
function Cleanup-System {
    Write-Log "==> System cleanup..."
    
    # Clear Windows temp
    Remove-Item -Path "$env:TEMP\*" -Recurse -Force -ErrorAction SilentlyContinue 2>$null
    
    # Clear Windows prefetch (needs admin)
    Remove-Item -Path "C:\Windows\Prefetch\*" -Recurse -Force -ErrorAction SilentlyContinue 2>$null
    
    Write-Log "  System cleanup done"
}

# =============================================================================
# 5. Health Report
# =============================================================================
function Get-HealthReport {
    Write-Log "==> Docker Disk Usage Report"
    Write-Host ""
    
    docker system df
    
    Write-Host ""
    Write-Log "Top volumes by size:"
    docker volume ls --format "{{.Name}}: {{.Size}}" | Select-Object -First 5
    
    Write-Host ""
}

# Execute
Cleanup-ContainerLogs
Cleanup-TempFiles  
Cleanup-UnusedResources
Cleanup-System
Get-HealthReport

Write-Log "=== Docker Maintenance Completed ==="
