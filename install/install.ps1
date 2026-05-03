# Turing OS Installer for Windows (PowerShell)
# Usage: Set-ExecutionPolicy Bypass -Scope Process -Force; .\install\install.ps1

param(
    [switch]$SkipPrerequisites
)

$VERSION = "1.0.0"
$INSTALL_DIR = "$env:USERPROFILE\.turing-os"

# Colors - use Write-Host -ForegroundColor for reliability
function Log { param([string]$M); Write-Host "[OK] $M" -ForegroundColor Green }
function Warn { param([string]$M); Write-Host "[!!] $M" -ForegroundColor Yellow }
function ErrorExit { param([string]$M); Write-Host "[FAIL] $M" -ForegroundColor Red; exit 1 }
function Step { param([string]$M); Write-Host "[>>] $M" -ForegroundColor Blue }
function Info { param([string]$M); Write-Host "[i] $M" -ForegroundColor Cyan }
function SectionHeader {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 56) -ForegroundColor Yellow
    Write-Host "  $Title" -ForegroundColor Yellow
    Write-Host ("=" * 56) -ForegroundColor Yellow
    Write-Host ""
}

function Banner {
    Write-Host ""
    Write-Host ("=" * 56) -ForegroundColor Blue
    Write-Host ""
    Write-Host "          TURING OS" -ForegroundColor Green
    Write-Host "          Multi-Agent IT Department OS  v$VERSION" -ForegroundColor Yellow
    Write-Host ""
    Write-Host ("=" * 56) -ForegroundColor Blue
    Write-Host ""
}

function Get-WorkDir {
    $localRepo = Join-Path $PSScriptRoot ".."
    if (Test-Path (Join-Path $localRepo "docker-compose.yml")) {
        return (Resolve-Path $localRepo).Path
    }

    if ($script:SOURCE_DIR) {
        return $script:SOURCE_DIR
    }

    return (Join-Path $INSTALL_DIR "turing-os")
}

function Invoke-InitAdminUsers {
    param([string]$WorkDir)

    Push-Location $WorkDir
    try {
        if (Test-Path ".\init-admin-users.ps1") {
            & powershell -ExecutionPolicy Bypass -File ".\init-admin-users.ps1" -RepoRoot $WorkDir
            return ($LASTEXITCODE -eq 0)
        }

        if (Get-Command bash -ErrorAction SilentlyContinue) {
            & bash ./init-admin-users.sh
            return ($LASTEXITCODE -eq 0)
        }

        if (Get-Command wsl -ErrorAction SilentlyContinue) {
            & wsl bash ./init-admin-users.sh
            return ($LASTEXITCODE -eq 0)
        }

        Warn "No PowerShell bootstrap or bash/WSL runtime found. Run the bootstrap script manually after installation."
        return $false
    }
    finally {
        Pop-Location
    }
}

function Prompt-Input {
    param(
        [string]$Label,
        [string]$Default = "",
        [switch]$Password,
        [switch]$Confirm
    )

    if ($Default) {
        Write-Host -NoNewline "$Label " -ForegroundColor Cyan
        Write-Host -NoNewline "[$Default]: "
    }
    else {
        Write-Host -NoNewline "${Label}: " -ForegroundColor Cyan
    }

    if ($Password) {
        $secPw = Read-Host -AsSecureString
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw))
        if ($Confirm) {
            Write-Host -NoNewline "Confirm password: " -ForegroundColor Cyan
            $secPw2 = Read-Host -AsSecureString
            $pw2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw2))
            if ($pw -ne $pw2) {
                Warn "Passwords don't match. Try again."
                return Prompt-Input -Label $Label -Password -Confirm
            }
        }
        return $pw
    }
    else {
        $val = Read-Host
        if ([string]::IsNullOrEmpty($val)) { $val = $Default }
        return $val
    }
}

function Select-Option {
    param([string]$Prompt, [array]$Options, [int]$Default = 1)
    Write-Host $Prompt -ForegroundColor Cyan
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $num = $i + 1
        $marker = ""
        if ($num -eq $Default) { $marker = " <- default" }
        Write-Host "  $num`: $($Options[$i])$marker"
    }
    $choice = Read-Host
    if ([string]::IsNullOrEmpty($choice)) { $choice = $Default }
    return [int]$choice
}

# ============================================
# AUTO-DETECTION FUNCTIONS
# ============================================

function Test-Service {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction SilentlyContinue
        return $true
    }
    catch {
        return $false
    }
}

function Auto-Detect-Taiga {
    Step "Detecting Taiga..."
    $taigaUrl = "http://localhost:$script:TAIGA_GATEWAY_PORT"

    if (-not (Test-Service "$taigaUrl/api/v1/")) {
        Warn "Taiga not responding at $taigaUrl"
        return $null
    }

    Log "Taiga detected!"
    Write-Host "  Run init-admin-users.sh after docker compose up to auto-create admin user."

    return @{
        Url            = $taigaUrl
        Token          = $null
        ManualRequired = $false
    }
}

