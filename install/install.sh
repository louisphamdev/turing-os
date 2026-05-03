#!/bin/bash
# Turing OS Installer for macOS/Linux
# Usage: bash install/install.sh

set -eo pipefail

VERSION="1.0.0"
INSTALL_DIR="${HOME}/.turing-os"
MIN_DOCKER_VERSION="20.10.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR=""

if [[ -f "$LOCAL_REPO_DIR/docker-compose.yml" ]]; then
    SOURCE_DIR="$LOCAL_REPO_DIR"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Banner
banner() {
    echo ""
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}  Turing OS Installer  v${VERSION}${NC}"
    echo -e "${BLUE}  Multi-Agent IT Department OS${NC}"
    echo -e "${BLUE}============================================================${NC}"
    echo ""
}

# Helpers
log()   { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[X]${NC} $1"; }
step()  { echo -e "${BLUE}[>]${NC} $1"; }

get_work_dir() {
    if [[ -n "$SOURCE_DIR" ]]; then
        printf '%s\n' "$SOURCE_DIR"
    else
        printf '%s\n' "$INSTALL_DIR/turing-os"
    fi
}

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
    log "Docker $DOCKER_VERSION"

    if command -v docker-compose &> /dev/null; then
        log "Docker Compose"
    elif docker compose version &> /dev/null; then
        log "Docker Compose (built-in)"
    else
        error "Docker Compose is not installed."
        exit 1
    fi

    if command -v git &> /dev/null; then
        log "Git"
    else
        warn "Git not found. Manual setup required."
    fi
}

# Configure ports
configure_ports() {
    echo ""
    step "Configuring ports..."
    prompt "Taiga Gateway Port"      "9000"    && TAIGA_GATEWAY_PORT="$REPLY"
    prompt "Wiki.js Port"              "6875"    && WIKI_PORT="$REPLY"
    prompt "Matrix/Synapse Port"     "8008"    && SYNAPSE_PORT="$REPLY"
    prompt "Orchestrator Port"       "3001"    && ORCHESTRATOR_PORT="$REPLY"
    log "Ports configured"
}

# Configure LLM
configure_llm() {
    echo ""
    step "Configuring LLM..."
    echo "  1) OpenAI (GPT-4, GPT-4o)"
    echo "  2) Anthropic (Claude 3.5, 3.7)"
    echo "  3) DeepSeek (V3, R1)"
    echo "  4) Ollama (local)"
    echo "  5) Custom (OpenAI-compatible)"
    echo ""
    prompt "Choice" "1"

    case "$REPLY" in
        1) LLM_PROVIDER="openai";    LLM_BASE_URL="https://api.openai.com/v1";     prompt "Model" "gpt-4o"                      && LLM_MODEL="$REPLY" ;;
        2) LLM_PROVIDER="anthropic"; LLM_BASE_URL="https://api.anthropic.com";       prompt "Model" "claude-3-5-sonnet-20241002" && LLM_MODEL="$REPLY" ;;
        3) LLM_PROVIDER="deepseek";  LLM_BASE_URL="https://api.deepseek.com/v1";     prompt "Model" "deepseek-chat"              && LLM_MODEL="$REPLY" ;;
        4) LLM_PROVIDER="ollama";    LLM_BASE_URL="http://localhost:11434/v1";      prompt "Model" "llama3.2"                   && LLM_MODEL="$REPLY" ;;
        5) LLM_PROVIDER="custom";   prompt "Base URL" ""         && LLM_BASE_URL="$REPLY"; prompt "Model" "gpt-4o" && LLM_MODEL="$REPLY" ;;
        *) LLM_PROVIDER="openai";   LLM_BASE_URL="https://api.openai.com/v1";      LLM_MODEL="gpt-4o" ;;
    esac

    prompt_password "LLM API Key" && LLM_API_KEY="$REPLY"
    log "LLM: $LLM_PROVIDER / $LLM_MODEL"
}

