.PHONY: help bootstrap build up down logs ps restart clean doctor test test-quick quickstart status update replay

# Turing OS Makefile
# Usage: make [target]

# Colors
GREEN  := \033[0;32m
YELLOW := \033[1;33m
BLUE   := \033[0;34m
NC     := \033[0m

# Default target
.DEFAULT_GOAL := help

## help - Show this help message
help:
	@echo ""
	@echo -e "$(BLUE)╔══════════════════════════════════════════════════════╗$(NC)"
	@echo -e "$(BLUE)║           Turing OS - Make Commands                 ║$(NC)"
	@echo -e "$(BLUE)╚══════════════════════════════════════════════════════╝$(NC)"
	@echo ""
	@echo -e "$(YELLOW)Usage:$(NC) make [target]"
	@echo ""
	@echo -e "$(GREEN)Setup:$(NC)"
	@echo "  bootstrap       Create Matrix admin/bot users + tokens"
	@echo "  build           Build Docker images"
	@echo "  up              Start all services"
	@echo ""
	@echo -e "$(GREEN)Operations:$(NC)"
	@echo "  down            Stop all services"
	@echo "  restart         Restart all services"
	@echo "  logs            View logs (Ctrl+C to exit)"
	@echo "  ps              Show running containers"
	@echo "  status          Show service status"
	@echo ""
	@echo -e "$(GREEN)Development:$(NC)"
	@echo "  test            Run Docker smoke checks"
	@echo "  test-quick      Quick smoke test"
	@echo "  clean           Remove containers, volumes, images"
	@echo ""
	@echo -e "$(GREEN)Utilities:$(NC)"
	@echo "  quickstart      Show quick start guide"
	@echo "  update          Pull latest changes"
	@echo ""
	@echo -e "$(YELLOW)Examples:$(NC)"
	@echo "  make up              # Start services"
	@echo "  make logs            # View logs"
	@echo "  make restart         # Restart everything"
	@echo "  make clean           # Full cleanup"
	@echo ""

## bootstrap - Create Matrix users/tokens
bootstrap:
	@if [ "$(OS)" = "Windows_NT" ]; then \
		powershell -ExecutionPolicy Bypass -File .\init-admin-users.ps1; \
	else \
		bash ./init-admin-users.sh; \
	fi

## build - Build Docker images
build:
	@echo -e "$(GREEN)[BUILD] Building Turing OS images...$(NC)"
	docker build -t turing-worker-base:latest ./base-worker
	docker build -t turing-orchestrator:latest ./orchestrator
	@echo -e "$(GREEN)[BUILD] Done!$(NC)"

## up - Start all services
up:
	@echo -e "$(GREEN)[UP] Starting Turing OS services...$(NC)"
	docker compose up -d
	@echo -e "$(GREEN)[UP] Services started!$(NC)"
	@echo "View logs: make logs"
	@echo "View status: make status"

## down - Stop all services
down:
	@echo -e "$(YELLOW)[DOWN] Stopping Turing OS services...$(NC)"
	docker compose down
	@echo -e "$(GREEN)[DOWN] Services stopped!$(NC)"

## restart - Restart all services
restart:
	@echo -e "$(YELLOW)[RESTART] Restarting Turing OS...$(NC)"
	docker compose restart
	@echo -e "$(GREEN)[RESTART] Done!$(NC)"

## logs - View logs
logs:
	docker compose logs -f

## ps - Show running containers
ps:
	@docker compose ps

## status - Show service status
status:
	@echo -e "$(BLUE)[STATUS] Turing OS Services$(NC)"
	@echo ""
	@docker compose ps
	@echo ""
	@echo -e "$(YELLOW)Access URLs:$(NC)"
	@echo "  Plane:        http://localhost:9000"
	@echo "  BookStack:    http://localhost:6875"
	@echo "  Matrix:       http://localhost:8008"
	@echo "  Element:      http://localhost:8080"
	@echo "  Orchestrator: http://localhost:3001/health"

## clean - Remove containers and volumes
clean:
	@echo -e "$(YELLOW)[CLEAN] Removing Turing OS...$(NC)"
	@read -p "This will remove ALL data. Continue? (y/N): " confirm; \
	if [ "$$confirm" = "y" ]; then \
		docker compose down -v --remove-orphans; \
		docker rmi turing-worker-base:latest turing-orchestrator:latest 2>/dev/null || true; \
		echo -e "$(GREEN)[CLEAN] Done!$(NC)"; \
	else \
		echo "Cancelled."; \
	fi

## test - Run all tests
test:
	@echo -e "$(GREEN)[TEST] Running Docker smoke checks...$(NC)"
	@bash ./scripts/smoke-test.sh
	@echo -e "$(GREEN)[TEST] Smoke checks complete!$(NC)"

## test-quick - Quick smoke test
test-quick:
	@echo -e "$(GREEN)[TEST] Running quick smoke test...$(NC)"
	@./scripts/smoke-test.sh || echo "Smoke test script not found"

## quickstart - Show quick start guide
quickstart:
	@echo ""
	@echo -e "$(BLUE)╔══════════════════════════════════════════════════════╗$(NC)"
	@echo -e "$(BLUE)║           Turing OS Quick Start Guide                ║$(NC)"
	@echo -e "$(BLUE)╚══════════════════════════════════════════════════════╝$(NC)"
	@echo ""
	@echo -e "$(YELLOW)1. Create your first ticket in Plane:$(NC)"
	@echo "   - Go to http://localhost:9000"
	@echo "   - Finish onboarding (workspace + project + API token)"
	@echo "   - Paste the API token into PLANE_API_TOKEN in .env, then make restart"
	@echo "   - Create an issue with Status=Todo, Priority=P1"
	@echo "   - Worker will automatically pick it up"
	@echo ""
	@echo -e "$(YELLOW)2. Verify the stack:$(NC)"
	@echo "   - Run: curl http://localhost:3001/health"
	@echo ""
	@echo -e "$(YELLOW)3. Open Element and talk to workers:$(NC)"
	@echo "   - Go to http://localhost:8080"
	@echo "   - Login with your admin account"
	@echo "   - Use: /status, /timeout-status, /unblock <ticket_id>"
	@echo ""
	@echo -e "$(YELLOW)4. Watch execution and results:$(NC)"
	@echo "   - Run: make logs"
	@echo "   - Review docs in BookStack after completion"
	@echo ""

## update - Pull latest changes
update:
	@echo -e "$(GREEN)[UPDATE] Updating Turing OS...$(NC)"
	git pull origin main
	docker compose pull
	docker compose up -d
	@echo -e "$(GREEN)[UPDATE] Done!$(NC)"

## replay - Replay a task (for debugging)
replay:
	@if [ -z "$(TASK)" ]; then \
		echo "Usage: make replay TASK='Create a login page'"; \
	else \
		echo -e "$(GREEN)[REPLAY] Replaying task: $(TASK)$(NC)"; \
		docker run --rm -e TASK_ID=REPLAY-$$(date +%s) -e LLM_API_KEY=$$LLM_API_KEY turing-worker-base; \
	fi
