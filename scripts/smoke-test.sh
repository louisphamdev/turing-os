#!/bin/bash
# Turing OS Smoke Test
# Quick verification that the system is working

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

echo ""
echo -e "${YELLOW}╔════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║         Turing OS Smoke Test               ║${NC}"
echo -e "${YELLOW}╚════════════════════════════════════════════╝${NC}"
echo ""

PASS=0
FAIL=0
EXPECTED_SERVICES=13

# Test 1: Docker running
echo -n "Checking Docker... "
if docker info &>/dev/null; then
    log "Docker is running"
    ((PASS++))
else
    fail "Docker is not running"
    ((FAIL++))
fi

# Test 2: Docker Compose available
echo -n "Checking Docker Compose... "
if docker compose version &>/dev/null || docker-compose --version &>/dev/null; then
    log "Docker Compose available"
    ((PASS++))
else
    fail "Docker Compose not found"
    ((FAIL++))
fi

# Test 3: Services running
echo -n "Checking services... "
SERVICES=$(docker compose ps --services --status running 2>/dev/null | wc -l | tr -d ' ')
if [ "$SERVICES" -ge "$EXPECTED_SERVICES" ]; then
    log "$SERVICES services running"
    ((PASS++))
else
    fail "Only $SERVICES services running (expected $EXPECTED_SERVICES)"
    ((FAIL++))
fi

# Test 4: Taiga API
echo -n "Checking Taiga API... "
if curl -s http://localhost:9000/api/v1/ &>/dev/null; then
    log "Taiga API responding"
    ((PASS++))
else
    fail "Taiga API not responding"
    ((FAIL++))
fi

# Test 5: BookStack
echo -n "Checking BookStack... "
if curl -s http://localhost:6875 &>/dev/null; then
    log "BookStack accessible"
    ((PASS++))
else
    fail "BookStack not accessible"
    ((FAIL++))
fi

# Test 6: Matrix/Synapse
echo -n "Checking Matrix/Synapse... "
if curl -fsS http://localhost:8008/_matrix/client/versions &>/dev/null; then
    log "Matrix accessible"
    ((PASS++))
else
    warn "Matrix not accessible (may be first-time setup)"
fi

# Test 7: Orchestrator health
echo -n "Checking Orchestrator API... "
if curl -fsS http://localhost:3001/health &>/dev/null; then
    log "Orchestrator health responding"
    ((PASS++))
else
    fail "Orchestrator health not responding"
    ((FAIL++))
fi

# Test 8: Worker image
echo -n "Checking worker image... "
if docker images | grep -q "turing-worker-base"; then
    log "Worker image exists"
    ((PASS++))
else
    fail "Worker image not found"
    ((FAIL++))
fi

# Test 9: Orchestrator image
echo -n "Checking orchestrator image... "
if docker images | grep -q "turing-orchestrator"; then
    log "Orchestrator image exists"
    ((PASS++))
else
    fail "Orchestrator image not found"
    ((FAIL++))
fi

# Summary
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}┃                    RESULTS                           ┃${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All tests passed! Turing OS is ready.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Create a ticket in Taiga: http://localhost:9000"
    echo "  2. Watch worker execute: make logs"
    echo "  3. View status: make status"
    exit 0
else
    echo -e "${RED}Some tests failed. Check logs: docker compose logs${NC}"
    exit 1
fi