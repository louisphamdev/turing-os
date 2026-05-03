#!/bin/bash
# Turing OS Configuration Manager
# Usage: ./config.sh [all|taiga|matrix|wiki|context7|github|test]

set -e

VERSION="2.0.0"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/../.env" ]]; then
    ENV_FILE="$SCRIPT_DIR/../.env"
elif [[ -f "$SCRIPT_DIR/.env" ]]; then
    ENV_FILE="$SCRIPT_DIR/.env"
elif [[ -f "${HOME}/.turing-os/turing-os/.env" ]]; then
    ENV_FILE="${HOME}/.turing-os/turing-os/.env"
else
    ENV_FILE="$SCRIPT_DIR/../.env"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error_exit() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step()  { echo -e "${BLUE}[→]${NC} $1"; }
info()  { echo -e "${CYAN}[i]${NC} $1"; }

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
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
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
        read -s -r reply; echo
    else
        read -r reply
    fi
    echo "${reply:-$default}"
}

# ============================================
# TOKEN VALIDATORS
# ============================================

test_taiga_token() {
    local url="$1"
    local token="$2"

    response=$(curl -s -w "\n%{http_code}" --max-time 10 \
        -H "Authorization: Bearer $token" \
        "$url/auth/whoami" 2>/dev/null)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" == "200" ]]; then
        username=$(echo "$body" | grep -o '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "{\"success\": true, \"message\": \"Token valid! User: $username\"}"
    else
        echo "{\"success\": false, \"message\": \"Token invalid or insufficient permissions\"}"
    fi
}

test_matrix_token() {
    local url="$1"
    local token="$2"

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -H "Authorization: Bearer $token" \
        "$url/_matrix/client/r0/account/whoami" 2>/dev/null)

    if [[ "$http_code" == "200" ]]; then
        echo "{\"success\": true, \"message\": \"Bot token valid!\"}"
    else
        echo "{\"success\": false, \"message\": \"Bot token invalid\"}"
    fi
}

test_wiki_token() {
    local url="$1"
    local token="$2"

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
        -X POST "$url/graphql" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d '{"query":"{ pages { list(limit: 1) { id title } } }"}' 2>/dev/null)

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

    # Taiga
    printf "  Taiga:   "
    if [[ -z "$TAIGA_API_KEY" ]]; then
        echo -e "${YELLOW}⚠ Not configured (auto-setup via init-admin-users.sh)${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${TAIGA_SCHEME:-http}://${TAIGA_DOMAIN:-localhost:9000}/api/v1/" 2>/dev/null | grep -q "200\|404"; then
        result=$(test_taiga_token "${TAIGA_SCHEME:-http}://${TAIGA_DOMAIN:-localhost:9000}/api/v1" "$TAIGA_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Service not reachable${NC}"
    fi

    # Matrix/Synapse
    printf "  Matrix:  "
    if [[ -z "$MATRIX_BOT_TOKEN" ]]; then
        echo -e "${YELLOW}⚠ Not configured (auto-setup via init-admin-users.sh)${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "${SYNAPSE_API_URL:-http://localhost:8008}" 2>/dev/null | grep -q "200\|404"; then
        result=$(test_matrix_token "${SYNAPSE_API_URL:-http://localhost:8008}" "$MATRIX_BOT_TOKEN")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Connected${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Service not reachable${NC}"
    fi

    # Wiki.js
    printf "  Wiki.js: "
    if [[ -z "$WIKI_JWT_TOKEN" ]]; then
        echo -e "${YELLOW}⚠ Not configured${NC}"
    elif curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$WIKI_URL" 2>/dev/null | grep -q "200"; then
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

configure_taiga() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                     TAIGA CONFIG                       ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    info "Taiga uses username/password auth (NOT API key)."
    info "Run: docker compose up -d && ./init-admin-users.sh"
    info "to auto-create admin user and get auth token."
    echo ""
    info "Manual config not recommended — use init-admin-users.sh instead."
}

configure_matrix() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                   MATRIX CONFIG                        ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    info "Matrix bot tokens are auto-created by init-admin-users.sh."
    info "Run: docker compose up -d && ./init-admin-users.sh"
    echo ""
    info "Manual config not recommended — use init-admin-users.sh instead."
}

configure_wiki() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}┃                  WIKI.JS CONFIG                        ┃${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    info "Get API token at: $WIKI_URL/admin/settings/api"
    echo ""

    url=$(prompt "Wiki.js URL" "$WIKI_URL")
    token=$(prompt "API Token (JWT)" "" "password")

    if [[ -n "$token" ]]; then
        echo ""
        step "Testing connection..."
        result=$(test_wiki_token "$url" "$token")
        if echo "$result" | grep -q '"success": true'; then
            log "$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)"
            save_env "WIKI_URL" "$url"
            save_env "WIKI_JWT_TOKEN" "$token"
            log "Wiki.js configuration saved!"
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

    # Taiga
    printf "  Taiga: "
    if [[ -n "$TAIGA_API_KEY" ]]; then
        result=$(test_taiga_token "${TAIGA_SCHEME:-http}://${TAIGA_DOMAIN:-localhost:9000}/api/v1" "$TAIGA_API_KEY")
        if echo "$result" | grep -q '"success": true'; then
            msg=$(echo "$result" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
            echo -e "${GREEN}✓ $msg${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi

    # Matrix
    printf "  Matrix: "
    if [[ -n "$MATRIX_BOT_TOKEN" ]]; then
        result=$(test_matrix_token "${SYNAPSE_API_URL:-http://localhost:8008}" "$MATRIX_BOT_TOKEN")
        if echo "$result" | grep -q '"success": true'; then
            echo -e "${GREEN}✓ Bot token valid${NC}"
        else
            echo -e "${RED}✗ Token invalid${NC}"; all_passed=false
        fi
    else
        echo -e "${YELLOW}⚠ Not configured${NC}"; all_passed=false
    fi

    # Wiki.js
    printf "  Wiki.js: "
    if [[ -n "$WIKI_JWT_TOKEN" ]]; then
        result=$(test_wiki_token "$WIKI_URL" "$WIKI_JWT_TOKEN")
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
    echo "  taiga     - View Taiga config info"
    echo "  matrix    - View Matrix config info"
    echo "  wiki      - Configure Wiki.js only"
    echo "  context7  - Configure Context7 only"
    echo "  github    - GitHub (no token needed)"
    echo "  test      - Test all connections"
    echo ""
    echo "IMPORTANT: Taiga and Matrix auto-setup via:"
    echo "  docker compose up -d && ./init-admin-users.sh"
    echo ""
    echo "Examples:"
    echo "  $0                    # Configure all"
    echo "  $0 wiki             # Configure Wiki.js only"
    echo "  $0 test               # Test connections"
    echo ""
}

# ============================================
# MAIN
# ============================================

SERVICE="${1:-all}"

load_env
show_service_status

case "$SERVICE" in
    all)
        configure_taiga
        configure_matrix
        configure_wiki
        configure_context7
        ;;
    taiga)   configure_taiga ;;
    matrix)  configure_matrix ;;
    wiki) configure_wiki ;;
    context7) configure_context7 ;;
    github) info "GitHub uses repo URL, no token needed." ;;
    test) test_all_connections ;;
    help|--help|-h) show_help; exit 0 ;;
    *) show_help; exit 1 ;;
esac

echo ""
step "Reloading environment..."
load_env
echo ""
show_service_status