# Specialization-Specific Skills

This directory contains skill modules for each technical specialization.

## Usage

These files are combined with `software-engineer.md` (base) to create complete JDs.

```
software-engineer.md (base)
    +
language/*.md (e.g., dotnet.md, java.md, react.md)
    +
specialization/*.md (e.g., backend.md, frontend.md)
    =
Complete JD for a specific role
```

## Current Specializations

| File | Status | Description |
|------|--------|-------------|
| `backend.md` | ✅ Created | REST APIs, microservices, server-side |
| `frontend.md` | ✅ Created | UI development, browsers, CSS |
| `fullstack.md` | TODO | Both frontend and backend |
| `mobile.md` | TODO | iOS/Android development |
| `devops.md` | (separate at roles/devops.md) | |

## Example Combinations

| Role | Base | Language | Specialization |
|------|------|----------|----------------|
| .NET Backend Dev | software-engineer.md | dotnet.md | backend.md |
| Java Backend Dev | software-engineer.md | java.md | backend.md |
| React Frontend Dev | software-engineer.md | react.md | frontend.md |

## Tool Loading Examples

### Backend Worker
```
WORKER_SKILLS=java,springboot,jpa,sql,redis,api-design
WORKER_TOOLS=[java_tools] + [backend_tools]
```

### Frontend Worker
```
WORKER_SKILLS=react,typescript,tailwind,css,a11y,responsive
WORKER_TOOLS=[react_tools] + [frontend_tools]
```