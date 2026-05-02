#!/bin/bash
# Turing OS Configuration Manager
# Usage: ./config.sh [all|plane|revolt|bookstack|context7|github|test]

set -e

VERSION="1.0.0"
ENV_FILE="$(dirname "$0")/../.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error_exit() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "${BLUE}[→]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

load_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        error_exit ".env file not found at $ENV_FILE"
    fi
    
    while IFS='=' read -r key value; do
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        export "$key"="$value"
    done < "$ENV_FILE"
    
    log "Loaded environment from .env"
}

save_env() {
    local key="$1"
    local value="$2"
    
    if grep -q "^${key}=" "$ENV_FILE"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

prompt() {
    local label="$1"
    local default="$2"
    local is_password="${3:-}"
    
    if [[ -n "$default" ]]; then
        echo -n -e "${CYAN}${label}${NC} [${default}]: "
    else
        echo -n -e "${CYAN}${label}${NC}: "
    fi
    
    if [[ "$is_password" == "password" ]]; then
        read -s -r reply
        echo
    else
        read -r reply
    fi
    
    echo "${reply:-$default}"
}

test_service_url() {
    local url="$1"
    curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null | grep -q "200\|302\|404"
}

# ============================================
# TOKEN VALIDATORS
# ============================================

test_plane_token() {
    local url="$1"
    local token="$2"
    
    response=$(curl -s -w "\n%{http_code}" --max-time 10 \
        -H "x-api-key: $token" \
        "$url/api/v1/workspaces" 2>/dev/null)
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [[ "$http_code" == "200" ]]; then
        count=$(echo "$body" | grep -o '"id"' | wc -l)
        echo "{\"success\": true, \"message\": \"Token valid! Found $count workspace(s)\"}"
    else
        echo "{\"success\": false, \"message\": \"Token invalid or insufficient permissions\"}"
    fi
}

test_revolt_token() {
    local url="$1"
    local token="$2"
    
    response=$(curl -s -w "\n%{http_code}" --max-time 10 \
        -H "x-bot-token: $token" \
        "$url/api/bots/@me" 2>/dev/null)
    
    http_code=$(echo "$response" | tail -n1)
    
    if [[ "$http_code" == "200" ]]; then
        username=$(echo "$response" | sed '$d' | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
        echo "{\"success\": true, \"message\": \"Bot token valid! Bot: $username\"}"
    else
        echo "{\"success\": false, \"message\": \"Bot token invalid\"}"
    fi
}

test_bookstack_token() {
    local url="$1"
    local token_id="$2"
    local token_secret="$3"
    
    response=$(curl -s -w "\n%{http_code}" --max-time 10 \
        -X POST "$url/api/token" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$token_id\",\"password\":\"$token_secret\"}" 2>/dev/null)
    
    http_code=$(echo "$response" | tail -n1)
    
    if [[ "$http_code" == "200" ]]; then
        echo "{\"success\": true, \"message\": \"API token valid!\"}"
    else
        echo "{\"success\": false, \"message\": \"API token invalid\"}"
    fi
}

test_context7_token() {
    local token="$1"
    
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -H "x-api-key: $token" \
        "https://api.context7.com/v2/user" 2>/dev/null)
    
    if [[ "$http_code" == "200" ]]; then
        echo "{\"success\": true, \"message\": \"Context7 token valid!\"}"
    else
        echo "{\"success\": false, \"message\": \"Context7 API key invalid\"}"
    fi
}

# ============================================
# CONFIGURATION FUNCTIONS
# ============================================

show_service_status() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║            TURING OS SERVICE STATUS                 ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    
    # Plane
    printf "  Plane: "
    if [[ -z "$PLANE_API_KEY" ]]; then
        echo -e "${YELLOW}⚠ Not configured${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$PLANE_URL/api/v1/workspaces" 2>/dev/null | grep -q "200"; then
        result=$(test_plane_token "$PLANE_URL" "$PLANE_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Service not reachable${NC}"
    fi
    
    # Revolt
    printf "  Revolt: "
    if [[ -z "$REVOLT_BOT_TOKEN" ]]; then
        echo -e "${YELLOW}⚠ Not configured${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$REVOLT_URL" 2>/dev/null | grep -q "200"; then
        echo -e "${GREEN}✓ Connected${NC}"
    else
        echo -e "${YELLOW}⚠ Service not reachable${NC}"
    fi
    
    # BookStack
    printf "  BookStack: "
    if [[ -z "$BOOKSTACK_API_TOKEN" ]]; then
        echo -e "${YELLOW}⚠ Not configured${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$BOOKSTACK_URL" 2>/dev/null | grep -q "200"; then
        echo -e "${GREEN}✓ Connected${NC}"
    else
        echo -e "${YELLOW}⚠ Service not reachable${NC}"
    fi
    
    # Context7
    printf "  Context7: "
    if [[ -z "$CONTEXT7_API_KEY" ]]; then
        echo -e "${YELLOW}⚠ Not configured${NC}"
    else
        result=$(test_context7_token "$CONTEXT7_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Invalid${NC}"
        fi
    fi
    
    echo ""
}

configure_plane() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                     PLANE CONFIG                        ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    info "Get your API key at: $PLANE_URL/settings/api-tokens"
    echo ""
    
    url=$(prompt "Plane URL" "$PLANE_URL")
    token=$(prompt "API Token")
    workspace_id=$(prompt "Workspace ID" "$PLANE_WORKSPACE_ID")
    
    if [[ -n "$token" ]]; then
        echo ""
        step "Testing connection..."
        result=$(test_plane_token "$url" "$token")
        
        if echo "$result" | grep -q '"success": true'; then
            log "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
            save_env "PLANE_URL" "$url"
            save_env "PLANE_API_KEY" "$token"
            save_env "PLANE_WORKSPACE_ID" "$workspace_id"
            log "Plane configuration saved!"
        else
            error_exit "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
        fi
    fi
}

configure_revolt() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                    REVOLT CONFIG                       ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    info "Get bot token at: $REVOLT_URL/settings/bots"
    info "Create bot at: Settings → User Management → Create Bot"
    echo ""
    
    url=$(prompt "Revolt URL" "$REVOLT_URL")
    token=$(prompt "Bot Token")
    admin_id=$(prompt "Admin User ID" "$REVOLT_ADMIN_USER_ID")
    
    if [[ -n "$token" ]]; then
        echo ""
        step "Testing connection..."
        result=$(test_revolt_token "$url" "$token")
        
        if echo "$result" | grep -q '"success": true'; then
            log "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
            save_env "REVOLT_URL" "$url"
            save_env "REVOLT_BOT_TOKEN" "$token"
            save_env "REVOLT_ADMIN_USER_ID" "$admin_id"
            log "Revolt configuration saved!"
        else
            error_exit "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
        fi
    fi
}

