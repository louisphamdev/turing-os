param(
    [string]$RepoRoot = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'

function Log-Info { param([string]$M) Write-Host "[OK] $M" -ForegroundColor Green }
function Log-Warn { param([string]$M) Write-Host "[!!] $M" -ForegroundColor Yellow }
function Log-Fail { param([string]$M) Write-Host "[FAIL] $M" -ForegroundColor Red }

function Get-EnvMap {
    param([string]$EnvFile)
    $envMap = [ordered]@{}
    if (-not (Test-Path $EnvFile)) { return $envMap }
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $key, $value = $_ -split '=', 2
        $envMap[$key.Trim()] = $value.Trim()
    }
    return $envMap
}

function Upsert-EnvValue {
    param([string]$EnvFile, [string]$Key, [string]$Value)
    $escapedKey = [regex]::Escape($Key)
    $lines = if (Test-Path $EnvFile) { Get-Content $EnvFile } else { @() }
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^${escapedKey}=") {
            $lines[$index] = "${Key}=${Value}"
            Set-Content -Path $EnvFile -Value $lines
            return
        }
    }
    $lines += "${Key}=${Value}"
    Set-Content -Path $EnvFile -Value $lines
}

function Wait-ForUrl {
    param([string]$Url, [string]$Name, [int]$MaxWaitSeconds = 60)
    Write-Host -NoNewline "Waiting for $Name"
    for ($attempt = 0; $attempt -lt $MaxWaitSeconds; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($response.StatusCode -in 200, 301, 302, 401) {
                Write-Host ' OK'
                return $true
            }
        } catch { }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 1
    }
    Write-Host ' TIMEOUT'
    return $false
}

$envFile = Join-Path $RepoRoot '.env'
$envMap = Get-EnvMap -EnvFile $envFile

$bookstackUrl = if ($envMap.BOOKSTACK_URL) { $envMap.BOOKSTACK_URL } else { 'http://localhost:6875' }
$adminUser = if ($envMap.ADMIN_USER) { $envMap.ADMIN_USER } else { 'admin' }
$adminPass = if ($envMap.ADMIN_PASSWORD) { $envMap.ADMIN_PASSWORD } else { 'Admin123!' }
$adminEmail = "admin@$adminUser.local"

Log-Info '--- Turing OS BookStack Auto Setup ---'
Log-Info "BookStack URL: $bookstackUrl"

# Wait for BookStack to be ready
[void](Wait-ForUrl -Url "$bookstackUrl/api" -Name 'BookStack API' -MaxWaitSeconds 120)

# Get API token via POST /api/tokens
# BookStack API docs: https://www.bookstackapp.com/docs/api/using-the-api/
Log-Info 'Getting BookStack API token...'
$bookstackToken = ''

try {
    $tokenResponse = Invoke-RestMethod -Uri "$bookstackUrl/api/tokens" -Method Post -ContentType 'application/json' -Body (@{
        email    = $adminEmail
        password = $adminPass
    } | ConvertTo-Json) -TimeoutSec 15

    if ($null -ne $tokenResponse -and $tokenResponse.token) {
        $bookstackToken = [string]$tokenResponse.token
        Log-Info "OK: BookStack token obtained"
        Upsert-EnvValue -EnvFile $envFile -Key 'BOOKSTACK_TOKEN' -Value $bookstackToken
    } else {
        Log-Warn "No token in response: $($tokenResponse | ConvertTo-Json -Depth 3)"
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $responseBody = ''
    try {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        $reader.Close()
    } catch { }
    Log-Fail "BookStack token failed (HTTP $statusCode): $responseBody"
}

Log-Info '--- DONE ---'
if ($bookstackToken) {
    Log-Info "BookStack: OK"
    Write-Host ""
    Write-Host "  BOOKSTACK_TOKEN saved to .env" -ForegroundColor Cyan
} else {
    Log-Warn "BookStack: FAILED (may need to create user manually first boot)"
}
