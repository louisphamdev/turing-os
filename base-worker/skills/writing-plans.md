---
skill: writing-plans
roles: po, ba, pm
---

# Writing Plans

**When to use:** You have an approved spec/requirements for a multi-step task, before touching code. Turn it into bite-sized steps with exact file paths and a verification command per step.

Write the plan assuming the engineer has zero context for this codebase: which files to touch, the actual code, how to test it. DRY. YAGNI. TDD. Frequent commits.

## Scope check
If the spec spans multiple independent subsystems, split into separate plans — one per subsystem. Each plan must produce working, testable software on its own.

## File structure first
Before defining tasks, list which files will be created/modified and the single responsibility of each. Files that change together live together. Prefer small, focused files.

## Bite-sized steps (each one action, 2-5 min)
- Write the failing test
- Run it; confirm it fails
- Write the minimal code to pass
- Run tests; confirm they pass
- Commit

## Task shape
```
### Task N: <component>
Files:
- Create: exact/path/to/file.py
- Modify: exact/path/to/existing.py (lines N-M)
- Test:   tests/exact/path/test.py

Step 1 — write failing test:   <actual test code>
Step 2 — run & verify fail:    Run: <exact command>  Expected: FAIL "<reason>"
Step 3 — minimal impl:         <actual code>
Step 4 — run & verify pass:    Run: <exact command>  Expected: PASS
Step 5 — commit:               <exact commit command/message>
```
File ops map to `write_file`; commands run via `execute_terminal_command`.

## No placeholders (these are plan failures)
"TBD" / "TODO" / "implement later"; "add appropriate error handling"; "write tests for the above" without the test code; "similar to Task N" (repeat the code); steps that say what without showing how; references to types/functions defined in no task.

## Self-review before handing off
1. **Spec coverage** — point to a task for every requirement; add tasks for gaps.
2. **Placeholder scan** — kill every red flag above.
3. **Type consistency** — names/signatures match across tasks.
Fix inline, then `write_document` the plan and note it on the ticket. The PM dispatches execution task-by-task.
