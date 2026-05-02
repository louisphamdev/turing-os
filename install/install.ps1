# Turing OS Installer for Windows (PowerShell)
# Usage: Set-ExecutionPolicy Bypass -Scope Process -Force; iwr https://turing-os.ai/install.ps1 | iex

param(
    [switch]$SkipPrerequisites
)

$VERSION = "1.0.0"
$INSTALL_DIR = "$env:USERPROFILE\.turing-os"

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

function Banner {
    Write-Host ""
    Write-Host "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    Write-Host "${BLUE}║                                                      ║${NC}"
    Write-Host -NoNewline "${BLUE}║   ${GREEN}███████╗██╗  ██╗███████╗████████╗███████╗███╗   ███╗   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host -NoNewline "${BLUE}║   ${GREEN}██╔════╝╚██╗██╔╝██╔════╝╚══██╔══╝██╔════╝████╗ ████║   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host -NoNewline "${BLUE}║   ${GREEN}███████╗ ╚███╔╝ ███████╗   ██║   █████╗  ██╔████╔██║   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host -NoNewline "${BLUE}║   ${GREEN}╚════██║ ██╔██╗ ╚════██║   ██║   ██╔══╝  ██║╚██╔╝██║   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host -NoNewline "${BLUE}║   ${GREEN}███████║██╔╝ ██╗███████║   ██║   ███████╗██║ ╚═╝ ██║   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host -NoNewline "${BLUE}║   ${GREEN}╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝   ${BLUE} ║${NC}"
    Write-Host ""
    Write-Host "${BLUE}║                                                      ║${NC}"
    Write-Host -NoNewline "${BLUE}║     ${YELLOW}Multi-Agent IT Department OS  v${VERSION}${BLUE}             ║${NC}"
    Write-Host ""
    Write-Host "${BLUE}║                                                      ║${NC}"
    Write-Host "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    Write-Host ""
}

function Prompt {
    param(
        [string]$Label,
        [string]$Default = "",
        [switch]$Password,
        [switch]$Confirm
    )
    
    if ($Default) {
        Write-Host -NoNewline "${CYAN}${Label}${NC} [${Default}]: "
    } else {
        Write-Host -NoNewline "${CYAN}${Label}${NC}: "
    }
    
    if ($Password) {
        $secPw = Read-Host -AsSecureString
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw))
        Write-Host
        if ($Confirm) {
            Write-Host -NoNewline "${CYAN}Confirm password${NC}: "
            $secPw2 = Read-Host -AsSecureString
            $pw2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPw2))
            Write-Host
            if ($pw -ne $pw2) {
                Warn "Passwords don't match. Try again."
                return Prompt -Label $Label -Password -Confirm
            }
        }
        return $pw
    } else {
        $input = Read-Host
        if ([string]::IsNullOrEmpty($input)) { $input = $Default }
        return $input
    }
}

function Select-Option {
    param([string]$Prompt, [array]$Options, [int]$Default = 1)
    Write-Host "${CYAN}${Prompt}${NC}"
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $num = $i + 1
        $marker = if ($num -eq $Default) { "← default" } else { "" }
        Write-Host "  $num) $($Options[$i]) $marker"
    }
    $choice = Read-Host
    if ([string]::IsNullOrEmpty($choice)) { $choice = $Default }
    return [int]$choice
}

function YesNo {
    param([string]$Prompt, [int]$Default = 1)
    $options = @("No", "Yes")
    $choice = Select-Option -Prompt $Prompt -Options $options -Default $Default
    return ($choice -eq 2)
}

# ============================================
# AUTO-DETECTION FUNCTIONS
# ============================================

