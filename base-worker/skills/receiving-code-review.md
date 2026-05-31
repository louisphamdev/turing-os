---
skill: receiving-code-review
roles: software-engineer, data, devops, security, network
---

# Receiving Code Review

**When to use:** You received review feedback (relayed from the PM). Apply technical rigor — not performative agreement, not blind rejection.

## How it works in Turing OS
Feedback reaches you relayed Worker → PM → Worker; your responses go back the same way. Never message a reviewer directly.

## For each point
1. **Understand it** — if unclear, ask a clarifying question (relayed via PM) before acting.
2. **Verify it technically** — check the claim against the actual code (`read_file`) or run the case (`execute_terminal_command`). Don't assume the reviewer is right OR wrong.
3. **Decide:**
   - Valid → fix it. Critical now; Important before proceeding; Minor noted for later.
   - Wrong → push back with evidence (a passing test, the code), relayed via PM. Disagreement is settled with facts, not authority.
4. **Re-verify** after fixing (see verification-before-completion) before reporting back.

## Red flags
Blindly implementing every suggestion; blindly dismissing feedback; arguing without evidence; marking a point addressed without re-running.
