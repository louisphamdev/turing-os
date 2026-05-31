---
skill: test-driven-development
roles: software-engineer, data, devops, security, network
---

# Test-Driven Development

**When to use:** Implementing ANY feature or bugfix, before writing implementation code. The discipline is RED → GREEN → REFACTOR.

## The cycle
1. **RED** — write ONE small failing test for the next behavior. Run it (`execute_terminal_command`) and SEE it fail for the right reason. A test you didn't watch fail is not trusted.
2. **GREEN** — write the MINIMAL code to make that test pass. No extra features (YAGNI). Run the test; see it pass.
3. **REFACTOR** — clean up names/duplication with the test still green. Re-run.
4. Commit, then repeat for the next behavior.

## Rules
- Never write implementation before a watched-fail test exists.
- One behavior per test; assert real behavior, not a mock of the thing under test.
- Keep the loop tight — minutes per cycle, not hours.

## Rationalizations to reject
"It's too simple to test" · "I'll add tests after" · "the test is obvious so I'll skip watching it fail" · "mock everything" — each breaks the discipline. Being tempted to skip is exactly when to write the test first.

## Tools
Read with `read_file`, write code & tests with `write_file`, run with `execute_terminal_command` using the project's real runner (pytest / jest / etc.).
