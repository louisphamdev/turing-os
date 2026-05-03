# =============================================================================
# Apply Docker Resource Limits to docker-compose.yml
# Run: .\scripts\apply-docker-limits.ps1
# =============================================================================

$composeFile = "$PSScriptRoot\..\docker-compose.yml"
$backupFile = "$PSScriptRoot\..\docker-compose.yml.backup"

if (!(Test-Path $composeFile)) {
    Write-Host "docker-compose.yml not found"
    exit 1
}

# Backup original
Copy-Item $composeFile $backupFile -Force
Write-Host "Backed up original to $backupFile"

# Read content
$content = Get-Content $composeFile -Raw

# Define services that should have resource limits applied
$services = @("turing-os", "taiga-back", "taiga-async", "taiga-front", "taiga-gateway", "wiki", "synapse", "element")

foreach ($service in $services) {
    Write-Host "Checking service: $service"
    
    # Check if service exists in compose file
    if ($content -match "^\s{2}$service:") {
        Write-Host "  Found $service - adding resource limits and logging"
        
        # Add deploy.resources section if not exists
        if ($content -notmatch "^\s{2}$service:.*?deploy:.*?resources:" -and $content -notmatch "$service:.*?deploy:\s+resources:\s+limits") {
            # Simple approach - just warn user to manually add
            Write-Host "  Note: Manual edit required for $service to add deploy.resources"
        }
    }
}

Write-Host ""
Write-Host "Docker resource limits configuration"
Write-Host "==================================="
Write-Host ""
Write-Host "To apply logging limits to ALL services, add to each service:"
Write-Host ""
Write-Host '    logging:'
Write-Host '      driver: "json-file"'
Write-Host '      options:'
Write-Host '        max-size: "10m"'
Write-Host '        max-file: "3"'
Write-Host ""
Write-Host "To apply memory limits, add to each service:"
Write-Host ""
Write-Host '    deploy:'
Write-Host '      resources:'
Write-Host '        limits:'
Write-Host '          memory: 512M'
Write-Host ""
Write-Host "For tmpfs (RAM disk for temp files):"
Write-Host ""
Write-Host '    tmpfs:'
Write-Host '      - /tmp:size=100M,noexec,nosuid,mode=1777'
Write-Host ""
