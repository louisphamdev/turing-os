---
skill: brainstorming
roles: po, ba, pm, hr
---

# Brainstorming

**When to use:** Before ANY build/creative work — new feature, component, behavior change, even a "trivial" one. Explore intent first; do not jump to code.

## Hard gate
Do NOT write a file, scaffold, or implement until you have presented 2-3 options and the human has approved a design. Applies to EVERY task regardless of perceived simplicity. "Too simple to design" is the rationalization that wastes the most work — the design can be one paragraph, but you must present it and get approval.

## Steps
1. **Explore context** — `read_file` / `read_document` / `search_documents` on relevant code, specs, the ticket (`read_ticket`). Skim recent changes.
2. **Scope check** — if the request is really several independent subsystems, say so and propose decomposing into sub-projects before refining details.
3. **Clarify** — ask the human ONE question at a time via the PM relay (`ask_admin` / `add_comment` to PM). Multiple-choice preferred. Focus on purpose, constraints, success criteria.
4. **Propose 2-3 approaches** — each with trade-offs; lead with your recommendation and why.
5. **Present the design** — architecture, components, data flow, error handling, testing. Scale each section to its complexity. Get approval.
6. **Record it** — `write_document` the approved design where the PM directs; note it on the ticket (`add_comment`).
7. **Hand off** — the next step is writing-plans. No other skill.

## Principles
- One question at a time. YAGNI ruthlessly — cut features no one asked for.
- Small, well-bounded units: each does one thing, has a clear interface, is testable alone.
- In existing code, follow established patterns; don't propose unrelated refactors.

All human contact is relayed through the PM. Workers never talk peer-to-peer.
