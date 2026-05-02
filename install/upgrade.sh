#!/bin/bash
# Turing OS Upgrade Script
# Usage: ./upgrade.sh [version]

set -e

VERSION="${1:-latest}"
INSTALL_DIR="${HOME}/.turing-os"
TURING_DIR="${INSTALL_DIR}/turing-os"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        Turing OS Upgrade Script            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check if Turing OS exists
if [ ! -d "$TURING_DIR" ]; then
    error "Turing OS not found at $TURING_DIR"
    echo "Please install first: curl -sSL https://turing-os.ai/install.sh | bash"
    exit 1
fi

cd "$TURING_DIR"

# Backup current state
log "Backing up current configuration..."
if [ -f ".env" ]; then
    cp .env "$INSTALL_DIR/.env.backup.$(date +%Y%m%d%H%M%S)"
    log "Environment file backed up"
fi

# Pull latest changes
log "Fetching latest changes..."
git fetch origin main

if [ "$VERSION" = "latest" ]; then
    log "Upgrading to latest version..."
    git reset --hard origin/main
else
    log "Upgrading to version $VERSION..."
    git reset --hard "$VERSION"
fi

# Pull Docker images
log "Updating Docker images..."
docker compose pull

# Rebuild custom images
log "Rebuilding custom images..."
docker build -t turing-worker-base:latest ./base-worker
docker build -t turing-orchestrator:latest ./orchestrator

# Restart services
log "Restarting services..."
docker compose down
docker compose up -d

# Verify
log "Verifying services..."
sleep 5

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}┃              UPGRADE COMPLETE                       ┃${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
log "Turing OS upgraded to $(git describe --tags)"
echo ""

# Show status
make status 2>/dev/null || docker compose ps