# Turing OS Configuration Manager
# Usage: .\config.ps1 [-Service all|taiga|matrix|wiki|context7|github]

param(
    [ValidateSet("all", "taiga", "matrix", "wiki", "context7", "github", "test")]
    [string]$Service = "all"
)

$VERSION = "2.0.0"
# Resolve to project root .env (supports both install/ and project root execution)
$parentEnv = Join-Path $PSScriptRoot "..\.env"
$localEnv = Join-Path $PSScriptRoot ".env"
$homeEnv = Join-Path $env:USERPROFILE ".turing-os\turing-os\.env"

if (Test-Path $parentEnv) {
    $ENV_FILE = (Resolve-Path $parentEnv).Path
} elseif (Test-Path $localEnv) {
    $ENV_FILE = (Resolve-Path $localEnv).Path
} elseif (Test-Path $homeEnv) {
    $ENV_FILE = $homeEnv
} else {
    $ENV_FILE = $parentEnv
}

# Colors
$supportsAnsi = $PSVersionTable.PSVersion.Major -ge 6
$RED = if ($supportsAnsi) { "`e[0;31m" } else { "" }
$GREEN = if ($supportsAnsi) { "`e[0;32m" } else { "" }
$YELLOW = if ($supportsAnsi) { "`e[1;33m" } else { "" }
$BLUE = if ($supportsAnsi) { "`e[0;34m" } else { "" }
$CYAN = if ($supportsAnsi) { "`e[0;36m" } else { "" }
$NC = if ($supportsAnsi) { "`e[0m" } else { "" }

function Log { param([string]$Message); Write-Host "${GREEN}[✓]${NC} $Message" }
function Warn { param([string]$Message); Write-Host "${YELLOW}[!]${NC} $Message" }
function ErrorExit { param([string]$Message); Write-Host "${RED}[✗]${NC} $Message"; exit 1 }
function Step { param([string]$Message); Write-Host "${BLUE}[→]${NC} $Message" }
function Info { param([string]$Message); Write-Host "${CYAN}[i]${NC} $Message" }

function Load-Env {
    if (-not (Test-Path $ENV_FILE)) {
        ErrorExit ".env file not found at $ENV_FILE"
    }
    
    Get-Content $ENV_FILE | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
    
    Log "Loaded environment from .env"
}

function Save-Env {
    param([hashtable]$Updates)
    
    $envContent = Get-Content $ENV_FILE -Raw
    
    foreach ($key in $Updates.Keys) {
        if ($envContent -match "^[#]?${key}=.*$") {
            $envContent = $envContent -replace "^[#]?${key}=.*$", "${key}=$($Updates[$key])"
        } else {
            $envContent += "`n${key}=$($Updates[$key])"
        }
    }
    
    $envContent | Set-Content $ENV_FILE -NoNewline
    Log "Saved to .env"
}

function Prompt {
    param([string]$Label, [string]$Default = "", [switch]$Password)
    
    if ($Default) {
        Write-Host -NoNewline "${CYAN}${Label}${NC} [${Default}]: "
    } else {
        Write-Host -NoNewline "${CYAN}${Label}${NC}: "
    }
    
    if ($Password) {
        $secPw = Read-Host -AsSecureString
        return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw))
    }
    
    $enteredValue = Read-Host
    return if ([string]::IsNullOrEmpty($enteredValue)) { $Default } else { $enteredValue }
}

