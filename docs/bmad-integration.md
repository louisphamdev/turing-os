# BMAD Integration Guide

> **BMAD** = **Breakthrough Method for Agile AI Driven Development**
> 
> This document describes how BMAD methodology integrates with Turing OS.

---

## Overview

BMAD is a structured AI-driven development framework that complements Turing OS's autonomous multi-agent architecture. The integration provides:

| Component | Source | Turing OS Integration |
|----------|--------|---------------------|
| **Workflow Templates** | BMAD Method (BMM) | PO role enhanced with BMAD phases |
| **Specialized Agents** | BMAD ecosystem | Skills registry for workers |
| **Agent Builder** | BMad Builder (BMB) | Generate custom Turing OS agents |
| **Quality Gates** | Test Architect (TEA) | QA role enhancement |

---

## BMAD Workflow Phases

BMAD defines a structured development lifecycle that maps to Turing OS roles:

```
┌─────────────────────────────────────────────────────────────┐
│                    BMAD DEVELOPMENT LIFECYCLE                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. PRD (Product Requirements Document)                     │
│     ↓                                                        │
│  2. Architecture & Design                                   │
│     ↓                                                        │
│  3. User Stories & Acceptance Criteria                       │
│     ↓                                                        │
│  4. Development (Implementation)                            │
│     ↓                                                        │
│  5. QA Gate (Testing & Review)                              │
│     ↓                                                        │
│  6. Deployment                                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
           ↓                    ↓                  ↓
      [PO Role]           [Workers]          [QA Role]
```

### Phase 1: PRD (Product Requirements Document)

**Owner:** PO (Product Owner)

**BMAD Template:**
```markdown
## Product Requirements Document

### 1. Business Context
[Why is this needed? What problem does it solve?]

### 2. Goals & Success Metrics
- Primary Goal: [Clear statement]
- Success Metrics:
  - Metric 1: [Target]
  - Metric 2: [Target]

### 3. Users & Stakeholders
- Primary Users: [Who benefits directly]
- Secondary Users: [Who is impacted]
- Stakeholders: [Who has decision authority]

### 4. Requirements
#### 4.1 Functional Requirements
- FR-001: [Description]
- FR-002: [Description]

#### 4.2 Non-Functional Requirements
- NFR-001: Performance - [Target]
- NFR-002: Security - [Requirements]

### 5. Constraints
- Timeline: [Deadline]
- Budget: [If applicable]
- Tech Stack: [If specified]

### 6. Risks & Mitigations
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| [R1] | [H/M/L] | [H/M/L] | [Plan] |

### 7. Dependencies
- External: [Dependencies outside team]
- Internal: [Cross-team dependencies]

### 8. Acceptance Criteria
- AC-001: Given [context] when [action] then [result]
- AC-002: Given [context] when [action] then [result]
```

### Phase 2: Architecture & Design

**Owner:** PO + Senior Technical Review

**BMAD Template:**
```markdown
## Architecture Document

### 1. System Overview
- Project Name: [Name]
- Version: [v1.0.0]
- Last Updated: [Date]

### 2. Architecture Diagram
```
[System component diagram]
```

### 3. Component Specifications

#### 3.1 [Component Name]
| Attribute | Value |
|-----------|-------|
| Responsibility | [What it does] |
| Dependencies | [List] |
| Interface | [API/Contracts] |

### 4. Data Models

#### 4.1 [Entity Name]
```json
{
  "id": "uuid",
  "name": "string",
  "created_at": "timestamp"
}
```

### 5. Security Considerations
- Authentication: [Method]
- Authorization: [Model]
- Data Protection: [Measures]

### 6. Deployment Architecture
- Environment: [Dev/Staging/Prod]
- Infrastructure: [Cloud/On-prem]
- Scaling Strategy: [Horizontal/Vertical]
```

### Phase 3: User Stories

**Owner:** PO

**BMAD Template:**
```markdown
## User Story Format

### Story Template
"As a [type of user], I want [goal] so that [benefit]."

### Story ID: US-[Number]
**Title:** [Concise title]
**Priority:** [P0/P1/P2/P3]
**Story Points:** [1/2/3/5/8/13]

#### Description
As a [user type], I want [goal] so that [benefit].

#### Acceptance Criteria
- AC-001: Given [context] when [action] then [result]
- AC-002: Given [context] when [action] then [result]

#### Technical Notes
- Backend: [If applicable]
- Frontend: [If applicable]
- Database: [If applicable]

#### Dependencies
- Blocked by: [US-XXX]
- Blocks: [US-YYY]

#### Status
- [ ] TODO
- [ ] IN PROGRESS  
- [ ] DONE
```

### Phase 4: Development

**Owner:** Workers (Software Engineers)

**BMAD Practices for Workers:**
```markdown
## Development Standards

### 1. Before Writing Code
- [ ] Load relevant skills via `load_skills_for_task`
- [ ] Research unfamiliar tech with Context7
- [ ] Review architecture docs
- [ ] Check for existing solutions

### 2. During Development
- [ ] Follow language-specific style guides
- [ ] Write self-documenting code
- [ ] Add inline comments for complex logic
- [ ] Use type hints (strongly recommended)
- [ ] Handle errors explicitly

### 3. Before Claiming Done
- [ ] Code compiles/runs without errors
- [ ] Unit tests written and passing
- [ ] No hardcoded secrets
- [ ] Logs added for debugging
- [ ] Documentation updated

### 4. Commit Standards
Format: <type>(<scope>): <description>

Types:
- feat: new feature
- fix: bug fix
- refactor: code change
- test: adding tests
- docs: documentation
- chore: maintenance
```

