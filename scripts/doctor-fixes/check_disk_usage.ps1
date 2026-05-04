#!/usr/bin/env pwsh
# Report disk usage and identify cleanup targets
# Usage: .\check_disk_usage.ps1
param()

$ErrorActionPreference = "Continue"

Write-Host "[check_disk_usage] Docker disk usage"
Write-Host "=" * 50
docker system df 2>$null

Write-Host ""
Write-Host "[check_disk_usage] Top 5 largest Docker volumes"
docker volume ls -q 2>$null | ForEach-Object {
    $size = docker volume inspect $_ --format '{{.UsageData.Size}}' 2>$null
    [PSCustomObject]@{ Name = $_; Size = $size }
} | Sort-Object Size -Descending | Select-Object -First 5 | Format-Table -AutoSize

Write-Host ""
Write-Host "[check_disk_usage] Top 5 largest images"
docker images --format '{{.Repository}}:{{.Tag}} ({{.Size}})' 2>$null |
    ForEach-Object { [PSCustomObject]@{ Image = $_ } } |
    Select-Object -First 5 | Format-Table -AutoSize

Write-Host ""
Write-Host "[check_disk_usage] System disk (/):"
df -h / 2>$null | Select-Object -Last 1 | ForEach-Object {
    Write-Host "  Used: $($_.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[2]) of $($_.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[1])"
}

Write-Host ""
Write-Host "[check_disk_usage] DONE"
exit 0