function Auto-Detect-Matrix {
    Step "Detecting Matrix/Synapse..."
    $synapseUrl = "http://localhost:$script:SYNAPSE_PORT"

    if (-not (Test-Service $synapseUrl)) {
        Warn "Matrix/Synapse not responding at $synapseUrl"
        return $null
    }

    Log "Matrix/Synapse detected!"
    Write-Host "  Run init-admin-users.sh after docker compose up to auto-create bot user."

    return @{
        Url            = $synapseUrl
        BotToken       = $null
        AdminId        = $null
        ManualRequired = $false
    }
}

function Auto-Detect-Wiki {
    Step "Detecting Wiki.js..."
    $wikiUrl = "http://localhost:$script:WIKI_PORT"

    if (-not (Test-Service $wikiUrl)) {
        Warn "Wiki.js not responding at $wikiUrl"
        return $null
    }

    Log "Wiki.js detected!"
    Write-Host "  Wiki.js uses JWT token for API access."
    Write-Host "  Create admin account at first login, then generate token at:"
    Write-Host "    $wikiUrl/settings/api -> New Token"

    return @{
        Url            = $wikiUrl
        Token          = $null
        ManualRequired = $true
    }
}

# Check prerequisites
function Check-Prerequisites {
    Step "Checking prerequisites..."

    # Docker
    try {
        $dockerVersion = docker version --format '{{.Server.Version}}' 2>$null
        if (-not $dockerVersion) { throw "No output" }
        Log "Docker $dockerVersion"
    }
    catch {
        ErrorExit "Docker is not installed or not running.`n    Install: https://docs.docker.com/desktop/install/windows-install/"
    }

    # Docker Desktop running
    $dd = Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue
    if (-not $dd) {
        Warn "Docker Desktop is not running. Please start it."
        Write-Host "Press any key to continue when ready..."
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }

    # Docker Compose
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        Log "Docker Compose"
    }
    else {
        try {
            docker compose version | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Log "Docker Compose (built-in)"
            }
            else {
                ErrorExit "Docker Compose is not installed."
            }
        }
        catch {
            ErrorExit "Docker Compose is not installed."
        }
    }
}

# Configure Wiki.js (uses admin credentials from Configure-Admin)
function Configure-Wiki {
    SectionHeader "WIKI.JS CONFIGURATION"

    # Wiki.js admin email is derived from admin username
    $script:WIKI_ADMIN_EMAIL = "admin@wiki.local"
    if (-not [string]::IsNullOrEmpty($script:ADMIN_USER)) {
        $script:WIKI_ADMIN_EMAIL = "$($script:ADMIN_USER)@wiki.local"
    }

    Log "Wiki.js will use admin credentials from CONFIGURE ADMIN step"
}

# Configure Ports
function Configure-Ports {
    SectionHeader "PORT CONFIGURATION"

    $script:TAIGA_GATEWAY_PORT = Prompt-Input -Label "Taiga Gateway Port" -Default "9000"
    $script:WIKI_PORT = Prompt-Input -Label "Wiki.js Port" -Default "6875"
    $script:SYNAPSE_PORT = Prompt-Input -Label "Matrix/Synapse Port" -Default "8008"
    $script:ORCHESTRATOR_PORT = Prompt-Input -Label "Orchestrator Port" -Default "3001"

    Log "Ports configured"
}

# Configure LLM
function Configure-LLM {
    SectionHeader "LLM CONFIGURATION"

    $providers = @("OpenAI (GPT-4, GPT-4o)", "Anthropic (Claude 3.5, 3.7)", "DeepSeek (V3, R1)", "Ollama (local)", "Custom (OpenAI-compatible)")
    $choice = Select-Option "Select LLM Provider:" -Options $providers -Default 1

    switch ($choice) {
        1 {
            $script:LLM_PROVIDER = "openai"
            $script:LLM_BASE_URL = "https://api.openai.com/v1"
            $script:LLM_MODEL = Prompt-Input -Label "Model" -Default "gpt-4o"
        }
        2 {
            $script:LLM_PROVIDER = "anthropic"
            $script:LLM_BASE_URL = "https://api.anthropic.com"
            $script:LLM_MODEL = Prompt-Input -Label "Model" -Default "claude-3-5-sonnet-20241002"
        }
        3 {
            $script:LLM_PROVIDER = "deepseek"
            $script:LLM_BASE_URL = "https://api.deepseek.com/v1"
            $script:LLM_MODEL = Prompt-Input -Label "Model" -Default "deepseek-chat"
        }
        4 {
            $script:LLM_PROVIDER = "ollama"
            $script:LLM_BASE_URL = "http://localhost:11434/v1"
            $script:LLM_MODEL = Prompt-Input -Label "Model" -Default "llama3.2"
        }
        5 {
            $script:LLM_PROVIDER = "custom"
            $script:LLM_BASE_URL = Prompt-Input -Label "Base URL"
            $script:LLM_MODEL = Prompt-Input -Label "Model" -Default "gpt-4o"
        }
    }

    $script:LLM_API_KEY = Prompt-Input -Label "LLM API Key" -Password

    Log "LLM: $($script:LLM_PROVIDER) / $($script:LLM_MODEL)"
}