### Phase 5: QA Gate

**Owner:** QA (if available) or PO

**BMAD QA Template:**
```markdown
## QA Test Report

### Test Summary
| Metric | Value |
|--------|-------|
| Total Tests | [N] |
| Passed | [N] |
| Failed | [N] |
| Coverage | [X%] |

### Test Cases

#### TC-[ID]: [Test Name]
- **Priority:** P0/P1/P2/P3
- **Type:** Unit/Integration/E2E
- **Status:** PASS/FAIL/BLOCKED

**Steps:**
1. [Step 1]
2. [Step 2]

**Expected Result:** [What should happen]
**Actual Result:** [What happened]
**Evidence:** [Screenshots/logs]
```

---

## BMAD Skills Registry

BMAD provides specialized skills that can be loaded by Turing OS workers:

### Available BMAD Skills

| Skill | Description | Use Case |
|-------|-------------|----------|
| `bmad-prd` | PRD creation workflow | PO task intake |
| `bmad-architecture` | System design templates | Architecture review |
| `bmad-stories` | User story writing | Requirement breakdown |
| `bmad-dev` | Development standards | Worker coding |
| `bmad-qa` | Testing strategies | QA validation |
| `bmad-review` | Code review checklist | PR review |

### Loading BMAD Skills

Workers can load BMAD skills using the standard skill loading protocol:

```python
# In worker initialization or task setup
TOOL_CALL: load_skills_for_task
ARGUMENTS: {"skill_names": "bmad-dev,python,fastapi"}
```

---

## BMAD Agent Templates

BMAD agents can be used as specialized workers in Turing OS:

### Architect Agent
```markdown
## BMAD Architect Agent

**Specialization:** System Design & Architecture
**BMAD Phase:** PRD → Architecture

### Core Responsibilities
- Analyze requirements for architectural fit
- Design system components and interfaces
- Create architecture diagrams
- Review technical approaches
- Ensure scalability and performance considerations

### Tools
- Context7 (research)
- Architecture templates
- System design patterns
```

### Test Engineer Agent
```markdown
## BMAD Test Engineer Agent

**Specialization:** Risk-based Testing
**BMAD Phase:** QA Gate

### Core Responsibilities
- Create test strategies based on risk
- Write unit, integration, and E2E tests
- Identify and report bugs with evidence
- Validate acceptance criteria
- Ensure quality gates pass

### Testing Approach (TEA Module)
- Risk Assessment: High/Medium/Low
- Test Coverage: Prioritize high-risk areas
- Automation: Maximize where possible
```

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TURING OS + BMAD                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   BMAD LAYER                         │   │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────────────┐   │   │
│  │  │ Workflow  │ │  Skills  │ │ Agent Templates   │   │   │
│  │  │ Templates │ │ Registry │ │ (BMB generated)   │   │   │
│  │  └───────────┘ └───────────┘ └───────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓ ↑                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 TURING OS LAYER                      │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │   │
│  │  │   PO    │ │   PM    │ │ Workers │ │   HR    │   │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘   │   │
│  │       ↓           ↓           ↓           ↓         │   │
│  │  ┌─────────────────────────────────────────────┐    │   │
│  │  │         Taiga (Tickets & State)             │    │   │
│  │  └─────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Request Intake (PO + BMAD PRD)**
   - Stakeholder submits request
   - PO uses BMAD PRD template for structured requirements
   - PO loads `bmad-prd` skill for guidance

2. **Analysis (PO + BMAD Architecture)**
   - PO analyzes fit with existing projects
   - Uses BMAD architecture template for new projects
   - Creates architecture docs using `bmad-architecture` skill

3. **Planning (PO/PM + BMAD Stories)**
   - PM breaks work into user stories
   - Uses BMAD story template
   - Assigns priorities (P0-P3)
   - Loads `bmad-stories` skill

4. **Execution (Workers + BMAD Dev)**
   - Workers load relevant skills + BMAD dev standards
   - Implement code following BMAD development checklist
   - Use `bmad-dev` skill for development practices

5. **Validation (QA + BMAD QA)**
   - QA uses BMAD test templates
   - Loads `bmad-qa` skill for testing strategies
   - Creates risk-based test plans

---

## Quick Reference

### BMAD Commands for Turing OS

| Command | Usage |
|---------|-------|
| `/load-skill bmad-dev` | Load BMAD development skills |
| `/load-skill bmad-prd` | Load BMAD PRD template |
| `/template prd` | Generate PRD from BMAD template |
| `/template architecture` | Generate architecture doc |
| `/template story` | Generate user story |

### BMAD Resources

| Resource | URL |
|----------|-----|
| Official Documentation | https://docs.bmad-method.org/ |
| GitHub Repository | https://github.com/bmad-code-org/BMAD-METHOD |
| Discord Community | https://discord.gg/gk8jAdXWmj |
| NPM Package | `npx bmad-method` |

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-05-03 | Initial BMAD integration documentation |
