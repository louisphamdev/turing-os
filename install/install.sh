#!/bin/bash
# Turing OS Installer for macOS/Linux
# Usage: curl -sSL https://turing-os.ai/install.sh | bash

set -e

VERSION="1.0.0"
INSTALL_DIR="${HOME}/.turing-os"
MIN_DOCKER_VERSION="20.10.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Banner
banner() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                      ║${NC}"
    echo -e "${BLUE}║   ${GREEN}███████╗██╗  ██╗███████╗████████╗███████╗███╗   ███╗   ${BLUE} ║${NC}"
    echo -e "${BLUE}║   ${GREEN}██╔════╝╚██╗██╔╝██╔════╝╚══██╔══╝██╔════╝████╗ ████║   ${BLUE} ║${NC}"
    echo -e "${BLUE}║   ${GREEN}███████╗ ╚███╔╝ ███████╗   ██║   █████╗  ██╔████╔██║   ${BLUE} ║${NC}"
    echo -e "${BLUE}║   ${GREEN}╚════██║ ██╔██╗ ╚════██║   ██║   ██╔══╝  ██║╚██╔╝██║   ${BLUE} ║${NC}"
    echo -e "${BLUE}║   ${GREEN}███████║██╔╝ ██╗███████║   ██║   ███████╗██║ ╚═╝ ██║   ${BLUE} ║${NC}"
    echo -e "${BLUE}║   ${GREEN}╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝╚═╝     ╚═╝   ${BLUE} ║${NC}"
    echo -e "${BLUE}║                                                      ║${NC}"
    echo -e "${BLUE}║     ${YELLOW}Multi-Agent IT Department OS  v${VERSION}${BLUE}             ║${NC}"
    echo -e "${BLUE}║                                                      ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Helper functions
log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
step() { echo -e "${BLUE}[→]${NC} $1"; }

# Prompt for input with default
prompt() {
    local label="$1"
    local default="$2"
    local password="$3"
    
    if [ -n "$default" ]; then
        echo -ne "${CYAN}${label}${NC} [${default}]: "
    else
        echo -ne "${CYAN}${label}${NC}: "
    fi
    
    if [ "$password" = "password" ]; then
        read -s REPLY
        echo
    else
        read REPLY
        [ -z "$REPLY" ] && REPLY="$default"
    fi
}

# Prompt for password (no echo)
prompt_password() {
    local label="$1"
    local confirm="$2"
    
    while true; do
        echo -ne "${CYAN}${label}${NC}: "
        read -s PW1
        echo
        
        if [ "$confirm" = "confirm" ]; then
            echo -ne "${CYAN}Confirm password${NC}: "
            read -s PW2
            echo
            
            if [ "$PW1" != "$PW2" ]; then
                warn "Passwords don't match. Try again."
                continue
            fi
        fi
        
        break
    done
    
    REPLY="$PW1"
}

# Check prerequisites
check_prerequisites() {
    step "Checking prerequisites..."
    
    # Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed."
        echo "    Install: https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "0")
    if [ "$(printf '%s\n' "$MIN_DOCKER_VERSION" "$DOCKER_VERSION" | sort -V | head -n1)" != "$MIN_DOCKER_VERSION" ]; then
        error "Docker $MIN_DOCKER_VERSION+ required. You have: $DOCKER_VERSION"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        error "Docker is not running."
        exit 1
    fi
    log "Docker $DOCKER_VERSION ✓"
    
    # Docker Compose
    if command -v docker-compose &> /dev/null; then
        log "Docker Compose ✓"
    elif docker compose version &> /dev/null; then
        log "Docker Compose (built-in) ✓"
    else
        error "Docker Compose is not installed."
        exit 1
    fi
    
    # Git (optional)
    if command -v git &> /dev/null; then
        log "Git ✓"
    else
        warn "Git not found. Manual setup required."
    fi
}

# Configure ports
configure_ports() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                   PORT CONFIGURATION                  ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "Plane API Port" "3000" && PLANE_API_PORT="$REPLY"
    prompt "Plane Web Port" "80" && PLANE_WEB_PORT="$REPLY"
    prompt "BookStack Port" "6875" && BOOKSTACK_PORT="$REPLY"
    prompt "Revolt Port" "8080" && REVOLT_PORT="$REPLY"
    prompt "Orchestrator Port" "3001" && ORCHESTRATOR_PORT="$REPLY"
    
    log "Ports configured"
}

