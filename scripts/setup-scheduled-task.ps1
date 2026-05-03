# =============================================================================
# Setup Windows Task Scheduler for Docker Maintenance
# Run as Administrator
# =============================================================================

$scriptPath = "$PSScriptRoot\docker-maintenance.ps1"
$taskName = "DockerMaintenance"

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (!$isAdmin) {
    Write-Host "Please run as Administrator to setup scheduled task"
    exit 1
}

# Create logs directory
$logsDir = "$PSScriptRoot\..\logs"
if (!(Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task"
}

# Create action
$action = New-ScheduledTaskAction -Execute "pwsh.exe" -Argument "-ExecutionPolicy Bypass -File `"$scriptPath`""

# Create trigger - run every 6 hours
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 999)

# Create settings
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RunOnlyIfNetworkAvailable:$false

# Create principal - run as current user
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Register task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Docker maintenance - cleanup logs, temp files, unused resources"

Write-Host "Scheduled task '$taskName' created successfully"
Write-Host "  - Runs every 6 hours"
Write-Host "  - Script: $scriptPath"
Write-Host "  - Logs: $logsDir\docker-maintenance.log"
Write-Host ""
Write-Host "To view task: Get-ScheduledTask -TaskName '$taskName'"
Write-Host "To run now: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$taskName'"
