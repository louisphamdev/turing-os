param(
    [string]$RepoRoot = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'

function Log-Info { param([string]$Message) Write-Host $Message }
function Log-Warn { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Log-Fail { param([string]$Message) Write-Host $Message -ForegroundColor Red }

function Get-EnvMap {
    param([string]$EnvFile)

    $envMap = [ordered]@{}
    if (-not (Test-Path $EnvFile)) {
        return $envMap
    }

    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') {
            return
        }

        $key, $value = $_ -split '=', 2
        $envMap[$key.Trim()] = $value.Trim()
    }

    return $envMap
}

function Upsert-EnvValue {
    param(
        [string]$EnvFile,
        [string]$Key,
        [string]$Value
    )

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
    param(
        [string]$Url,
        [string]$Name,
        [int]$MaxWaitSeconds = 30
    )

    Write-Host -NoNewline "Waiting for $Name"
    for ($attempt = 0; $attempt -lt $MaxWaitSeconds; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($response.StatusCode -in 200, 301, 302) {
                Write-Host ' OK'
                return $true
            }
        } catch {
        }

        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 1
    }

    Write-Host ' TIMEOUT'
    return $false
}

function Get-HmacSha1Hex {
    param(
        [string]$Secret,
        [string]$Payload
    )

    $encoding = [System.Text.Encoding]::UTF8
    $hmac = [System.Security.Cryptography.HMACSHA1]::new($encoding.GetBytes($Secret))
    try {
        $hash = $hmac.ComputeHash($encoding.GetBytes($Payload))
    } finally {
        $hmac.Dispose()
    }

    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Register-SynapseUser {
    param(
        [string]$BaseUrl,
        [string]$Username,
        [string]$Password,
        [bool]$IsAdmin,
        [string]$RegistrationSecret
    )

    try {
        $nonceResponse = Invoke-RestMethod -Uri "$BaseUrl/_synapse/admin/v1/register" -Method Get -TimeoutSec 10
    } catch {
        return ''
    }

    if (-not $nonceResponse.nonce) {
        return ''
    }

    $adminMode = if ($IsAdmin) { 'admin' } else { 'notadmin' }
    $payload = "$($nonceResponse.nonce)`0$Username`0$Password`0$adminMode"
    $mac = Get-HmacSha1Hex -Secret $RegistrationSecret -Payload $payload

    $body = @{
        nonce = $nonceResponse.nonce
        username = $Username
        password = $Password
        admin = $IsAdmin
        displayname = $Username
        mac = $mac
    } | ConvertTo-Json

    try {
        $registerResponse = Invoke-RestMethod -Uri "$BaseUrl/_synapse/admin/v1/register" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10
        if ($null -ne $registerResponse.access_token) {
            return [string]$registerResponse.access_token
        }
        return ''
    } catch {
        return ''
    }
}

function Login-SynapseUser {
    param(
        [string]$BaseUrl,
        [string]$Username,
        [string]$Password
    )

    $body = @{
        type = 'm.login.password'
        identifier = @{ type = 'm.id.user'; user = $Username }
        password = $Password
    } | ConvertTo-Json -Depth 4

    try {
        $loginResponse = Invoke-RestMethod -Uri "$BaseUrl/_matrix/client/r0/login" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10
        if ($null -ne $loginResponse.access_token) {
            return [string]$loginResponse.access_token
        }
        return ''
    } catch {
        return ''
    }
}

$envFile = Join-Path $RepoRoot '.env'
$envMap = Get-EnvMap -EnvFile $envFile

$adminUser = if ($envMap.ADMIN_USER) { $envMap.ADMIN_USER } else { 'admin' }
$adminPass = if ($envMap.ADMIN_PASSWORD) { $envMap.ADMIN_PASSWORD } else { 'Admin123!' }
$synapseApiUrl = if ($envMap.SYNAPSE_API_URL) { $envMap.SYNAPSE_API_URL } else { 'http://localhost:8008' }
$registrationSecret = if ($envMap.SYNAPSE_REGISTRATION_SECRET) { $envMap.SYNAPSE_REGISTRATION_SECRET } else { 'f643143e19d68d088741f6ca465894bb6964ca284b5d2c58a8dcc3348750f4e4' }
$matrixBotUser = if ($envMap.MATRIX_BOT_USER) { $envMap.MATRIX_BOT_USER } else { 'turing-bot' }
$matrixBotPass = if ($envMap.MATRIX_BOT_PASS) { $envMap.MATRIX_BOT_PASS } else { 'BotPass123!' }
$matrixAdminUserId = '@{0}:localhost' -f $adminUser
$matrixBotUserId = '@{0}:localhost' -f $matrixBotUser

Log-Info '--- Turing OS Auto User Setup ---'
Log-Info '--- MATRIX ---'
[void](Wait-ForUrl -Url "$synapseApiUrl/_matrix/client/versions" -Name 'Synapse')

Log-Info "Matrix admin: $matrixAdminUserId"
$matrixAdminToken = Register-SynapseUser -BaseUrl $synapseApiUrl -Username $adminUser -Password $adminPass -IsAdmin:$true -RegistrationSecret $registrationSecret
if (-not $matrixAdminToken) {
    $matrixAdminToken = Login-SynapseUser -BaseUrl $synapseApiUrl -Username $adminUser -Password $adminPass
}

if ($matrixAdminToken) {
    Log-Info 'OK: Matrix admin token obtained'
} else {
    Log-Warn 'WARN: Matrix admin login failed'
}

Log-Info "Matrix bot: $matrixBotUserId"
$matrixBotToken = Register-SynapseUser -BaseUrl $synapseApiUrl -Username $matrixBotUser -Password $matrixBotPass -IsAdmin:$false -RegistrationSecret $registrationSecret
if (-not $matrixBotToken) {
    $matrixBotToken = Login-SynapseUser -BaseUrl $synapseApiUrl -Username $matrixBotUser -Password $matrixBotPass
}

if ($matrixBotToken) {
    Upsert-EnvValue -EnvFile $envFile -Key 'MATRIX_BOT_TOKEN' -Value $matrixBotToken
    Log-Info 'OK: Matrix bot token obtained'
} else {
    Log-Warn 'WARN: Matrix bot login failed'
}

Upsert-EnvValue -EnvFile $envFile -Key 'MATRIX_ADMIN_USER_ID' -Value $matrixAdminUserId

Log-Info '--- PLANE ---'
$planeBootstrap = Join-Path $RepoRoot 'scripts/bootstrap-plane.ps1'
if (Test-Path $planeBootstrap) {
    try {
        & powershell -ExecutionPolicy Bypass -File $planeBootstrap -RepoRoot $RepoRoot
    } catch {
        Log-Warn "WARN: Plane bootstrap failed: $($_.Exception.Message)"
    }
} else {
    Log-Warn "SKIP: $planeBootstrap not found"
}

Log-Info '--- DONE ---'
Log-Info "Matrix: $matrixAdminUserId"