# Configure Context7
function Configure-Context7 {
    SectionHeader "CONTEXT7 CONFIGURATION"

    Write-Host "  Context7 provides up-to-date documentation for tech research."
    Write-Host ""

    $script:CONTEXT7_API_KEY = Prompt-Input -Label "Context7 API Key (skip if none)"

    if ([string]::IsNullOrEmpty($script:CONTEXT7_API_KEY)) {
        Warn "Context7 API key not set. Tech research will use fallback."
    }
    else {
        Log "Context7 configured"
    }
}

# Configure Worker
function Configure-Worker {
    SectionHeader "WORKER CONFIGURATION"

    $script:WORKER_TIMEOUT = Prompt-Input -Label "Worker Timeout (minutes)" -Default "15"
    $script:ZOMBIE_CHECK = Prompt-Input -Label "Zombie Check Interval (minutes)" -Default "5"
    $script:MAX_WORKERS = Prompt-Input -Label "Max Workers" -Default "5"

    Write-Host ""
    Write-Host "  Execution Mode:"
    $modeOptions = @("Sequential (one task at a time)", "Parallel (multiple workers)")
    $modeChoice = Select-Option "Select execution mode:" -Options $modeOptions -Default 1

    $script:EXECUTION_MODE = if ($modeChoice -eq 1) { "sequential" } else { "parallel" }

    Log "Worker configured: $($script:EXECUTION_MODE) mode, max $($script:MAX_WORKERS) workers"
}

# Configure GitHub (Doctor Feedback)
function Configure-GitHub {
    SectionHeader "GITHUB CONFIGURATION (DOCTOR)"

    Write-Host "  Doctor uses GitHub Issues for bug reports and feedback."
    Write-Host "  Repository: https://github.com/louisphamdev/turing-os"
    Write-Host ""

    $script:GITHUB_REPO = Prompt-Input -Label "GitHub Repository" -Default "louisphamdev/turing-os"
    $script:GITHUB_ISSUE_URL = "https://github.com/$($script:GITHUB_REPO)/issues/new"

    Log "GitHub: https://github.com/$($script:GITHUB_REPO)"
}

# Configure Admin (used for Wiki.js setup)
function Configure-Admin {
    SectionHeader "ADMIN CONFIGURATION"

    Write-Host "  This admin account will be used for Wiki.js initial setup."
    Write-Host ""
    $script:ADMIN_USER = Prompt-Input -Label "Admin Username" -Default "admin"
    $script:ADMIN_PASSWORD = Prompt-Input -Label "Admin Password" -Password -Confirm

    Log "Admin configured"
}

# Generate docker-compose.override.yml
function Generate-DockerCompose {
    Step "Generating docker-compose configuration..."

    $workDir = Get-WorkDir

    $overrideContent = @"
services:
  taiga-gateway:
    ports:
      - "$($script:TAIGA_GATEWAY_PORT):80"

  taiga-front:
    environment:
      - TAIGA_URL=http://localhost:$($script:TAIGA_GATEWAY_PORT)
      - TAIGA_WEBSOCKETS_URL=ws://localhost:$($script:TAIGA_GATEWAY_PORT)

  wiki:
    ports:
      - "$($script:WIKI_PORT):3000"

  synapse:
    container_name: synapse
    ports:
      - "$($script:SYNAPSE_PORT):8008"

  element:
    ports:
      - "8080:80"
    volumes:
      - ./element_config/config.json:/usr/share/nginx/html/config.json:ro

  turing-orchestrator:
    ports:
      - "$($script:ORCHESTRATOR_PORT):3001"
"@

    # Create element_config directory with proper config
    $elementConfigDir = Join-Path $workDir "element_config"
    if (-not (Test-Path $elementConfigDir)) {
        New-Item -ItemType Directory -Path $elementConfigDir -Force | Out-Null
    }

    $elementConfig = @"
{
    "default_server_config": {
        "m.homeserver": {
            "base_url": "http://localhost:$($script:SYNAPSE_PORT)",
            "server_name": "localhost"
        }
    },
    "disable_custom_urls": false,
    "disable_guests": true,
    "disable_login_language_selector": false,
    "disable_3pid_login": false,
    "brand": "Turing OS",
    "default_country_code": "US",
    "show_labs_settings": false,
    "features": {},
    "default_federate": false,
    "default_theme": "light",
    "room_directory": {
        "servers": ["localhost"]
    },
    "jitsi": {
        "preferred_domain": "meet.element.io"
    }
}
"@
    $elementConfig | Out-File -FilePath "$elementConfigDir\config.json" -Encoding UTF8
    Log "Element config written"

    $overrideContent | Out-File -FilePath "$workDir\docker-compose.override.yml" -Encoding UTF8
    Log "Docker Compose override written"
}

