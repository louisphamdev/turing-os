---
skill: systematic-debugging
roles: software-engineer, data, devops, security, network, doctor
---

# Systematic Debugging

**When to use:** ANY bug, test failure, or unexpected behavior — BEFORE proposing a fix. No guess-and-check.

## The loop
1. **Reproduce** — get a reliable, minimal repro. If you can't reproduce it, you can't fix it.
2. **Hypothesize** — form ONE specific, falsifiable hypothesis about the root cause.
3. **Gather evidence** — confirm or refute it: read the code (`read_file`), read the logs, run a targeted command (`execute_terminal_command`). Let evidence, not assumption, pick the next step.
4. **Fix the root cause** — the smallest change that addresses the cause, not the symptom.
5. **Verify** — re-run the repro + the test suite; confirm fixed and nothing regressed (see verification-before-completion).

## Rules
- One hypothesis at a time; don't change five things at once.
- Never suppress the symptom (swallowing the error, widening a `try/except`) — find WHY it happens.
- If 3+ fixes fail, STOP and escalate to the PM with what you tried and the evidence — don't thrash.
