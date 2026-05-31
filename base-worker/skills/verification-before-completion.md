---
skill: verification-before-completion
roles: software-engineer, data, devops, security, network, qa, doctor
---

# Verification Before Completion

**When to use:** Before claiming work is complete / fixed / passing — before setting a ticket to DONE or REVIEW, before reporting to the PM. Evidence before assertions, always.

## The rule
Do NOT claim success from memory or expectation. RUN the verification and SHOW the output.

## Steps
1. Identify the verification commands for this work — the tests, the build, the lint, actually running it.
2. Run them with `execute_terminal_command`.
3. READ the output. Confirm it actually passed (exit 0, "N passed", the expected behavior) — not merely that the command ran.
4. PASTE the relevant output as evidence when you report (`add_comment` / completion message). Only then set status with `update_ticket_status`.

## Anti-patterns (do not do)
- "Tests should pass" without running them.
- "I fixed it" without re-running the repro.
- Marking DONE / REVIEW with no command output shown.
- Seeing a failing (red) result and reporting success anyway.

If verification fails, the work is NOT done — debug it (see systematic-debugging) and verify again.
