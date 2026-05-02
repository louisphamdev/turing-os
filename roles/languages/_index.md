# Language-Specific Skills

This directory contains skill modules for each programming language.

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

## Current Languages

| File | Status | Description |
|------|--------|-------------|
| `dotnet.md` | ✅ Created | .NET 8, ASP.NET Core, EF Core, C# |
| `java.md` | ✅ Created | Java 17+, Spring Boot, Hibernate |
| `react.md` | ✅ Created | React 18+, TypeScript, Next.js |
| `python.md` | TODO | Python ecosystem |
| `golang.md` | TODO | Go ecosystem |
| `javascript.md` | TODO | JavaScript/Node.js |

## How HR Combines for JD

```
PM requests: "Need .NET developer for REST API"

HR checks:
1. software-engineer.md (base competencies)
2. languages/dotnet.md (.NET specific tools)
3. specializations/backend.md (API design patterns)
   
Result: .NET Backend Engineer JD with full skill set
```