# Generate .env file
function Generate-Env {
    Step "Generating environment file..."

    $script:DOCKER_SOCKET_PATH = if ($script:DOCKER_SOCKET_PATH) { $script:DOCKER_SOCKET_PATH } else { "//var/run/docker.sock" }

    $envContent = @"
# Turing OS Environment Configuration
# Generated by installer on $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

# LLM CONFIGURATION
LLM_PROVIDER=$($script:LLM_PROVIDER)
LLM_API_KEY=$($script:LLM_API_KEY)
LLM_BASE_URL=$($script:LLM_BASE_URL)
LLM_MODEL=$($script:LLM_MODEL)

# TAIGA CONFIGURATION
TAIGA_SCHEME=$($script:TAIGA_SCHEME)
TAIGA_DOMAIN=$($script:TAIGA_DOMAIN)
TAIGA_API_KEY=$($script:TAIGA_API_KEY)
TAIGA_PROJECT_SLUG=$($script:TAIGA_PROJECT_SLUG)
TAIGA_SECRET_KEY=change-me-in-production

POSTGRES_DB=taiga
POSTGRES_USER=taiga
POSTGRES_PASSWORD=taiga_password

RABBITMQ_USER=taiga
RABBITMQ_PASS=taiga_password
RABBITMQ_VHOST=taiga
RABBITMQ_ERLANG_COOKIE=secret-erlang-cookie

# MATRIX/SYNAPSE CONFIGURATION
SYNAPSE_SERVER_NAME=localhost
SYNAPSE_API_URL=$($script:SYNAPSE_API_URL)
MATRIX_BOT_TOKEN=$($script:MATRIX_BOT_TOKEN)
MATRIX_ADMIN_USER_ID=$($script:MATRIX_ADMIN_USER_ID)
SYNAPSE_REGISTRATION_SECRET=change-me-in-production

# WIKI CONFIGURATION
WIKI_URL=$($script:WIKI_URL)
WIKI_JWT_TOKEN=$($script:WIKI_JWT_TOKEN)

# CONTEXT7 CONFIGURATION
CONTEXT7_API_KEY=$($script:CONTEXT7_API_KEY)

# WORKER CONFIGURATION
WORKER_IMAGE=turing-worker-base:latest
WORKER_TIMEOUT_MINUTES=$($script:WORKER_TIMEOUT)
ZOMBIE_CHECK_INTERVAL_MINUTES=$($script:ZOMBIE_CHECK)
MAX_WORKERS=$($script:MAX_WORKERS)
EXECUTION_MODE=$($script:EXECUTION_MODE)

# GITHUB CONFIGURATION
GITHUB_REPO=$($script:GITHUB_REPO)
GITHUB_ISSUE_URL=$($script:GITHUB_ISSUE_URL)

# ADMIN CONFIGURATION
ADMIN_USER=$($script:ADMIN_USER)
ADMIN_PASSWORD=$($script:ADMIN_PASSWORD)

# DOCKER CONFIGURATION
DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_SOCKET_PATH=$($script:DOCKER_SOCKET_PATH)
DOCKER_NETWORK=turing-os_turing_network

# ORCHESTRATOR CONFIGURATION
ORCHESTRATOR_URL=http://turing-orchestrator:3001
PORT=3001
AUTO_START_ROLES=po,pm,hr,doctor

# HEALTH MONITORING
WORKER_HEARTBEAT_INTERVAL_MS=120000
WORKER_STUCK_THRESHOLD_MS=600000
"@

    $workDir = Get-WorkDir
    $envContent | Out-File -FilePath "$workDir\.env" -Encoding UTF8
    Log "Environment file generated"
}

# Clone source code
function Clone-Source {
    Step "Downloading Turing OS source code..."

    $localRepo = Get-WorkDir
    if (Test-Path (Join-Path $localRepo ".git")) {
        $script:SOURCE_DIR = $localRepo
        Log "Using current repository checkout at $localRepo"
        return
    }

    if (Get-Command git -ErrorAction SilentlyContinue) {
        if (Test-Path "$INSTALL_DIR\turing-os\.git") {
            Log "Source already exists, pulling latest..."
            Push-Location "$INSTALL_DIR\turing-os"
            git pull origin main
            Pop-Location
        }
        else {
            git clone "https://github.com/$($script:GITHUB_REPO).git" "$INSTALL_DIR\turing-os"
        }
        Log "Source code ready"
    }
    else {
        Warn "Git not available. Please clone manually:"
        Write-Host "  git clone https://github.com/$($script:GITHUB_REPO).git $INSTALL_DIR\turing-os"
        Read-Host "Press Enter when ready"
    }
}

