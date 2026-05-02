# Turing OS Configuration Manager
# Usage: .\config.ps1 [-Service all|plane|revolt|bookstack|context7|github]

param(
    [ValidateSet("all", "plane", "revolt", "bookstack", "context7", "github", "test")]
    [string]$Service = "all"
)

$VERSION = "1.0.0"
$ENV_FILE = "$PSScriptRoot\.env"

# Colors
$RED = "`e[0;31m"
$GREEN = "`e[0;32m"
$YELLOW = "`e[1;33m"
$BLUE = "`e[0;34m"
$CYAN = "`e[0;36m"
$NC = "`e[0m"

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
    
    $input = Read-Host
    return if ([string]::IsNullOrEmpty($input)) { $Default } else { $input }
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

function Test-PlaneToken {
    param([string]$Url, [string]$Token)
    
    try {
        $headers = @{ "x-api-key" = $Token }
        $response = Invoke-RestMethod -Uri "$Url/api/v1/workspaces" -Headers $headers -TimeoutSec 10
        return @{
            Success = $true
            Message = "Token valid! Found $($response.length) workspaces"
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

function Test-RevoltToken {
    param([string]$Url, [string]$Token)
    
    try {
        $headers = @{ "x-bot-token" = $Token }
        $response = Invoke-RestMethod -Uri "$Url/api/bots/@me" -Headers $headers -TimeoutSec 10
        return @{
            Success = $true
            Message = "Bot token valid! Bot: $($response.username)"
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

function Test-BookStackToken {
    param([string]$Url, [string]$TokenId, [string]$TokenSecret)
    
    try {
        $credentials = @{
            email = $TokenId
            password = $TokenSecret
        }
        $response = Invoke-RestMethod -Uri "$Url/api/token" -Method Post -Body $credentials -TimeoutSec 10
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
    
    # Plane
    $planeUrl = $env:PLANE_URL
    $planeKey = $env:PLANE_API_KEY
    Write-Host -NoNewline "  Plane: "
    if ([string]::IsNullOrEmpty($planeKey)) {
        Write-Host "${YELLOW}⚠ Not configured${NC}"
    } elseif (Test-ServiceUrl "$planeUrl/api/v1/workspaces") {
        $test = Test-PlaneToken -Url $planeUrl -Token $planeKey
        if ($test.Success) {
            Write-Host "${GREEN}✓ Connected${NC}"
        } else {
            Write-Host "${RED}✗ Token invalid${NC}"
        }
    } else {
        Write-Host "${YELLOW}⚠ Service not reachable${NC}"
    }
    
    # Revolt
    $revoltUrl = $env:REVOLT_URL
    $revoltToken = $env:REVOLT_BOT_TOKEN
    Write-Host -NoNewline "  Revolt: "
    if ([string]::IsNullOrEmpty($revoltToken)) {
        Write-Host "${YELLOW}⚠ Not configured${NC}"
    } elseif (Test-ServiceUrl $revoltUrl) {
        Write-Host "${GREEN}✓ Connected${NC}"
    } else {
        Write-Host "${YELLOW}⚠ Service not reachable${NC}"
    }
    
    # BookStack
    $bookstackUrl = $env:BOOKSTACK_URL
    $bookstackToken = $env:BOOKSTACK_API_TOKEN
    Write-Host -NoNewline "  BookStack: "
    if ([string]::IsNullOrEmpty($bookstackToken)) {
        Write-Host "${YELLOW}⚠ Not configured${NC}"
    } elseif (Test-ServiceUrl $bookstackUrl) {
        Write-Host "${GREEN}✓ Connected${NC}"
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

function Configure-Plane {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                     PLANE CONFIG                        ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Get your API key at: $($env:PLANE_URL)/settings/api-tokens"
    Write-Host ""
    
    $url = Prompt -Label "Plane URL" -Default $env:PLANE_URL
    $token = Prompt -Label "API Token"
    $workspaceId = Prompt -Label "Workspace ID" -Default $env:PLANE_WORKSPACE_ID
    
    if (-not [string]::IsNullOrEmpty($token)) {
        Write-Host ""
        Step "Testing connection..."
        $test = Test-PlaneToken -Url $url -Token $token
        
        if ($test.Success) {
            Log $test.Message
            Save-Env -Updates @{
                "PLANE_URL" = $url
                "PLANE_API_KEY" = $token
                "PLANE_WORKSPACE_ID" = $workspaceId
            }
            Log "Plane configuration saved!"
        } else {
            ErrorExit "$($test.Message) - $($test.Error)"
        }
    }
}

function Configure-Revolt {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                    REVOLT CONFIG                       ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Get bot token at: $($env:REVOLT_URL)/settings/bots"
    Write-Host "Create bot at: Settings → User Management → Create Bot"
    Write-Host ""
    
    $url = Prompt -Label "Revolt URL" -Default $env:REVOLT_URL
    $token = Prompt -Label "Bot Token"
    $adminId = Prompt -Label "Admin User ID" -Default $env:REVOLT_ADMIN_USER_ID
    
    if (-not [string]::IsNullOrEmpty($token)) {
        Write-Host ""
        Step "Testing connection..."
        $test = Test-RevoltToken -Url $url -Token $token
        
        if ($test.Success) {
            Log $test.Message
            Save-Env -Updates @{
                "REVOLT_URL" = $url
                "REVOLT_BOT_TOKEN" = $token
                "REVOLT_ADMIN_USER_ID" = $adminId
            }
            Log "Revolt configuration saved!"
        } else {
            ErrorExit "$($test.Message) - $($test.Error)"
        }
    }
}

function Configure-BookStack {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  BOOKSTACK CONFIG                      ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    Info "Get API token at: $($env:BOOKSTACK_URL)/settings/api-tokens"
    Write-Host ""
    
    $url = Prompt -Label "BookStack URL" -Default $env:BOOKSTACK_URL
    $tokenId = Prompt -Label "API Token ID"
    $tokenSecret = Prompt -Label "API Token Secret" -Password
    
    if (-not [string]::IsNullOrEmpty($tokenId)) {
        Write-Host ""
        Step "Testing connection..."
        $test = Test-BookStackToken -Url $url -TokenId $tokenId -TokenSecret $tokenSecret
        
        if ($test.Success) {
            Log $test.Message
            Save-Env -Updates @{
                "BOOKSTACK_URL" = $url
                "BOOKSTACK_API_TOKEN" = "$tokenId:$tokenSecret"
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
    
    # Plane
    Write-Host -NoNewline "  Plane: "
    if (-not [string]::IsNullOrEmpty($env:PLANE_API_KEY)) {
        $test = Test-PlaneToken -Url $env:PLANE_URL -Token $env:PLANE_API_KEY
        if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    # Revolt
    Write-Host -NoNewline "  Revolt: "
    if (-not [string]::IsNullOrEmpty($env:REVOLT_BOT_TOKEN)) {
        $test = Test-RevoltToken -Url $env:REVOLT_URL -Token $env:REVOLT_BOT_TOKEN
        if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
    } else { Write-Host "${YELLOW}⚠ Not configured${NC}"; $allPassed = $false }
    
    # BookStack
    Write-Host -NoNewline "  BookStack: "
    if (-not [string]::IsNullOrEmpty($env:BOOKSTACK_API_TOKEN)) {
        $parts = $env:BOOKSTACK_API_TOKEN -split ':'
        if ($parts.Count -eq 2) {
            $test = Test-BookStackToken -Url $env:BOOKSTACK_URL -TokenId $parts[0] -TokenSecret $parts[1]
            if ($test.Success) { Write-Host "${GREEN}✓ $($test.Message)${NC}" } else { Write-Host "${RED}✗ $($test.Message)${NC}"; $allPassed = $false }
        } else {
            Write-Host "${YELLOW}⚠ Invalid token format${NC}"; $allPassed = $false
        }
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
    Write-Host "  plane     - Configure Plane only"
    Write-Host "  revolt    - Configure Revolt only"
    Write-Host "  bookstack - Configure BookStack only"
    Write-Host "  context7  - Configure Context7 only"
    Write-Host "  test      - Test all connections"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  .\config.ps1                    # Configure all"
    Write-Host "  .\config.ps1 -Service plane     # Configure Plane only"
    Write-Host "  .\config.ps1 -Service test       # Test connections"
    Write-Host ""
}

# Load existing env
Load-Env

# Show current status
Show-ServiceStatus

# Run requested action
switch ($Service.ToLower()) {
    "all" {
        Configure-Plane
        Configure-Revolt
        Configure-BookStack
        Configure-Context7
    }
    "plane" { Configure-Plane }
    "revolt" { Configure-Revolt }
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