# ─── Initialize Wiki.js and get JWT token ─────────────────────────────────────────
# This is called AFTER admin is configured (ADMIN_USER, ADMIN_PASSWORD are set)
# and AFTER ports are configured (WIKI_PORT is set).
initialize_wiki_and_get_token() {
    echo ""
    step "Initializing Wiki.js..."

        local work_dir
        work_dir="$(get_work_dir)"

        # Start Wiki.js using the current full compose configuration.
    step "Starting Wiki.js container..."
        cd "$work_dir"
    docker compose up -d wiki

    # Wait for Wiki.js to be ready
    local wiki_url="http://localhost:$WIKI_PORT"
    if ! wait_for_service "Wiki.js" "$wiki_url" 180; then
        error_exit "Wiki.js did not start in time. Cannot proceed."
    fi

    # Determine admin email
    local wiki_admin_email="admin@wiki.local"
    if [ -n "$ADMIN_USER" ]; then
        wiki_admin_email="${ADMIN_USER}@wiki.local"
    fi

    # Check if already setup
    local setup_needed=true
    local session_check=$(curl -s --max-time 5 "$wiki_url/api/session" 2>/dev/null)
    if echo "$session_check" | grep -q '"user"'; then
        log "Wiki.js already configured"
        setup_needed=false
    fi

    # Run Wiki.js first-time setup via API
    if [ "$setup_needed" = true ]; then
        step "Running Wiki.js first-time setup..."
        local setup_resp=$(curl -s -X POST "$wiki_url/api/setup" \
            -H "Content-Type: application/json" \
            -d "{\"email\":\"$wiki_admin_email\",\"password\":\"$ADMIN_PASSWORD\"}" \
            --max-time 30 2>/dev/null)

        if echo "$setup_resp" | grep -q '"error"'; then
            warn "Wiki.js setup API call had issues: $setup_resp"
            echo "  Please complete setup manually at $wiki_url"
        else
            log "Wiki.js admin account created"
        fi
    fi

    # ─── Step 1: Try auto-login to get JWT token ───
    step "Attempting automatic token retrieval..."
    local auto_token_success=false

    local login_resp=$(curl -s -X POST "$wiki_url/api/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$wiki_admin_email\",\"password\":\"$ADMIN_PASSWORD\"}" \
        --max-time 15 2>/dev/null)

    if echo "$login_resp" | grep -q '"token"'; then
        WIKI_JWT_TOKEN=$(echo "$login_resp" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"$//')
        if [ -n "$WIKI_JWT_TOKEN" ]; then
            log "Wiki.js JWT token obtained automatically!"
            auto_token_success=true
        fi
    fi

    # ─── Step 2: If auto failed, show step-by-step manual instructions ───
    if [ "$auto_token_success" = false ]; then
        echo ""
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${YELLOW}  WIKI.JS MANUAL TOKEN SETUP (Required)${NC}"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "  ${CYAN}Automatic token retrieval failed. Please follow these steps:${NC}"
        echo ""
        echo -e "  ${GREEN}Step 1:${NC} Open Wiki.js in your browser:"
        echo -e "         ${CYAN}$wiki_url${NC}"
        echo ""
        echo -e "  ${GREEN}Step 2:${NC} Login with your admin credentials:"
        echo -e "         Email:    ${CYAN}$wiki_admin_email${NC}"
        echo -e "         Password: ${CYAN}[the password you entered during setup]${NC}"
        echo ""
        echo -e "  ${GREEN}Step 3:${NC} Go to ${CYAN}Administration${NC} (click your avatar top-right)"
        echo ""
        echo -e "  ${GREEN}Step 4:${NC} Navigate to ${CYAN}Settings → API${NC} (left sidebar)"
        echo ""
        echo -e "  ${GREEN}Step 5:${NC} Scroll down to ${CYAN}API Tokens${NC} section"
        echo ""
        echo -e "  ${GREEN}Step 6:${NC} Click ${CYAN}New Token${NC}"
        echo ""
        echo -e "  ${GREEN}Step 7:${NC} Fill in:"
        echo -e "         - Name: ${CYAN}Turing OS${NC}"
        echo -e "         - Expiry: ${CYAN}Never${NC} (or your preferred duration)"
        echo ""
        echo -e "  ${GREEN}Step 8:${NC} Click ${CYAN}Create${NC}"
        echo ""
        echo -e "  ${GREEN}Step 9:${NC} Copy the ${CYAN}token value${NC} shown (starts with 'eyJ...')"
        echo ""
        echo -e "  ${GREEN}Step 10:${NC} Paste the token below"
        echo ""

        # Try to open browser
        open_browser "$wiki_url"
        echo -e "  Browser opened automatically." && log "Browser opened" || echo "  Please open manually: $wiki_url"

        echo ""

        # Prompt user for token with validation
        while true; do
            echo -ne "  ${CYAN}Enter Wiki.js API Token:${NC} "
            read -r entered_token

            if [ -z "$entered_token" ]; then
                warn "Token cannot be empty. Please enter a valid token or press Ctrl+C to skip."
                continue
            fi

            # Validate token format (should start with eyJ)
            if [[ ! "$entered_token" =~ ^eyJ ]]; then
                warn "Invalid token format. Token should start with 'eyJ...'. Please try again."
                continue
            fi

            # Test the token via GraphQL
            step "Validating token..."
            local test_resp=$(curl -s -X POST "$wiki_url/graphql" \
                -H "Authorization: Bearer $entered_token" \
                -H "Content-Type: application/json" \
                -d '{"query":"{ pages { list(limit: 1) { id title } } }"}' \
                --max-time 10 2>/dev/null)

            if echo "$test_resp" | grep -q '"data"'; then
                WIKI_JWT_TOKEN="$entered_token"
                log "Wiki.js API token validated successfully!"
                break
            else
                warn "Token validation failed. Please check and try again."
            fi
        done
    fi

    # Save token to .env immediately
    if grep -q "WIKI_JWT_TOKEN=" "$work_dir/.env" 2>/dev/null; then
        sed -i "s|^WIKI_JWT_TOKEN=.*|WIKI_JWT_TOKEN=$WIKI_JWT_TOKEN|" "$work_dir/.env"
    else
        echo "WIKI_JWT_TOKEN=$WIKI_JWT_TOKEN" >> "$work_dir/.env"
    fi
    log "Token saved to .env"
}

# Configure Context7
configure_context7() {
    echo ""
    step "Configuring Context7..."
    echo "  Context7 provides up-to-date documentation for tech research."
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
    step "Configuring worker..."
    prompt "Worker Timeout (minutes)"        "15" && WORKER_TIMEOUT="$REPLY"
    prompt "Zombie Check Interval (minutes)" "5"  && ZOMBIE_CHECK="$REPLY"
    prompt "Max Workers"                     "5"  && MAX_WORKERS="$REPLY"

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

    log "Worker: $EXECUTION_MODE mode, max $MAX_WORKERS workers"
}

# Configure GitHub (Doctor bug reports)
configure_github() {
    echo ""
    step "Configuring GitHub..."
    prompt "GitHub Repository" "louisphamdev/turing-os" && GITHUB_REPO="$REPLY"
    GITHUB_ISSUE_URL="https://github.com/$GITHUB_REPO/issues/new"
    log "GitHub: https://github.com/$GITHUB_REPO"
}

# Configure Admin
configure_admin() {
    echo ""
    step "Configuring admin..."
    prompt "Admin Username" "admin" && ADMIN_USER="$REPLY"
    prompt_password "Admin Password" "confirm" && ADMIN_PASSWORD="$REPLY"
    log "Admin configured"
}

# Generate docker-compose override
generate_docker_compose() {
    step "Generating docker-compose override..."
    local work_dir
    work_dir="$(get_work_dir)"

    mkdir -p "$work_dir/element_config"
    cat > "$work_dir/element_config/config.json" << EOF
{
    "default_server_config": {
        "m.homeserver": {
            "base_url": "http://localhost:${SYNAPSE_PORT}",
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
EOF

        cat > "$work_dir/docker-compose.override.yml" << EOF
services:
    taiga-gateway:
        ports:
            - "${TAIGA_GATEWAY_PORT}:80"

    taiga-front:
        environment:
            - TAIGA_URL=http://localhost:${TAIGA_GATEWAY_PORT}
            - TAIGA_WEBSOCKETS_URL=ws://localhost:${TAIGA_GATEWAY_PORT}

    wiki:
        ports:
            - "${WIKI_PORT}:3000"

    synapse:
        ports:
            - "${SYNAPSE_PORT}:8008"

    element:
        ports:
            - "8080:80"
        volumes:
            - ./element_config/config.json:/usr/share/nginx/html/config.json:ro

    turing-orchestrator:
        ports:
            - "${ORCHESTRATOR_PORT}:3001"
EOF
    log "Docker Compose override written"
}

# Generate .env file
generate_env() {
    step "Generating .env file..."
    local work_dir
    work_dir="$(get_work_dir)"

    cat > "$work_dir/.env" << EOF
# Turing OS Environment Configuration
# Generated by installer on $(date)

LLM_PROVIDER=$LLM_PROVIDER
LLM_API_KEY=$LLM_API_KEY
LLM_BASE_URL=$LLM_BASE_URL
LLM_MODEL=$LLM_MODEL

TAIGA_SCHEME=http
TAIGA_DOMAIN=localhost:$TAIGA_GATEWAY_PORT
TAIGA_API_KEY=
TAIGA_PROJECT_SLUG=turing-os
TAIGA_SECRET_KEY=change-me-in-production

POSTGRES_DB=taiga
POSTGRES_USER=taiga
POSTGRES_PASSWORD=taiga_password

RABBITMQ_USER=taiga
RABBITMQ_PASS=taiga_password
RABBITMQ_VHOST=taiga
RABBITMQ_ERLANG_COOKIE=secret-erlang-cookie

SYNAPSE_API_URL=http://localhost:$SYNAPSE_PORT
SYNAPSE_SERVER_NAME=localhost
SYNAPSE_REGISTRATION_SECRET=change-me-in-production
MATRIX_BOT_TOKEN=
MATRIX_ADMIN_USER_ID=

WIKI_URL=http://localhost:$WIKI_PORT
WIKI_JWT_TOKEN=$WIKI_JWT_TOKEN

CONTEXT7_API_KEY=$CONTEXT7_API_KEY

WORKER_IMAGE=turing-worker-base:latest
WORKER_TIMEOUT_MINUTES=$WORKER_TIMEOUT
ZOMBIE_CHECK_INTERVAL_MINUTES=$ZOMBIE_CHECK
MAX_WORKERS=$MAX_WORKERS
EXECUTION_MODE=$EXECUTION_MODE

GITHUB_REPO=$GITHUB_REPO
GITHUB_ISSUE_URL=$GITHUB_ISSUE_URL

ADMIN_USER=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASSWORD

DOCKER_HOST=unix:///var/run/docker.sock
DOCKER_SOCKET_PATH=/var/run/docker.sock
DOCKER_NETWORK=turing-os_turing_network

ORCHESTRATOR_URL=http://turing-orchestrator:3001
PORT=3001
AUTO_START_ROLES=po,pm,hr,doctor

WORKER_HEARTBEAT_INTERVAL_MS=120000
WORKER_STUCK_THRESHOLD_MS=600000
EOF
    log ".env written"
}

# Clone source code
clone_source() {
    step "Downloading source code..."

    if [[ -n "$SOURCE_DIR" ]]; then
        log "Using current repository at $SOURCE_DIR"
        return
    fi

    if command -v git &> /dev/null; then
        if [ -d "$INSTALL_DIR/turing-os/.git" ]; then
            log "Source already exists, pulling latest..."
            cd "$INSTALL_DIR/turing-os" && git pull origin main
        else
            git clone "https://github.com/$GITHUB_REPO.git" "$INSTALL_DIR/turing-os"
        fi
        log "Source ready"
    else
        warn "Git not available. Please clone manually:"
        echo "  git clone https://github.com/$GITHUB_REPO.git $INSTALL_DIR/turing-os"
        read -p "Press Enter when ready..."
    fi
}

# Build images
build_images() {
    step "Building Docker images..."
    cd "$(get_work_dir)"
    docker build -t turing-worker-base:latest ./base-worker
    docker build -t turing-orchestrator:latest ./orchestrator
    log "Images built"
}

# Wait for a service to become healthy
wait_for_service() {
    local name="$1"
    local url="$2"
    local max_wait="${3:-120}"
    local elapsed=0

    echo -n "  Waiting for ${CYAN}$name${NC}..."
    while [ $elapsed -lt $max_wait ]; do
        if curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null | grep -q "200\|302\|404"; then
            echo -e " ${GREEN}READY${NC}"
            return 0
        fi
        echo -n "."
        sleep 5
        elapsed=$((elapsed + 5))
    done
    echo -e " ${RED}TIMEOUT${NC}"
    return 1
}

# Open browser (cross-platform)
open_browser() {
    local url="$1"
    if command -v xdg-open &> /dev/null; then
        xdg-open "$url" 2>/dev/null &
    elif command -v open &> /dev/null; then
        open "$url" 2>/dev/null &
    else
        echo "  Please open manually: $url"
    fi
}

# Start services and finalize setup
start_and_finalize() {
    step "Starting services..."
    cd "$(get_work_dir)"

    mkdir -p data/wiki

    # Start all services (init script sets up Taiga/Matrix users automatically)
    docker compose up -d

    echo ""
    wait_for_service "Taiga"    "http://localhost:$TAIGA_GATEWAY_PORT"  180
    wait_for_service "Wiki.js" "http://localhost:$WIKI_PORT"     180
    wait_for_service "Matrix"   "http://localhost:$SYNAPSE_PORT"       120

    echo ""
    step "Bootstrapping Taiga and Matrix accounts..."
    if ./init-admin-users.sh; then
        log "Bootstrap accounts created"
        docker compose restart turing-orchestrator >/dev/null
    else
        warn "Account bootstrap failed. You can rerun ./init-admin-users.sh manually."
    fi

    wait_for_service "Orchestrator" "http://localhost:$ORCHESTRATOR_PORT/health" 60

    echo ""
    log "All services started!"
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "  1. Run ${CYAN}bash install/config.sh test${NC} to verify Taiga, Matrix, Wiki.js and Context7"
    echo "  2. Open ${CYAN}http://localhost:8080${NC} and sign in to Element with your admin account"
    echo "  3. Open ${CYAN}http://localhost:${TAIGA_GATEWAY_PORT}${NC} and create a TODO ticket"
    echo "  4. If account bootstrap failed, rerun ${CYAN}./init-admin-users.sh${NC}"
    echo ""
}

# Verify installation
verify() {
    step "Verifying installation..."

    local all_ok=true
    for port in $TAIGA_GATEWAY_PORT $WIKI_PORT $SYNAPSE_PORT $ORCHESTRATOR_PORT; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" 2>/dev/null | grep -q "200\|302\|404"; then
            log "Port $port responding"
        else
            warn "Port $port not responding yet"
            all_ok=false
        fi
    done

    if [ "$all_ok" = true ]; then
        log "All services verified!"
    else
        warn "Some services may still be starting. Check: docker compose logs"
    fi
}

# Print summary
print_summary() {
    echo ""
    echo -e "${GREEN}============================================================${NC}"
    echo -e "${GREEN}  INSTALLATION COMPLETE${NC}"
    echo -e "${GREEN}============================================================${NC}"
    echo ""
    echo -e "${YELLOW}Access URLs:${NC}"
    echo "  Taiga:          http://localhost:${TAIGA_GATEWAY_PORT}"
    echo "  Wiki.js:        http://localhost:${WIKI_PORT}"
    echo "  Matrix/Synapse: http://localhost:${SYNAPSE_PORT}"
    echo "  Element:        http://localhost:8080"
    echo "  Orchestrator:   http://localhost:${ORCHESTRATOR_PORT}"
    echo ""
    echo -e "${YELLOW}Credentials:${NC}"
    echo "  Admin User:     $ADMIN_USER"
    echo "  Admin Password: [hidden]"
    echo ""
    echo -e "${YELLOW}Useful Commands:${NC}"
    echo "  make logs                      - View logs"
    echo "  make status                     - Show status"
    echo "  bash install/config.sh test     - Verify service connections"
    echo "  open http://localhost:8080      - Open Element admin chat"
    echo "  ./init-admin-users.sh           - Recreate Taiga & Matrix users"
    echo ""
    echo -e "${GREEN}============================================================${NC}"
}

# Main installation
main() {
    banner

    echo -e "${CYAN}Welcome to Turing OS Installer v${VERSION}${NC}"
    echo "Press Ctrl+C to abort at any time."
    echo ""

    check_prerequisites

    echo ""
    echo -e "${YELLOW}============================================================${NC}"
    echo -e "${YELLOW}  BASIC CONFIGURATION${NC}"
    echo -e "${YELLOW}============================================================${NC}"

    configure_ports
    configure_llm
    configure_context7
    configure_worker
    configure_github

    # Admin MUST be configured BEFORE Wiki.js init (needs ADMIN_PASSWORD)
    configure_admin

    # Create installation directory
    step "Preparing installation directory..."
    if [[ -z "$SOURCE_DIR" ]]; then
        mkdir -p "$INSTALL_DIR/turing-os"
    else
        log "Installer will use the current repository checkout"
    fi

    clone_source
    generate_docker_compose
    generate_env

    build_images

    echo ""
    echo -e "${YELLOW}============================================================${NC}"
    echo -e "${YELLOW}  WIKI.JS INITIALIZATION${NC}"
    echo -e "${YELLOW}============================================================${NC}"

    # Initialize Wiki.js and get JWT token (requires ADMIN_PASSWORD from configure_admin)
    initialize_wiki_and_get_token

    echo ""
    echo -e "${YELLOW}============================================================${NC}"
    echo -e "${YELLOW}  STARTING SERVICES${NC}"
    echo -e "${YELLOW}============================================================${NC}"

    start_and_finalize
    verify
    print_summary

    log "Installation complete!"
}

main "$@"