# Build images
# Verify
function Verify-Installation {
    Step "Verifying installation..."
    Write-Host ""

    $ports = @($script:TAIGA_GATEWAY_PORT, $script:WIKI_PORT, $script:SYNAPSE_PORT, $script:ORCHESTRATOR_PORT)
    $allOk = $true

    foreach ($port in $ports) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$port" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($response.StatusCode -in 200, 302, 404) {
                Log "Port $port responding"
            }
            else {
                Warn "Port $port returned status $($response.StatusCode)"
                $allOk = $false
            }
        }
        catch {
            Warn "Port $port not responding yet"
            $allOk = $false
        }
    }

    Write-Host ""
    if ($allOk) {
        Log "All services verified!"
    }
    else {
        Warn "Some services may still be starting. Check: docker compose logs"
    }
}

# Print summary
function Print-Summary {
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor Green
    Write-Host "  INSTALLATION COMPLETE" -ForegroundColor Green
    Write-Host ("=" * 60) -ForegroundColor Green
    Write-Host ""
    Write-Host "Access URLs:" -ForegroundColor Yellow
    Write-Host "  Taiga:           http://localhost:$($script:TAIGA_GATEWAY_PORT)"
    Write-Host "  Wiki.js:         http://localhost:$($script:WIKI_PORT)"
    Write-Host "  Matrix/Synapse:  http://localhost:$($script:SYNAPSE_PORT)"
    Write-Host "  Element:         http://localhost:8080"
    Write-Host "  Orchestrator:    http://localhost:$($script:ORCHESTRATOR_PORT)"
    Write-Host ""
    Write-Host "Credentials:" -ForegroundColor Yellow
    Write-Host "  Admin User:      $($script:ADMIN_USER)"
    Write-Host "  Admin Password:  [hidden]"
    Write-Host ""
    Write-Host "Useful Commands:" -ForegroundColor Yellow
    Write-Host "  docker compose logs -f          # View logs"
    Write-Host "  .\install\config.ps1 -Service test  # Test connections"
    Write-Host "  .\init-admin-users.ps1          # Recreate Taiga + Matrix users"
    Write-Host "  start http://localhost:8080     # Open Element admin chat"
    Write-Host "  .\install\config.ps1 -Service taiga  # Reconfigure Taiga"
    Write-Host ""
    Write-Host ("=" * 60) -ForegroundColor Green
}

# Wait for a service to become healthy
function Wait-For-Service {
    param([string]$Name, [string]$Url, [int]$MaxWaitSec = 120)

    Write-Host -NoNewline "  Waiting for $Name" -ForegroundColor Cyan
    $elapsed = 0
    while ($elapsed -lt $MaxWaitSec) {
        try {
            $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            Write-Host " READY" -ForegroundColor Green
            return $true
        }
        catch {
            Write-Host -NoNewline "." -ForegroundColor DarkGray
            Start-Sleep -Seconds 5
            $elapsed += 5
        }
    }
    Write-Host " TIMEOUT" -ForegroundColor Red
    return $false
}

