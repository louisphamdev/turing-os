#!/usr/bin/env pwsh
# Parse PM (Project Manager) container logs for error patterns.
# Used by Doctor to diagnose why PM died.
# Usage: .\check_pm_logs.ps1 [-ContainerName "pm-worker"] [-Lines 100]
param(
    [string]$ContainerName = "",
    [int]$Lines = 100
)

$ErrorActionPreference = "Continue"

if (-not $ContainerName) {
    # Auto-detect PM container
    $containers = docker ps -a --format '{{.Names}}' | Where-Object { $_ -match 'pm' }
    if ($containers) {
        $ContainerName = $containers[0]
        Write-Host "[check_pm_logs] Auto-detected PM container: $ContainerName"
    }
}

if (-not $ContainerName) {
    Write-Host "[check_pm_logs] ERROR: No PM container specified and could not auto-detect"
    exit 1
}

$running = docker ps --format '{{.Names}}' | Where-Object { $_ -eq $ContainerName }
if ($running) {
    Write-Host "[check_pm_logs] Fetching $Lines log lines from running container: $ContainerName"
    $logs = docker logs --tail $Lines --timestamps $ContainerName 2>&1
} else {
    Write-Host "[check_pm_logs] Fetching $Lines log lines from stopped container: $ContainerName"
    $logs = docker logs --tail $Lines --timestamps $ContainerName 2>&1
}

$errorPattern = @(
    "error",
    "fail",
    "crash",
    "exception",
    "fatal",
    "panic",
    "oom",
    "killed",
    "SIGSEGV",
    "SIGABRT",
    "exit code",
    "connection refused",
    "timeout",
    "memory",
    "disk",
    "space"
)

$errorLines = @()
$warningLines = @()
$allLines = $logs -split "`n"

foreach ($line in $allLines) {
    $lineLower = $line.ToLower()
    $isError = $false
    $isWarning = $false

    if ($lineLower -match "error" -or $lineLower -match "exception" -or $lineLower -match "fatal" -or $lineLower -match "panic" -or $lineLower -match "crash") {
        $isError = $true
    }
    if ($lineLower -match "warn" -and $lineLower -notmatch "error") {
        $isWarning = $true
    }
    if ($lineLower -match "exit code 1" -or $lineLower -match "exit code 137" -or $lineLower -match "oomkilled") {
        $isError = $true
    }

    if ($isError) {
        $errorLines += $line
    } elseif ($isWarning) {
        $warningLines += $line
    }
}

Write-Host ""
Write-Host "=== PM Log Analysis for: $ContainerName ===" -ForegroundColor Cyan
Write-Host "Total lines fetched: $($allLines.Count)"
Write-Host "Error lines: $($errorLines.Count)"
Write-Host "Warning lines: $($warningLines.Count)"
Write-Host ""

if ($errorLines.Count -gt 0) {
    Write-Host "=== ERRORS ===" -ForegroundColor Red
    foreach ($e in $errorLines) {
        Write-Host $e
    }
    Write-Host ""
}

if ($warningLines.Count -gt 0) {
    Write-Host "=== WARNINGS ===" -ForegroundColor Yellow
    foreach ($w in $warningLines) {
        Write-Host $w
    }
    Write-Host ""
}

if ($errorLines.Count -eq 0 -and $warningLines.Count -eq 0) {
    Write-Host "[check_pm_logs] No errors or warnings found in PM logs" -ForegroundColor Green
}

# Return exit code based on findings
if ($errorLines.Count -gt 0) {
    exit 1
} elseif ($warningLines.Count -gt 0) {
    exit 0
} else {
    exit 0
}
