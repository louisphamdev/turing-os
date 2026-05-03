#!/bin/bash
# Turing OS Uninstall Script
# Usage: ./uninstall.sh

set -e

INSTALL_DIR="${HOME}/.turing-os"
TURING_DIR="${INSTALL_DIR}/turing-os"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo -e "${YELLOW}╔════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║        Turing OS Uninstall Script          ║${NC}"
echo -e "${YELLOW}╚════════════════════════════════════════════╝${NC}"
echo ""

# Confirmation
read -p "This will remove ALL Turing OS data. Continue? (y/N): " confirm

if [ "$confirm" != "y" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""

# Stop services
log "Stopping services..."
cd "$TURING_DIR" 2>/dev/null && docker compose down

# Remove containers
log "Removing containers..."
docker compose rm -f 2>/dev/null || true

# Remove images
log "Removing custom images..."
docker rmi turing-worker-base:latest turing-orchestrator:latest 2>/dev/null || true

# Remove volumes
log "Removing volumes..."
docker volume rm turing-os_taiga-db turing-os_wiki-db 2>/dev/null || true

# Remove installation directory
log "Removing installation directory..."
rm -rf "$INSTALL_DIR"

# Remove any shortcuts
if [ -f "$HOME/.bashrc" ]; then
    sed -i '/turing-os/d' "$HOME/.bashrc" 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}┃          UNINSTALL COMPLETE                        ┃${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
log "Turing OS has been completely removed."
echo ""