function Test-ServiceUrl {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

# ============================================
# TOKEN VALIDATORS
# ============================================

function Test-TaigaToken {
    param([string]$Url, [string]$Token)
    
    try {
        $headers = @{ "Authorization" = "Bearer $Token" }
        $response = Invoke-RestMethod -Uri "$Url/auth/whoami" -Headers $headers -TimeoutSec 10
        return @{
            Success = $true
            Message = "Token valid! User: $($response.username)"
            Data = $response
        }
    } catch {
        return @{
            Success = $false
            Message = "Token invalid or insufficient permissions"
            Error = $_.Exception.Message
        }
    }
}

function Test-MatrixToken {
    param([string]$Url, [string]$Token)
    
    try {
        $headers = @{ "Authorization" = "Bearer $Token" }
        $response = Invoke-RestMethod -Uri "$Url/_matrix/client/r0/account/whoami" -Headers $headers -TimeoutSec 10
        return @{
            Success = $true
            Message = "Bot token valid!"
            Data = $response
        }
    } catch {
        return @{
            Success = $false
            Message = "Bot token invalid"
            Error = $_.Exception.Message
        }
    }
}

function Test-WikiToken {
    param([string]$Url, [string]$Token)
    
    try {
        $headers = @{ "Authorization" = "Bearer $Token" }
        $body = @{ query = "{ pages { list(limit: 1) { id title } } }" } | ConvertTo-Json
        $response = Invoke-RestMethod -Uri "$Url/graphql" -Method Post -Headers $headers -Body $body -TimeoutSec 10
        return @{
            Success = $true
            Message = "API token valid!"
            Data = $response
        }
    } catch {
        return @{
            Success = $false
            Message = "API token invalid"
            Error = $_.Exception.Message
        }
    }
}

function Test-Context7Token {
    param([string]$Token)
    
    try {
        $headers = @{ "x-api-key" = $Token }
        $response = Invoke-RestMethod -Uri "https://api.context7.com/v2/user" -Headers $headers -TimeoutSec 10
        return @{
            Success = $true
            Message = "Context7 token valid!"
            Data = $response
        }
    } catch {
        return @{
            Success = $false
            Message = "Context7 API key invalid"
            Error = $_.Exception.Message
        }
    }
}

# ============================================
# CONFIGURATION FUNCTIONS
# ============================================

function Show-ServiceStatus {
    Write-Host ""
    Write-Host "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    Write-Host "${BLUE}║            TURING OS SERVICE STATUS                 ║${NC}"
    Write-Host "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    Write-Host ""
    
    # Taiga
    $taigaScheme = if ($env:TAIGA_SCHEME) { $env:TAIGA_SCHEME } else { "http" }
    $taigaDomain = if ($env:TAIGA_DOMAIN) { $env:TAIGA_DOMAIN } else { "localhost:9000" }
    $taigaUrl = '{0}://{1}/api/v1' -f $taigaScheme, $taigaDomain
    $taigaKey = $env:TAIGA_API_KEY
    Write-Host -NoNewline "  Taiga:   "
    if ([string]::IsNullOrEmpty($taigaKey)) {
        Write-Host "${YELLOW}⚠ Not configured (auto-setup via .\init-admin-users.ps1)${NC}"
    } elseif (Test-ServiceUrl "$taigaUrl/") {
        $test = Test-TaigaToken -Url $taigaUrl -Token $taigaKey
        if ($test.Success) {
            Write-Host "${GREEN}✓ Connected${NC}"
        } else {
            Write-Host "${RED}✗ Token invalid${NC}"
        }
    } else {
        Write-Host "${YELLOW}⚠ Service not reachable${NC}"
    }
    
    # Matrix/Synapse
    $synapseUrl = if ($env:SYNAPSE_API_URL) { $env:SYNAPSE_API_URL } else { "http://localhost:8008" }
    $matrixToken = $env:MATRIX_BOT_TOKEN
    Write-Host -NoNewline "  Matrix:  "
    if ([string]::IsNullOrEmpty($matrixToken)) {
        Write-Host "${YELLOW}⚠ Not configured (auto-setup via .\init-admin-users.ps1)${NC}"
    } elseif (Test-ServiceUrl $synapseUrl) {
        $test = Test-MatrixToken -Url $synapseUrl -Token $matrixToken
        if ($test.Success) {
            Write-Host "${GREEN}✓ Connected${NC}"
        } else {
            Write-Host "${RED}✗ Token invalid${NC}"
        }
    } else {
        Write-Host "${YELLOW}⚠ Service not reachable${NC}"
    }
    
    # BookStack
    $bookstackUrl = if ($env:BOOKSTACK_URL) { $env:BOOKSTACK_URL } else { "http://localhost:6875" }
    $bookstackToken = $env:BOOKSTACK_TOKEN
    Write-Host -NoNewline "  BookStack: "
    if ([string]::IsNullOrEmpty($bookstackToken)) {
        Write-Host "${YELLOW}⚠ Not configured${NC}"
    } elseif (Test-ServiceUrl $bookstackUrl) {
        $test = Test-WikiToken -Url $bookstackUrl -Token $bookstackToken
        if ($test.Success) {
            Write-Host "${GREEN}✓ Connected${NC}"
        } else {
            Write-Host "${RED}✗ Token invalid${NC}"
        }
    } else {
        Write-Host "${YELLOW}⚠ Service not reachable${NC}"
    }
    
    # Context7
    $context7Key = $env:CONTEXT7_API_KEY
    Write-Host -NoNewline "  Context7: "
    if ([string]::IsNullOrEmpty($context7Key)) {
        Write-Host "${YELLOW}⚠ Not configured${NC}"
    } else {
        $test = Test-Context7Token -Token $context7Key
        if ($test.Success) {
            Write-Host "${GREEN}✓ Connected${NC}"
        } else {
            Write-Host "${RED}✗ Invalid${NC}"
        }
    }
    
    Write-Host ""
}

function Configure-Taiga {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                     TAIGA CONFIG                       ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Taiga uses username/password auth (NOT API key)."
    Info "Run: docker compose up -d && .\init-admin-users.ps1"
    Info "to auto-create admin user and get auth token."
    Write-Host ""
    Info "Manual config not recommended - use the bootstrap script instead."
}

function Configure-Matrix {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                   MATRIX CONFIG                        ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Matrix bot tokens are auto-created by init-admin-users.ps1."
    Info "Run: docker compose up -d && .\init-admin-users.ps1"
    Write-Host ""
    Info "Manual config not recommended - use the bootstrap script instead."
}

function Configure-BookStack {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  BOOKSTACK CONFIG                       ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $defaultUrl = if ($env:BOOKSTACK_URL) { $env:BOOKSTACK_URL } else { "http://localhost:6875" }
    Info "Get API token at: $defaultUrl/settings/api"
    Write-Host ""
    
    $url = Prompt -Label "BookStack URL" -Default $defaultUrl
    $token = Prompt -Label "API Token (JWT)" -Password
    
    if (-not [string]::IsNullOrEmpty($token)) {
        Write-Host ""
        Step "Testing connection..."
        $test = Test-WikiToken -Url $url -Token $token
        
        if ($test.Success) {
            Log $test.Message
            Save-Env -Updates @{
                "BOOKSTACK_URL" = $url
                "BOOKSTACK_TOKEN" = $token
            }
            Log "BookStack configuration saved!"
        } else {
            ErrorExit "$($test.Message) - $($test.Error)"
        }
    }
}

function Configure-Context7 {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  CONTEXT7 CONFIG                       ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Get API key at: https://context7.com/dashboard"
    Write-Host ""
    
    $token = Prompt -Label "Context7 API Key" -Default $env:CONTEXT7_API_KEY
    
    if (-not [string]::IsNullOrEmpty($token)) {
        Write-Host ""
        Step "Testing connection..."
        $test = Test-Context7Token -Token $token
        
        if ($test.Success) {
            Log $test.Message
            Save-Env -Updates @{
                "CONTEXT7_API_KEY" = $token
            }
            Log "Context7 configuration saved!"
        } else {
            ErrorExit "$($test.Message) - $($test.Error)"
        }
    }
}

function Test-AllConnections {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃              TESTING ALL CONNECTIONS                   ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $allPassed = $true
    
    # Taiga
    Write-Host -NoNewline "  Taiga: "
    if (-not [string]::IsNullOrEmpty($env:TAIGA_API_KEY)) {
        $taigaScheme = if ($env:TAIGA_SCHEME) { $env:TAIGA_SCHEME } else { "http" }
        $taigaDomain = if ($env:TAIGA_DOMAIN) { $env:TAIGA_DOMAIN } else { "localhost:9000" }
        $taigaUrl = '{0}://{1}/api/v1' -f $taigaScheme, $taigaDomain
        $test = Test-TaigaToken -Url $taigaUrl -Token $env:TAIGA_API_KEY
        if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    # Matrix
    Write-Host -NoNewline "  Matrix: "
    if (-not [string]::IsNullOrEmpty($env:MATRIX_BOT_TOKEN)) {
        $synapseUrl = if ($env:SYNAPSE_API_URL) { $env:SYNAPSE_API_URL } else { "http://localhost:8008" }
        $test = Test-MatrixToken -Url $synapseUrl -Token $env:MATRIX_BOT_TOKEN
        if ($test.Success) { Write-Host "${GREEN}✓ Bot token valid${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    # BookStack
    Write-Host -NoNewline "  BookStack: "
    $bookstackUrl = if ($env:BOOKSTACK_URL) { $env:BOOKSTACK_URL } else { "http://localhost:6875" }
    if (-not [string]::IsNullOrEmpty($env:BOOKSTACK_TOKEN)) {
        $test = Test-WikiToken -Url $bookstackUrl -Token $env:BOOKSTACK_TOKEN
        if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    # Context7
    Write-Host -NoNewline "  Context7: "
    if (-not [string]::IsNullOrEmpty($env:CONTEXT7_API_KEY)) {
        $test = Test-Context7Token -Token $env:CONTEXT7_API_KEY
        if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    Write-Host ""
    if ($allPassed) {
        Log "All connections successful!"
    } else {
        Warn "Some connections failed. Run with -Service <name> to reconfigure."
    }
}

# ============================================
# MAIN
# ============================================

function Show-Help {
    Write-Host ""
    Write-Host "${BLUE}Turing OS Configuration Manager v${VERSION}${NC}"
    Write-Host ""
    Write-Host "Usage: .\config.ps1 [-Service <option>]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  all       - Configure all services (default)"
    Write-Host "  taiga     - View Taiga config info"
    Write-Host "  matrix    - View Matrix config info"
    Write-Host "  wiki      - Configure Wiki.js only"
    Write-Host "  context7  - Configure Context7 only"
    Write-Host "  test      - Test all connections"
    Write-Host ""
    Write-Host "IMPORTANT: Taiga and Matrix auto-setup via:"
    Write-Host "  docker compose up -d && .\init-admin-users.ps1"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\config.ps1                    # Configure all"
    Write-Host "  .\config.ps1 -Service wiki      # Configure Wiki.js only"
    Write-Host "  .\config.ps1 -Service test      # Test connections"
    Write-Host ""
}

# Load existing env
Load-Env

# Show current status
Show-ServiceStatus

# Run requested action
switch ($Service.ToLower()) {
    "all" {
        Configure-Taiga
        Configure-Matrix
        Configure-BookStack
        Configure-Context7
    }
    "taiga" { Configure-Taiga }
    "matrix" { Configure-Matrix }
    "wiki" { 
        Warn "Wiki is now called BookStack. Use: .\config.ps1 -Service bookstack"
        Configure-BookStack 
    }
    "bookstack" { Configure-BookStack }
    "context7" { Configure-Context7 }
    "github" { Info "GitHub uses repo URL, no token needed." }
    "test" { Test-AllConnections }
}

# Reload and show final status
Write-Host ""
Step "Reloading environment..."
Load-Env
Write-Host ""
Show-ServiceStatus