function Test-Service {
    param([string]$Url, [int]$TimeoutSec = 3)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Auto-Detect-Plane {
    Step "Detecting Plane..."
    $planeUrl = "http://localhost:$script:PLANE_API_PORT"
    
    if (-not (Test-Service "$planeUrl/api/v1/workspaces")) {
        Warn "Plane not responding at $planeUrl"
        return $null
    }
    
    Write-Host "  Plane detected! Attempting to create API token..."
    
    # Try to create token via Plane API
    # Note: This requires Plane to be fully set up with admin user
    try {
        # First, try to get workspaces to verify connection
        $workspaces = Invoke-RestMethod -Uri "$planeUrl/api/v1/workspaces" -TimeoutSec 10 -ErrorAction SilentlyContinue
        
        if ($workspaces) {
            Write-Host "  ${GREEN}Plane is accessible${NC}"
            Write-Host "  Please create API token manually:"
            Write-Host "    1. Go to $planeUrl/settings/api-tokens"
            Write-Host "    2. Create new token with name 'turing-os'"
            Write-Host "    3. Copy the token value"
            
            # Return detected URL but no token
            return @{
                Url = $planeUrl
                WorkspaceId = $workspaces[0].id
                Token = $null
                ManualRequired = $true
            }
        }
    } catch {
        Write-Host "  ${YELLOW}Could not auto-create token (requires existing admin session)${NC}"
        Write-Host "  Please create token manually in Plane UI"
    }
    
    return @{
        Url = $planeUrl
        WorkspaceId = $null
        Token = $null
        ManualRequired = $true
    }
}

function Auto-Detect-Revolt {
    Step "Detecting Revolt..."
    $revoltUrl = "http://localhost:$script:REVOLT_PORT"
    
    if (-not (Test-Service $revoltUrl)) {
        Warn "Revolt not responding at $revoltUrl"
        return $null
    }
    
    Write-Host "  ${GREEN}Revolt detected!${NC}"
    Write-Host "  Creating bot via Revolt API..."
    
    # Try to create bot via Revolt API
    try {
        # Revolt API endpoint for creating bots
        $botCreateUrl = "$revoltUrl/api/bots/create"
        
        Write-Host "  Bot creation requires:"
        Write-Host "    1. Go to $revoltUrl"
        Write-Host "    2. Settings → User Management → Create Bot"
        Write-Host "    3. Name it 'turing-os' and copy the token"
        
        return @{
            Url = $revoltUrl
            BotToken = $null
            AdminId = $null
            ManualRequired = $true
        }
    } catch {
        Write-Host "  ${YELLOW}Could not auto-create bot${NC}"
    }
    
    return @{
        Url = $revoltUrl
        BotToken = $null
        AdminId = $null
        ManualRequired = $true
    }
}

function Auto-Detect-BookStack {
    Step "Detecting BookStack..."
    $bookstackUrl = "http://localhost:$script:BOOKSTACK_PORT"
    
    if (-not (Test-Service $bookstackUrl)) {
        Warn "BookStack not responding at $bookstackUrl"
        return $null
    }
    
    Write-Host "  ${GREEN}BookStack detected!${NC}"
    Write-Host "  Attempting to create API token..."
    
    # Try to create token via BookStack API
    try {
        # BookStack API for token creation requires authentication
        # This typically requires logging in first
        Write-Host "  ${YELLOW}API token creation requires existing session${NC}"
        Write-Host "  Please create token manually:"
        Write-Host "    1. Go to $bookstackUrl/settings/api-tokens"
        Write-Host "    2. Create new token with name 'turing-os'"
        Write-Host "    3. Copy Token ID and Token Secret"
        
        return @{
            Url = $bookstackUrl
            Token = $null
            ManualRequired = $true
        }
    } catch {
        Write-Host "  ${YELLOW}Could not auto-create token${NC}"
    }
    
    return @{
        Url = $bookstackUrl
        Token = $null
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
        Log "Docker $dockerVersion ✓"
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
        Log "Docker Compose ✓"
    } elseif (docker compose version 2>$null) {
        Log "Docker Compose (built-in) ✓"
    } else {
        ErrorExit "Docker Compose is not installed."
    }
}

# Configure Ports
function Configure-Ports {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                   PORT CONFIGURATION                  ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:PLANE_API_PORT = Prompt -Label "Plane API Port" -Default "3000"
    $script:PLANE_WEB_PORT = Prompt -Label "Plane Web Port" -Default "80"
    $script:BOOKSTACK_PORT = Prompt -Label "BookStack Port" -Default "6875"
    $script:REVOLT_PORT = Prompt -Label "Revolt Port" -Default "8080"
    $script:ORCHESTRATOR_PORT = Prompt -Label "Orchestrator Port" -Default "3001"
    
    Log "Ports configured"
}

# Configure LLM
function Configure-LLM {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  LLM CONFIGURATION                     ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $providers = @("OpenAI (GPT-4, GPT-4o)", "Anthropic (Claude 3.5, 3.7)", "DeepSeek (V3, R1)", "Ollama (local)", "Custom (OpenAI-compatible)")
    $choice = Select-Option "Select LLM Provider:" -Options $providers -Default 1
    
    switch ($choice) {
        1 { 
            $script:LLM_PROVIDER = "openai"
            $script:LLM_BASE_URL = "https://api.openai.com/v1"
            $script:LLM_MODEL = Prompt -Label "Model" -Default "gpt-4o"
        }
        2 { 
            $script:LLM_PROVIDER = "anthropic"
            $script:LLM_BASE_URL = "https://api.anthropic.com"
            $script:LLM_MODEL = Prompt -Label "Model" -Default "claude-3-5-sonnet-20241002"
        }
        3 { 
            $script:LLM_PROVIDER = "deepseek"
            $script:LLM_BASE_URL = "https://api.deepseek.com/v1"
            $script:LLM_MODEL = Prompt -Label "Model" -Default "deepseek-chat"
        }
        4 { 
            $script:LLM_PROVIDER = "ollama"
            $script:LLM_BASE_URL = "http://localhost:11434/v1"
            $script:LLM_MODEL = Prompt -Label "Model" -Default "llama3.2"
        }
        5 { 
            $script:LLM_PROVIDER = "custom"
            $script:LLM_BASE_URL = Prompt -Label "Base URL"
            $script:LLM_MODEL = Prompt -Label "Model" -Default "gpt-4o"
        }
    }
    
    $script:LLM_API_KEY = Prompt -Label "LLM API Key" -Password
    
    Log "LLM: $script:LLM_PROVIDER / $script:LLM_MODEL"
}

# Configure Plane
function Configure-Plane {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  PLANE CONFIGURATION                  ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:PLANE_URL = Prompt -Label "Plane URL" -Default "http://localhost:$script:PLANE_API_PORT"
    
    # Auto-detect Plane
    $autoDetected = Auto-Detect-Plane -Url $script:PLANE_URL
    
    if ($autoDetected) {
        if (-not [string]::IsNullOrEmpty($autoDetected.WorkspaceId)) {
            Write-Host "  ${GREEN}Auto-detected workspace: $($autoDetected.WorkspaceId)${NC}"
            $script:PLANE_WORKSPACE_ID = Prompt -Label "Workspace ID" -Default $autoDetected.WorkspaceId
        } else {
            $script:PLANE_WORKSPACE_ID = Prompt -Label "Workspace ID"
        }
        
        if ($autoDetected.ManualRequired) {
            Write-Host ""
            $script:PLANE_API_KEY = Prompt -Label "Plane API Key"
        } else {
            $script:PLANE_API_KEY = $autoDetected.Token
        }
    } else {
        $script:PLANE_API_KEY = Prompt -Label "Plane API Key"
        $script:PLANE_WORKSPACE_ID = Prompt -Label "Workspace ID"
    }
    
    if ([string]::IsNullOrEmpty($script:PLANE_API_KEY)) {
        Warn "Plane API key is required for ticket management."
    } else {
        Log "Plane configured"
    }
}

# Configure Revolt
function Configure-Revolt {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  REVOLT CONFIGURATION                  ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:REVOLT_URL = Prompt -Label "Revolt URL" -Default "http://localhost:$script:REVOLT_PORT"
    $script:REVOLT_BOT_TOKEN = Prompt -Label "Revolt Bot Token"
    $script:REVOLT_ADMIN_ID = Prompt -Label "Admin User ID (for alerts)"
    
    if ([string]::IsNullOrEmpty($script:REVOLT_BOT_TOKEN)) {
        Warn "Revolt bot token not set. Human-in-the-loop alerts disabled."
    } else {
        Log "Revolt configured"
    }
}

# Configure BookStack
function Configure-BookStack {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                BOOKSTACK CONFIGURATION                  ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:BOOKSTACK_URL = Prompt -Label "BookStack URL" -Default "http://localhost:$script:BOOKSTACK_PORT"
    $script:BOOKSTACK_API_TOKEN = Prompt -Label "BookStack API Token"
    
    if ([string]::IsNullOrEmpty($script:BOOKSTACK_API_TOKEN)) {
        Warn "BookStack API token not set. Some features may be limited."
    } else {
        Log "BookStack configured"
    }
}

# Configure Context7
function Configure-Context7 {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                CONTEXT7 CONFIGURATION                   ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    Write-Host "  Context7 provides up-to-date documentation for tech research."
    Write-Host ""
    
    $script:CONTEXT7_API_KEY = Prompt -Label "Context7 API Key (skip if none)"
    
    if ([string]::IsNullOrEmpty($script:CONTEXT7_API_KEY)) {
        Warn "Context7 API key not set. Tech research will use fallback."
    } else {
        Log "Context7 configured"
    }
}

# Configure Worker
function Configure-Worker {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                 WORKER CONFIGURATION                    ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:WORKER_TIMEOUT = Prompt -Label "Worker Timeout (minutes)" -Default "15"
    $script:ZOMBIE_CHECK = Prompt -Label "Zombie Check Interval (minutes)" -Default "5"
    $script:MAX_WORKERS = Prompt -Label "Max Workers" -Default "5"
    
    Write-Host ""
    Write-Host "  Execution Mode:"
    $modeOptions = @("Sequential (one task at a time)", "Parallel (multiple workers)")
    $modeChoice = Select-Option "Select execution mode:" -Options $modeOptions -Default 1
    
    $script:EXECUTION_MODE = if ($modeChoice -eq 1) { "sequential" } else { "parallel" }
    
    Log "Worker configured: $script:EXECUTION_MODE mode, max $script:MAX_WORKERS workers"
}

# Configure GitHub (Doctor Feedback)
function Configure-GitHub {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃              GITHUB CONFIGURATION (DOCTOR)              ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    Write-Host "  Doctor uses GitHub Issues for bug reports and feedback."
    Write-Host "  Repository: https://github.com/louisphamdev/turing-os"
    Write-Host ""
    
    $script:GITHUB_REPO = Prompt -Label "GitHub Repository" -Default "louisphamdev/turing-os"
    $script:GITHUB_ISSUE_URL = "https://github.com/$script:GITHUB_REPO/issues/new"
    
    Log "GitHub: https://github.com/$script:GITHUB_REPO"
}

# Configure Admin
function Configure-Admin {
    Write-Host ""
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${YELLOW}┃                  ADMIN CONFIGURATION                    ┃${NC}"
    Write-Host "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    
    $script:ADMIN_USER = Prompt -Label "Admin Username" -Default "admin"
    $script:ADMIN_PASSWORD = Prompt -Label "Admin Password" -Password -Confirm
    
    Log "Admin configured"
}

# Generate docker-compose.override.yml
function Generate-DockerCompose {
    Step "Generating docker-compose configuration..."
    
    $overrideContent = @"
version: '3.8'

services:
  plane-api:
    ports:
      - "${PLANE_API_PORT}:3000"

  plane-web:
    ports:
      - "${PLANE_WEB_PORT}:80"

  bookstack:
    ports:
      - "${BOOKSTACK_PORT}:6875"

  revolt:
    ports:
      - "${REVOLT_PORT}:8080"

  orchestrator:
    ports:
      - "${ORCHESTRATOR_PORT}:3000"
"@
    
    $overrideContent | Out-File -FilePath "$INSTALL_DIR\turing-os\docker-compose.override.yml" -Encoding UTF8
    Log "Docker Compose ports configured"
}

# Generate .env file
function Generate-Env {
    Step "Generating environment file..."
    
    $envContent = @"
# Turing OS Environment Configuration
# Generated by installer on $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

# ============================================
# LLM CONFIGURATION
# ============================================
LLM_PROVIDER=$LLM_PROVIDER
LLM_API_KEY=$LLM_API_KEY
LLM_BASE_URL=$LLM_BASE_URL
LLM_MODEL=$LLM_MODEL

# ============================================
# PLANE CONFIGURATION
# ============================================
PLANE_URL=$PLANE_URL
PLANE_API_KEY=$PLANE_API_KEY
PLANE_WORKSPACE_ID=$PLANE_WORKSPACE_ID

# ============================================
# REVOLT CONFIGURATION (Human-in-the-Loop)
# ============================================
REVOLT_URL=$REVOLT_URL
REVOLT_BOT_TOKEN=$REVOLT_BOT_TOKEN
REVOLT_ADMIN_USER_ID=$REVOLT_ADMIN_ID

# ============================================
# BOOKSTACK CONFIGURATION (Secrets & Docs)
# ============================================
BOOKSTACK_URL=$BOOKSTACK_URL
BOOKSTACK_API_TOKEN=$BOOKSTACK_API_TOKEN

# ============================================
# CONTEXT7 CONFIGURATION (Tech Research)
# ============================================
CONTEXT7_API_KEY=$CONTEXT7_API_KEY

# ============================================
# WORKER CONFIGURATION
# ============================================
WORKER_IMAGE=turing-worker-base:latest
WORKER_TIMEOUT_MINUTES=$WORKER_TIMEOUT
ZOMBIE_CHECK_INTERVAL_MINUTES=$ZOMBIE_CHECK
MAX_WORKERS=$MAX_WORKERS
EXECUTION_MODE=$EXECUTION_MODE

# ============================================
# GITHUB CONFIGURATION (Doctor Bug Reports)
# ============================================
GITHUB_REPO=louisphamdev/turing-os
GITHUB_ISSUE_URL=https://github.com/louisphamdev/turing-os/issues/new

# ============================================
# ADMIN CONFIGURATION
# ============================================
ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD

# ============================================
# DOCKER CONFIGURATION
# ============================================
DOCKER_HOST=unix:///var/run/docker.sock
"@
    
    $envContent | Out-File -FilePath "$INSTALL_DIR\turing-os\.env" -Encoding UTF8
    Log "Environment file generated"
}

# Build images
function Build-Images {
    Step "Building Docker images..."
    
    Set-Location "$INSTALL_DIR\turing-os"
    
    Log "Building worker base image..."
    docker build -t turing-worker-base:latest .\base-worker
    
    Log "Building orchestrator image..."
    docker build -t turing-orchestrator:latest .\orchestrator
    
    Log "Images built successfully"
}

# Start services
function Start-Services {
    Step "Starting services..."
    
    Set-Location "$INSTALL_DIR\turing-os"
    
    # Create data directories
    $dataPath = Join-Path $INSTALL_DIR "turing-os\data"
    @("plane", "bookstack", "minio") | ForEach-Object {
        $dir = Join-Path $dataPath $_
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    
    # Start services
    docker compose up -d
    
    Log "Services started"
}

# Verify
function Verify-Installation {
    Step "Verifying installation..."
    Write-Host ""
    
    $ports = @($PLANE_API_PORT, $PLANE_WEB_PORT, $BOOKSTACK_PORT, $REVOLT_PORT, $ORCHESTRATOR_PORT)
    $allOk = $true
    
    foreach ($port in $ports) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$port" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($response.StatusCode -in 200, 302, 404) {
                Log "Port $port responding"
            } else {
                Warn "Port $port returned status $($response.StatusCode)"
                $allOk = $false
            }
        } catch {
            Warn "Port $port not responding yet"
            $allOk = $false
        }
    }
    
    Write-Host ""
    if ($allOk) {
        Log "All services verified!"
    } else {
        Warn "Some services may still be starting. Check: docker compose logs"
    }
}

