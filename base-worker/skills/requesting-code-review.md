---
skill: requesting-code-review
roles: qa, software-engineer
---

# Requesting Code Review

**When to use:** Work is complete, a major feature is done, or before a merge — request review to catch issues before they cascade. Review early, review often.

## How it works in Turing OS
Workers NEVER talk peer-to-peer. You request review by relaying a structured request to the PM; the PM routes it to a reviewer and relays the result back to you. You never pick or message the reviewer yourself.

## When to request (mandatory)
- After each task in a multi-task plan.
- After completing a major feature.
- Before merge to the main line.
(Optional but valuable: when stuck, before a risky refactor, after a tricky bug fix.)

## Build the review request (relay to PM via add_comment / update_ticket_status → REVIEW)
Include exactly:
- **What you built** — one-paragraph summary.
- **Requirements** — what it should do (link the plan/ticket: `read_ticket` id).
- **Scope to review** — the commit range or files. Get SHAs with `execute_terminal_command` (`git rev-parse`): base SHA and head SHA.
- **How to check** — the exact commands to run it and the tests, with expected output.

## Act on the feedback (relayed back via PM)
- Fix Critical issues immediately; fix Important before proceeding; note Minor for later.
- If the reviewer is wrong, push back with technical reasoning (working tests/code) — relayed through the PM, never directly.

## Red flags
Never skip review because "it's simple"; never ignore Critical; never proceed with unfixed Important; never argue with valid technical feedback.