# Configure LLM
configure_llm() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  LLM CONFIGURATION                     ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    echo "  Select LLM Provider:"
    echo "    1) OpenAI (GPT-4, GPT-4o)"
    echo "    2) Anthropic (Claude 3.5, 3.7)"
    echo "    3) DeepSeek (V3, R1)"
    echo "    4) Ollama (local)"
    echo "    5) Custom (OpenAI-compatible)"
    echo ""
    prompt "Choice" "1"
    
    case "$REPLY" in
        1) LLM_PROVIDER="openai"; LLM_BASE_URL="https://api.openai.com/v1"; prompt "Model" "gpt-4o" && LLM_MODEL="$REPLY" ;;
        2) LLM_PROVIDER="anthropic"; LLM_BASE_URL="https://api.anthropic.com"; prompt "Model" "claude-3-5-sonnet-20241002" && LLM_MODEL="$REPLY" ;;
        3) LLM_PROVIDER="deepseek"; LLM_BASE_URL="https://api.deepseek.com/v1"; prompt "Model" "deepseek-chat" && LLM_MODEL="$REPLY" ;;
        4) LLM_PROVIDER="ollama"; LLM_BASE_URL="http://localhost:11434/v1"; prompt "Model" "llama3.2" && LLM_MODEL="$REPLY" ;;
        5) LLM_PROVIDER="custom"; prompt "Base URL" "" && LLM_BASE_URL="$REPLY"; prompt "Model" "gpt-4o" && LLM_MODEL="$REPLY" ;;
        *) LLM_PROVIDER="openai"; LLM_BASE_URL="https://api.openai.com/v1"; LLM_MODEL="gpt-4o" ;;
    esac
    
    prompt_password "LLM API Key" && LLM_API_KEY="$REPLY"
    
    log "LLM: $LLM_PROVIDER / $LLM_MODEL"
}

# Configure Plane
configure_plane() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  PLANE CONFIGURATION                  ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "Plane URL" "http://localhost:$PLANE_API_PORT" && PLANE_URL="$REPLY"
    prompt "Plane API Key" "" && PLANE_API_KEY="$REPLY"
    prompt "Plane Workspace ID" "" && PLANE_WORKSPACE_ID="$REPLY"
    
    if [ -z "$PLANE_API_KEY" ]; then
        warn "Plane API key is required for ticket management."
    else
        log "Plane configured"
    fi
}

# Configure Revolt
configure_revolt() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  REVOLT CONFIGURATION                  ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "Revolt URL" "http://localhost:$REVOLT_PORT" && REVOLT_URL="$REPLY"
    prompt "Revolt Bot Token" "" && REVOLT_BOT_TOKEN="$REPLY"
    prompt "Admin User ID (for alerts)" "" && REVOLT_ADMIN_ID="$REPLY"
    
    if [ -z "$REVOLT_BOT_TOKEN" ]; then
        warn "Revolt bot token not set. Human-in-the-loop alerts disabled."
    else
        log "Revolt configured"
    fi
}

# Configure BookStack
configure_bookstack() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                BOOKSTACK CONFIGURATION                  ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "BookStack URL" "http://localhost:$BOOKSTACK_PORT" && BOOKSTACK_URL="$REPLY"
    prompt "BookStack API Token" "" && BOOKSTACK_API_TOKEN="$REPLY"
    
    if [ -z "$BOOKSTACK_API_TOKEN" ]; then
        warn "BookStack API token not set. Some features may be limited."
    else
        log "BookStack configured"
    fi
}

# Configure Context7
configure_context7() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                CONTEXT7 CONFIGURATION                   ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  Context7 provides up-to-date documentation for tech research."
    echo ""
    
    prompt "Context7 API Key (skip if none)" "" && CONTEXT7_API_KEY="$REPLY"
    
    if [ -z "$CONTEXT7_API_KEY" ]; then
        warn "Context7 API key not set. Tech research will use fallback."
    else
        log "Context7 configured"
    fi
}

# Configure Worker
configure_worker() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                 WORKER CONFIGURATION                    ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "Worker Timeout (minutes)" "15" && WORKER_TIMEOUT="$REPLY"
    prompt "Zombie Check Interval (minutes)" "5" && ZOMBIE_CHECK="$REPLY"
    prompt "Max Workers" "5" && MAX_WORKERS="$REPLY"
    
    echo ""
    echo "  Execution Mode:"
    echo "    1) Sequential (one task at a time)"
    echo "    2) Parallel (multiple workers)"
    echo ""
    prompt "Choice" "1"
    
    case "$REPLY" in
        1) EXECUTION_MODE="sequential" ;;
        2) EXECUTION_MODE="parallel" ;;
        *) EXECUTION_MODE="sequential" ;;
    esac
    
    log "Worker configured: $EXECUTION_MODE mode, max $MAX_WORKERS workers"
}