# ─── Initialize Wiki.js and get JWT token ─────────────────────────────────────────
function Initialize-WikiJsAndGetToken {
    SectionHeader "WIKI.JS INITIALIZATION"

    $workDir = Get-WorkDir

    # Generate minimal docker-compose override for Wiki only
    $overrideContent = @"
services:
  wiki:
    ports:
      - "$($script:WIKI_PORT):3000"
"@
    $overrideContent | Out-File -FilePath "$workDir\docker-compose.override.yml" -Encoding UTF8

    # Start only Wiki.js container
    Step "Starting Wiki.js container..."
    Push-Location $workDir
    docker compose up -d wiki
    Pop-Location

    # Wait for Wiki.js to be ready
    $wikiUrl = "http://localhost:$($script:WIKI_PORT)"
    $wikiReady = Wait-For-Service -Name "Wiki.js" -Url $wikiUrl -MaxWaitSec 180

    if (-not $wikiReady) {
        ErrorExit "Wiki.js did not start in time. Cannot proceed."
    }

    # Check if already setup
    $setupNeeded = $false
    try {
        $check = Invoke-RestMethod -Uri "$wikiUrl/api/session" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($check.user) {
            Log "Wiki.js already configured"
        }
    } catch {
        $setupNeeded = $true
    }

    # Run Wiki.js setup via API
    if ($setupNeeded) {
        Step "Running Wiki.js first-time setup..."
        try {
            # Setup admin account via POST /api/setup
            $setupBody = @{
                email    = $script:WIKI_ADMIN_EMAIL
                password = $script:ADMIN_PASSWORD
            } | ConvertTo-Json

            $setupResponse = Invoke-RestMethod -Uri "$wikiUrl/api/setup" -Method POST `
                -ContentType "application/json" -Body $setupBody -UseBasicParsing -TimeoutSec 30

            Log "Wiki.js admin account created"
        } catch {
            Warn "Wiki.js setup failed: $_"
            Write-Host "  Please complete setup manually at $wikiUrl"
        }
    }

    # ─── Step 1: Try auto-login to get JWT token ───
    Step "Attempting automatic token retrieval..."
    $autoTokenSuccess = $false

    try {
        $loginBody = @{
            email    = $script:WIKI_ADMIN_EMAIL
            password = $script:ADMIN_PASSWORD
        } | ConvertTo-Json

        $loginResponse = Invoke-RestMethod -Uri "$wikiUrl/api/login" -Method POST `
            -ContentType "application/json" -Body $loginBody -UseBasicParsing -TimeoutSec 15

        if ($loginResponse.token) {
            $script:WIKI_JWT_TOKEN = $loginResponse.token
            Log "Wiki.js JWT token obtained automatically!"
            $autoTokenSuccess = $true
        } else {
            Warn "No token in Wiki.js login response"
        }
    } catch {
        # Auto token retrieval failed - will guide user manually below
    }

    # ─── Step 2: If auto failed, show step-by-step manual instructions ───
    if (-not $autoTokenSuccess) {
        Write-Host ""
        Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" -ForegroundColor Yellow
        Write-Host "${YELLOW}  WIKI.JS MANUAL TOKEN SETUP (Required)${NC}" -ForegroundColor Yellow
        Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Automatic token retrieval failed. Please follow these steps:" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  ${GREEN}Step 1:${NC} Open Wiki.js in your browser:"
        Write-Host "         ${CYAN}$wikiUrl${NC}" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  ${GREEN}Step 2:${NC} Login with your admin credentials:"
        Write-Host "         Email:    ${CYAN}$($script:WIKI_ADMIN_EMAIL)${NC}" -ForegroundColor Cyan
        Write-Host "         Password: ${CYAN}[the password you entered during setup]${NC}"
        Write-Host ""
        Write-Host "  ${GREEN}Step 3:${NC} Go to ${CYAN}Administration${NC} (click your avatar top-right)"
        Write-Host ""
        Write-Host "  ${GREEN}Step 4:${NC} Navigate to ${CYAN}Settings → API${NC} (left sidebar)"
        Write-Host ""
        Write-Host "  ${GREEN}Step 5:${NC} Scroll down to ${CYAN}API Tokens${NC} section"
        Write-Host ""
        Write-Host "  ${GREEN}Step 6:${NC} Click ${CYAN}New Token${NC}"
        Write-Host ""
        Write-Host "  ${GREEN}Step 7:${NC} Fill in:"
        Write-Host "         - Name: ${CYAN}Turing OS${NC}"
        Write-Host "         - Expiry: ${CYAN}Never${NC} (or your preferred duration)"
        Write-Host ""
        Write-Host "  ${GREEN}Step 8:${NC} Click ${CYAN}Create${NC}"
        Write-Host ""
        Write-Host "  ${GREEN}Step 9:${NC} Copy the ${CYAN}token value${NC} shown (starts with 'eyJ...')"
        Write-Host ""
        Write-Host "  ${GREEN}Step 10:${NC} Paste the token below"
        Write-Host ""

        # Try to open browser
        try {
            Start-Process "$wikiUrl"
            Write-Host "  Browser opened automatically." -ForegroundColor Green
        } catch {
            Write-Host "  Please open manually: $wikiUrl" -ForegroundColor Yellow
        }

        Write-Host ""

        # Prompt user for token
        while ($true) {
            Write-Host -NoNewline "  ${CYAN}Enter Wiki.js API Token:${NC} "
            $enteredToken = Read-Host

            if ([string]::IsNullOrWhiteSpace($enteredToken)) {
                Warn "Token cannot be empty. Please enter a valid token or press Ctrl+C to skip."
                continue
            }

            # Validate token format (should start with eyJ)
            if ($enteredToken -notmatch "^eyJ") {
                Warn "Invalid token format. Token should start with 'eyJ...'. Please try again."
                continue
            }

            # Test the token
            Step "Validating token..."
            try {
                $headers = @{ "Authorization" = "Bearer $enteredToken" }
                $body = @{ query = "{ pages { list(limit: 1) { id title } } }" } | ConvertTo-Json
                $testResp = Invoke-RestMethod -Uri "$wikiUrl/graphql" -Method Post -Headers $headers -Body $body -TimeoutSec 10

                $script:WIKI_JWT_TOKEN = $enteredToken
                Log "Wiki.js API token validated successfully!"
                break
            } catch {
                Warn "Token validation failed. Please check and try again."
            }
        }
    }

    # Save token to .env immediately so it persists
    $envPath = Join-Path $workDir ".env"
    if (Test-Path $envPath) {
        $envContent = Get-Content $envPath -Raw
        if ($envContent -match "^[#]?WIKI_JWT_TOKEN=.*$") {
            $envContent = $envContent -replace "^[#]?WIKI_JWT_TOKEN=.*$", "WIKI_JWT_TOKEN=$($script:WIKI_JWT_TOKEN)"
        } else {
            $envContent += "`nWIKI_JWT_TOKEN=$($script:WIKI_JWT_TOKEN)"
        }
        $envContent | Set-Content $envPath -NoNewline
        Log "Token saved to .env"
    }
}

# ─── Start Taiga + Matrix infra, wait, init users ───────────────────────────────────
function Start-InfraAndInitUsers {
    SectionHeader "STARTING INFRASTRUCTURE"

    # Set derived vars
    $script:TAIGA_GATEWAY_URL = "http://localhost:$($script:TAIGA_GATEWAY_PORT)"
    $script:TAIGA_SCHEME = "http"
    $script:TAIGA_DOMAIN = "localhost:$($script:TAIGA_GATEWAY_PORT)"
    $script:SYNAPSE_API_URL = "http://localhost:$($script:SYNAPSE_PORT)"
    $script:WIKI_URL = "http://localhost:$($script:WIKI_PORT)"

    # Initialize empty tokens
    $script:TAIGA_API_KEY = ""; $script:TAIGA_PROJECT_SLUG = ""
    $script:MATRIX_BOT_TOKEN = ""; $script:MATRIX_ADMIN_USER_ID = ""
    $script:WIKI_JWT_TOKEN = ""; $script:CONTEXT7_API_KEY = ""
    $script:LLM_PROVIDER = "openai"; $script:LLM_MODEL = "gpt-4o"

    Generate-DockerCompose
    Generate-Env

    $WorkDir = Get-WorkDir

    # Start Taiga, Matrix, Wiki
    Step "Starting Taiga, Matrix, Wiki..."
    # WorkDir = where docker-compose.yml lives
    Write-Host "  Working directory: $WorkDir" -ForegroundColor DarkGray
    Push-Location $WorkDir

    # Pull images with retry loop - MUST succeed
    $pullSuccess = $false
    $pullRetries = 5
    $pullTimeoutSec = 300  # 5 min timeout per attempt
    $services = @("taiga-db", "taiga-events-rabbitmq", "taiga-async-rabbitmq", "taiga-back", "taiga-async", "taiga-front", "taiga-events", "taiga-protected", "taiga-gateway", "wiki", "synapse", "element")
    for ($i = 1; $i -le $pullRetries; $i++) {
        Write-Host "  Pull attempt $i of $pullRetries... (timeout: ${pullTimeoutSec}s)" -ForegroundColor DarkGray
        
        # Run pull in background job
        $job = Start-Job -ScriptBlock {
            param($workDir, $svcList)
            Set-Location $workDir
            docker compose pull @svcList
        } -ArgumentList $WorkDir, $services
        
        # Wait for job with timeout
        $completed = Wait-Job -Job $job -Timeout $pullTimeoutSec
        if ($completed) {
            $null = Receive-Job -Job $job
            Remove-Job -Job $job
            if ($LASTEXITCODE -eq 0) {
                $pullSuccess = $true
                Write-Host "  All images pulled successfully" -ForegroundColor Green
                break
            }
        }
        
        # Timeout reached - kill the job
        if (-not $completed) {
            Write-Host "  Pull timed out after ${pullTimeoutSec}s, killing..." -ForegroundColor Yellow
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        
        Write-Host "  Pull failed (attempt $i), retrying in 15s..." -ForegroundColor Yellow
        Start-Sleep -Seconds 15
    }

    if (-not $pullSuccess) {
        ErrorExit "Failed to pull Docker images after $pullRetries attempts. Check network connection."
    }

    Write-Host "  Starting containers..." -ForegroundColor DarkGray
    docker compose up -d taiga-db taiga-events-rabbitmq taiga-async-rabbitmq taiga-back taiga-async taiga-front taiga-events taiga-protected taiga-gateway wiki synapse element
    Pop-Location

    # Wait for services
    $taigaReady = Wait-For-Service -Name "Taiga" -Url "http://localhost:$($script:TAIGA_GATEWAY_PORT)" -MaxWaitSec 300
    $matrixReady = Wait-For-Service -Name "Matrix" -Url "http://localhost:$($script:SYNAPSE_PORT)" -MaxWaitSec 120
    $wikiReady = Wait-For-Service -Name "Wiki.js" -Url "http://localhost:$($script:WIKI_PORT)" -MaxWaitSec 180

    Write-Host ""

    if (-not $taigaReady) {
        Warn "Taiga did not start in time. Run .\init-admin-users.ps1 after startup."
    }
    if (-not $matrixReady) {
        Warn "Matrix did not start in time. Run .\init-admin-users.ps1 after startup."
    }

    # Run init script to auto-create users and get tokens
    if ($taigaReady -or $matrixReady) {
           Step "Running account bootstrap..."
        $initOk = Invoke-InitAdminUsers -WorkDir $WorkDir

        if (-not $initOk) {
            Warn "Account bootstrap did not complete automatically."
        }

        # Reload .env to pick up new tokens
        Load-EnvFromFile
    }

    Write-Host ""
}

# Load tokens from .env back into script vars
function Load-EnvFromFile {
    $workDir = Get-WorkDir
    $envPath = Join-Path $workDir ".env"
    if (Test-Path $envPath) {
        Get-Content $envPath | ForEach-Object {
            if ($_ -match '^([^=]+)=(.*)$') {
                $key = $matches[1].Trim()
                $value = $matches[2].Trim()
                switch ($key) {
                    "TAIGA_API_KEY" { $script:TAIGA_API_KEY = $value }
                    "TAIGA_PROJECT_SLUG" { $script:TAIGA_PROJECT_SLUG = $value }
                    "MATRIX_BOT_TOKEN" { $script:MATRIX_BOT_TOKEN = $value }
                    "MATRIX_ADMIN_USER_ID" { $script:MATRIX_ADMIN_USER_ID = $value }
                    "WIKI_JWT_TOKEN" { $script:WIKI_JWT_TOKEN = $value }
                    "CONTEXT7_API_KEY" { $script:CONTEXT7_API_KEY = $value }
                    "LLM_PROVIDER" { $script:LLM_PROVIDER = $value }
                    "LLM_API_KEY" { $script:LLM_API_KEY = $value }
                    "LLM_BASE_URL" { $script:LLM_BASE_URL = $value }
                    "LLM_MODEL" { $script:LLM_MODEL = $value }
                    "ADMIN_USER" { $script:ADMIN_USER = $value }
                    "ADMIN_PASSWORD" { $script:ADMIN_PASSWORD = $value }
                }
            }
        }
    }
}

# ─── Build worker + orchestrator images ─────────────────────────────────────────
function Build-AllImages {
    Step "Building Docker images..."
    $WorkDir = Get-WorkDir

    # Worker image
    docker build -t turing-worker-base:latest -f "$WorkDir/base-worker/Dockerfile" "$WorkDir/base-worker"
    if ($LASTEXITCODE -eq 0) { Log "Worker base image built" } else { Warn "Worker image build had issues" }

    # Orchestrator image
    docker build -t turing-orchestrator:latest -f "$WorkDir/orchestrator/Dockerfile" "$WorkDir/orchestrator"
    if ($LASTEXITCODE -eq 0) { Log "Orchestrator image built" } else { Warn "Orchestrator image build had issues" }
}

# ─── Final start + verify ─────────────────────────────────────────────────────────
function Final-StartAndVerify {
    $WorkDir = Get-WorkDir

    # Start orchestrator
    SectionHeader "STARTING ORCHESTRATOR"
    Push-Location $WorkDir
    docker compose up -d turing-orchestrator 2>$null
    Pop-Location

    Wait-For-Service -Name "Orchestrator" -Url "http://localhost:$($script:ORCHESTRATOR_PORT)/health" -MaxWaitSec 60

    Verify-Installation
    Print-Summary
    Log "Installation complete!"
}

# Main
function Main {
    Banner
    Write-Host "Welcome to Turing OS Installer v$VERSION" -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to abort at any time." -ForegroundColor DarkGray
    Write-Host ""

    if (-not $SkipPrerequisites) { Check-Prerequisites }

    # 1. Prepare source
    SectionHeader "PREPARING SOURCE"
    New-Item -ItemType Directory -Path "$INSTALL_DIR\turing-os" -Force | Out-Null
    Clone-Source

    # 2. Configure admin (single credentials for ALL services: Taiga, Matrix, Wiki.js)
    SectionHeader "CONFIGURE ADMIN"
    Configure-Admin

    # 3. Configure ports
    SectionHeader "CONFIGURE PORTS"
    Configure-Ports
    Initialize-WikiJsAndGetToken
    Start-InfraAndInitUsers   # <-- Taiga/Matrix start here, tokens auto-filled

    # 4. Quick config (these don't need services)
    SectionHeader "CONFIGURE LLM"
    Configure-LLM

    SectionHeader "CONFIGURE WORKER"
    Configure-Worker

    SectionHeader "CONFIGURE GITHUB"
    Configure-GitHub

    # Optional Context7
    Configure-Context7

    # Regenerate .env with all values now filled
    Step "Updating .env with all configuration..."
    Generate-Env

    # 4. Build images
    Build-AllImages

    # 5. Final start
    Final-StartAndVerify
}

# Run
Main