configure_bookstack() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  BOOKSTACK CONFIG                      ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    info "Get API token at: $BOOKSTACK_URL/settings/api-tokens"
    echo ""
    
    url=$(prompt "BookStack URL" "$BOOKSTACK_URL")
    token_id=$(prompt "API Token ID")
    token_secret=$(prompt "API Token Secret" "" "password")
    
    if [[ -n "$token_id" ]]; then
        echo ""
        step "Testing connection..."
        result=$(test_bookstack_token "$url" "$token_id" "$token_secret")
        
        if echo "$result" | grep -q '"success": true'; then
            log "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
            save_env "BOOKSTACK_URL" "$url"
            save_env "BOOKSTACK_API_TOKEN" "$token_id:$token_secret"
            log "BookStack configuration saved!"
        else
            error_exit "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
        fi
    fi
}

configure_context7() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  CONTEXT7 CONFIG                       ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    info "Get API key at: https://context7.com/dashboard"
    echo ""
    
    token=$(prompt "Context7 API Key" "$CONTEXT7_API_KEY")
    
    if [[ -n "$token" ]]; then
        echo ""
        step "Testing connection..."
        result=$(test_context7_token "$token")
        
        if echo "$result" | grep -q '"success": true'; then
            log "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
            save_env "CONTEXT7_API_KEY" "$token"
            log "Context7 configuration saved!"
        else
            error_exit "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
        fi
    fi
}

test_all_connections() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃              TESTING ALL CONNECTIONS                   ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    
    all_passed=true
    
    # Plane
    printf "  Plane: "
    if [[ -n "$PLANE_API_KEY" ]]; then
        result=$(test_plane_token "$PLANE_URL" "$PLANE_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            msg=$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
            echo -e "${GREEN}✓ $msg${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi
    
    # Revolt
    printf "  Revolt: "
    if [[ -n "$REVOLT_BOT_TOKEN" ]]; then
        result=$(test_revolt_token "$REVOLT_URL" "$REVOLT_BOT_TOKEN")
        if echo "$result" | grep -q '"success": true'; then
            msg=$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
            echo -e "${GREEN}✓ $msg${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi
    
    # BookStack
    printf "  BookStack: "
    if [[ -n "$BOOKSTACK_API_TOKEN" ]]; then
        IFS=':' read -r token_id token_secret <<< "$BOOKSTACK_API_TOKEN"
        result=$(test_bookstack_token "$BOOKSTACK_URL" "$token_id" "$token_secret")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi
    
    # Context7
    printf "  Context7: "
    if [[ -n "$CONTEXT7_API_KEY" ]]; then
        result=$(test_context7_token "$CONTEXT7_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi
    
    echo ""
    if $all_passed; then
        log "All connections successful!"
    else
        warn "Some connections failed. Run with <service> to reconfigure."
    fi
}

show_help() {
    echo ""
    echo -e "${BLUE}Turing OS Configuration Manager v${VERSION}${NC}"
    echo ""
    echo "Usage: $0 [option]"
    echo ""
    echo "Options:"
    echo "  all       - Configure all services (default)"
    echo "  plane     - Configure Plane only"
    echo "  revolt    - Configure Revolt only"
    echo "  bookstack - Configure BookStack only"
    echo "  context7  - Configure Context7 only"
    echo "  github    - GitHub (no token needed)"
    echo "  test      - Test all connections"
    echo ""
    echo "Examples:"
    echo "  $0                    # Configure all"
    echo "  $0 plane              # Configure Plane only"
    echo "  $0 test               # Test connections"
    echo ""
}

# ============================================
# MAIN
# ============================================

SERVICE="${1:-all}"

# Load existing env
load_env

# Show current status
show_service_status

# Run requested action
case "$SERVICE" in
    all)
        configure_plane
        configure_revolt
        configure_bookstack
        configure_context7
        ;;
    plane) configure_plane ;;
    revolt) configure_revolt ;;
    bookstack) configure_bookstack ;;
    context7) configure_context7 ;;
    github) info "GitHub uses repo URL, no token needed." ;;
    test) test_all_connections ;;
    help|--help|-h) show_help; exit 0 ;;
    *) show_help; exit 1 ;;
esac

# Reload and show final status
echo ""
step "Reloading environment..."
load_env
echo ""
show_service_status