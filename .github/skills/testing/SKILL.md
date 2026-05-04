---
name: testing
description: '**SKILL** — Testing and validation for Project Turing OS. Use when: running tests, validating code changes, checking syntax, Docker config validation, shell script linting, or ensuring changes pass validation gates before commit. Triggers: "run tests", "validate", "syntax check", "pytest", "jest", "docker config", "lint", "test coverage"'
user-invocable: true
---

# Testing Skill

## When to Use

This skill handles all testing and validation tasks:
- Running orchestrator tests (Jest/TypeScript)
- Running worker tests (pytest/Python)
- Syntax validation for all languages
- Docker compose configuration validation
- Shell script linting
- CI/CD validation checks

## Orchestrator Testing (TypeScript/Jest)

```powershell
# Run all tests
Set-Location orchestrator
npm test

# Run specific test file
npm test -- intent-parser.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

### Test Files Location

```
orchestrator/tests/
├── intent-parser.test.ts
├── priority-queue.test.ts
├── rbac.test.ts
└── registry.test.ts
```

### Key Test Patterns

```typescript
describe('IntentParser', () => {
  it('should parse Vietnamese create_ticket intent', async () => {
    const result = await parser.parse('tạo ticket cho việc fix login', 'admin');
    expect(result.intent).toBe('create_ticket');
  });
});
```

## Worker Testing (Python/pytest)

```powershell
# Run Python syntax check (no pytest installed yet)
.venv\Scripts\python.exe -m py_compile base-worker\src\tools\matrix_tools.py

# Run all Python tests (when added)
python -m pytest base-worker/tests/

# Run specific test
python -m pytest base-worker/tests/test_tool_registry.py -v
```

### Test Files Location

```
base-worker/tests/
└── test_tool_registry.py
```

## Validation Commands

### Docker Configuration

```powershell
# Validate compose file syntax
docker compose -f docker-compose.yml config

# Validate with override
docker compose -f docker-compose.yml -f docker-compose.override.yml config

# Validate specific compose file
docker compose -f docker-compose.turing.yml config
```

### Shell Script Linting

```powershell
# Bash syntax check (Git Bash or WSL)
bash -n install/install.sh

# PowerShell syntax check
powershell -Command "Get-Command -Name install.ps1 -Syntax"
```

### TypeScript Compilation

```powershell
# Build orchestrator (compilation check)
Set-Location orchestrator
npm run build

# Type check only
npx tsc --noEmit
```

## Test Results

Test results are saved to:
- `orchestrator/testResults_*.json` — Jest JSON results

## Validation Checklist

Before any commit, ensure:
- [ ] `npm run build` passes in orchestrator
- [ ] `npm test` passes in orchestrator
- [ ] `docker compose config` validates
- [ ] Python files compile without syntax errors

## Related Files

- `orchestrator/package.json` — Test scripts
- `orchestrator/jest.config.js` — Jest configuration
- `orchestrator/jest.setup.js` — Jest setup
- `base-worker/requirements.txt` — Python dependencies