# Configure Email (for Doctor bug reports)
# Configure GitHub (Doctor Feedback)
configure_github() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃              GITHUB CONFIGURATION (DOCTOR)              ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "  Doctor uses GitHub Issues for bug reports and feedback."
    echo "  Repository: https://github.com/louisphamdev/turing-os"
    echo ""
    
    prompt "GitHub Repository" "louisphamdev/turing-os" && GITHUB_REPO="$REPLY"
    GITHUB_ISSUE_URL="https://github.com/$GITHUB_REPO/issues/new"
    
    log "GitHub: https://github.com/$GITHUB_REPO"
}

# Configure Admin
configure_admin() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  ADMIN CONFIGURATION                    ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    prompt "Admin Username" "admin" && ADMIN_USER="$REPLY"
    prompt_password "Admin Password" "confirm" && ADMIN_PASSWORD="$REPLY"
    
    log "Admin configured"
}

# Generate docker-compose override
generate_docker_compose() {
    step "Generating docker-compose configuration..."
    
    cat > "$INSTALL_DIR/turing-os/docker-compose.override.yml" << EOF
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
EOF

    log "Docker Compose ports configured"
}

# Generate .env file
generate_env() {
    step "Generating environment file..."
    
    cat > "$INSTALL_DIR/turing-os/.env" << EOF
# Turing OS Environment Configuration
# Generated by installer on $(date)

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
EOF

    log "Environment file generated"
}

# Build images
build_images() {
    step "Building Docker images..."
    
    cd "$INSTALL_DIR/turing-os"
    
    log "Building worker base image..."
    docker build -t turing-worker-base:latest ./base-worker
    
    log "Building orchestrator image..."
    docker build -t turing-orchestrator:latest ./orchestrator
    
    log "Images built successfully"
}

# Start services
start_services() {
    step "Starting services..."
    
    cd "$INSTALL_DIR/turing-os"
    
    # Create data directories
    mkdir -p data/{plane,bookstack,minio}
    
    # Start services
    docker compose up -d
    
    log "Services started"
}

# Verify installation
verify() {
    step "Verifying installation..."
    
    echo ""
    
    local all_ok=true
    
    for port in $PLANE_API_PORT $PLANE_WEB_PORT $BOOKSTACK_PORT $REVOLT_PORT $ORCHESTRATOR_PORT; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" | grep -q "200\|302\|404"; then
            log "Port $port responding"
        else
            warn "Port $port not responding yet"
            all_ok=false
        fi
    done
    
    echo ""
    
    if [ "$all_ok" = true ]; then
        log "All services verified!"
    else
        warn "Some services may still be starting. Check: docker compose logs"
    fi
}

# Print summary
print_summary() {
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}┃                    INSTALLATION COMPLETE                      ┃${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${YELLOW}Access URLs:${NC}"
    echo "  • Plane API:       http://localhost:${PLANE_API_PORT}"
    echo "  • Plane Web:       http://localhost:${PLANE_WEB_PORT}"
    echo "  • BookStack:       http://localhost:${BOOKSTACK_PORT}"
    echo "  • Revolt:          http://localhost:${REVOLT_PORT}"
    echo "  • Orchestrator:    http://localhost:${ORCHESTRATOR_PORT}"
    echo ""
    echo -e "${YELLOW}Credentials:${NC}"
    echo "  • Admin User:      $ADMIN_USER"
    echo "  • Admin Password:  [hidden]"
    echo ""
    echo -e "${YELLOW}Next Steps:${NC}"
    echo "  1. Configure Plane webhooks: $PLANE_URL/settings/webhooks"
    echo "  2. Create BookStack secrets page with CONTEXT7_API_KEY"
    echo "  3. Run: cd $INSTALL_DIR/turing-os && make logs"
    echo ""
    echo -e "${YELLOW}Common Commands:${NC}"
    echo "  • make up         - Start services"
    echo "  • make down       - Stop services"
    echo "  • make logs       - View logs"
    echo "  • make status     - Show status"
    echo "  • make restart    - Restart services"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Main installation
main() {
    banner
    
    echo -e "${CYAN}Welcome to Turing OS Installer v${VERSION}${NC}"
    echo "Press Ctrl+C to abort at any time."
    echo ""
    
    # Run all configuration steps
    check_prerequisites
    configure_ports
    configure_llm
    configure_plane
    configure_revolt
    configure_bookstack
    configure_context7
    configure_worker
    configure_github
    configure_admin
    
    # Create installation directory
    step "Preparing installation directory..."
    mkdir -p "$INSTALL_DIR/turing-os"
    
    # Generate configuration files
    generate_docker_compose
    generate_env
    
    # Build and start
    build_images
    start_services
    verify
    print_summary
    
    log "Installation complete!"
}

# Run
main "$@"