# Print summary
function Print-Summary {
    Write-Host ""
    Write-Host "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${GREEN}┃                    INSTALLATION COMPLETE                      ┃${NC}"
    Write-Host "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
    Write-Host "${YELLOW}Access URLs:${NC}"
    Write-Host "  • Plane API:       http://localhost:${PLANE_API_PORT}"
    Write-Host "  • Plane Web:       http://localhost:${PLANE_WEB_PORT}"
    Write-Host "  • BookStack:       http://localhost:${BOOKSTACK_PORT}"
    Write-Host "  • Revolt:          http://localhost:${REVOLT_PORT}"
    Write-Host "  • Orchestrator:    http://localhost:${ORCHESTRATOR_PORT}"
    Write-Host ""
    Write-Host "${YELLOW}Credentials:${NC}"
    Write-Host "  • Admin User:      $ADMIN_USER"
    Write-Host "  • Admin Password:  [hidden]"
    Write-Host ""
    Write-Host "${YELLOW}Next Steps:${NC}"
    Write-Host "  1. Configure Plane webhooks: $PLANE_URL/settings/webhooks"
    Write-Host "  2. Create BookStack secrets page with CONTEXT7_API_KEY"
    Write-Host "  3. Run: cd $INSTALL_DIR\turing-os; docker compose logs -f"
    Write-Host ""
    Write-Host "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Main
function Main {
    Banner
    
    Write-Host "${CYAN}Welcome to Turing OS Installer v${VERSION}${NC}" -NoNewline
    Write-Host ""
    Write-Host "Press Ctrl+C to abort at any time."
    Write-Host ""
    
    if (-not $SkipPrerequisites) {
        Check-Prerequisites
    }
    
    Configure-Ports
    Configure-LLM
    Configure-Plane
    Configure-Revolt
    Configure-BookStack
    Configure-Context7
    Configure-Worker
    Configure-GitHub
    Configure-Admin
    
    Step "Preparing installation directory..."
    New-Item -ItemType Directory -Path "$INSTALL_DIR\turing-os" -Force | Out-Null
    
    Generate-DockerCompose
    Generate-Env
    Build-Images
    Start-Services
    Verify-Installation
    Print-Summary
    
    Log "Installation complete!"
}

# Run
Main