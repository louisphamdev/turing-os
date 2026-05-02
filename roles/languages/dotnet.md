# .NET Engineer Skills

## Language-Specific Tools

| Category | Tool | Purpose |
|----------|------|---------|
| Package Manager | `dotnet` CLI | Project creation, build, test |
| Package Registry | NuGet | Library dependency management |
| Build | `dotnet build` | Compile project |
| Test | `dotnet test` | xUnit/NUnit/MSTest execution |
| Linter | Roslyn analyzers | Code quality checks |
| Formatter | dotnet-format | Code style consistency |

## Frameworks & Libraries

### Web Frameworks
- **ASP.NET Core** - Web APIs, minimal APIs, MVC
- **Blazor** - Web UI (server-side and WebAssembly)

### Data Access
- **Entity Framework Core** - ORM, migrations
- **Dapper** - Lightweight micro-ORM
- **ADO.NET** - Raw SQL when needed

### Testing
- **xUnit** / **NUnit** - Unit testing
- **FluentAssertions** - Test assertions
- **Moq** / **NSubstitute** - Mocking
- **Playwright** - E2E testing

### Logging & Monitoring
- **Serilog** - Structured logging
- **Application Insights** - Azure monitoring
- **Prometheus** - Metrics

### Security
- **IdentityServer** / **Microsoft Identity** - Auth
- **OWASP .NET** - Security best practices

## .NET-Specific Conventions

### Project Structure
```
Solution/
├── src/
│   ├── Project.Api/        # Web API
│   ├── Project.Core/       # Domain, interfaces
│   ├── Project.Infrastructure/  # Data access
│   └── Project.Tests/      # Unit tests
└── tests/
    └── Project.IntegrationTests/
```

### Naming Conventions
- **Namespaces**: `Company.Product.Module` (PascalCase)
- **Classes**: PascalCase (e.g., `UserService`)
- **Interfaces**: `I` prefix (e.g., `IUserRepository`)
- **Methods**: PascalCase (e.g., `GetUserById`)
- **Private fields**: `_camelCase` (e.g., `_userRepository`)

### Code Patterns
- **Dependency Injection**: Constructor injection preferred
- **Repository Pattern**: IRepository → Repository → DbContext
- **CQRS**: Separate read/write models when needed
- **Middleware**: For cross-cutting concerns

### Async Patterns
```csharp
// Prefer
public async Task<Result> GetUserAsync(int id)
{
    return await _repository.GetAsync(id);
}

// Avoid
public Task<Result> GetUser(int id) // Sync method wrapping async
```

### Configuration
```json
// appsettings.json structure
{
  "ConnectionStrings": {
    "Default": "..."
  },
  "Logging": {
    "LogLevel": { ... }
  }
}

// Use IConfiguration for DI
```

## Testing Standards

### Unit Test Structure (AAA Pattern)
```csharp
[Fact]
public async Task GetUser_WithValidId_ReturnsUser()
{
    // Arrange
    var userId = 1;
    var expected = new User { Id = 1, Name = "Test" };
    _mockRepository.Setup(r => r.GetAsync(1)).ReturnsAsync(expected);
    
    // Act
    var result = await _service.GetUserAsync(userId);
    
    // Assert
    result.Should().BeEquivalentTo(expected);
}
```

### Coverage Requirements
- Business logic: 80%+
- Controllers/APIs: 70%+
- Infrastructure: 60%

## Security Checklist

- [ ] Use parameterized queries (EF Core handles this)
- [ ] Validate input (FluentValidation)
- [ ] No secrets in code (use Azure Key Vault / User Secrets)
- [ ] HTTPS enforced in production
- [ ] CORS properly configured
- [ ] Rate limiting enabled
- [ ] JWT validation with proper issuer/audience

## Performance Considerations

- Use `AsNoTracking()` for read-only queries
- Bulk operations via `ExecuteInsert` / `ExecuteDelete`
- Connection pooling via Pool
- Consider `IAsyncEnumerable` for large result sets
- Memory allocation: stack vs heap awareness

## Tool Loading for Task

When HR creates a .NET worker, inject:

```
WORKER_SKILLS=dotnet,aspnetcore,efcore,xunit,serilog
WORKER_TOOLS=[
  "dotnet_cli",
  "ef_migrations",
  "nuget_restore",
  "xunit_runner",
  "swagger_generator"
]
```

## Common Task Patterns

| Task | Tools to Load | Notes |
|------|---------------|-------|
| Build REST API | dotnet,aspnetcore,efcore,auth | Use minimal APIs or controllers |
| CLI Tool | dotnet,clibp | Use Spectre.Console |
| Worker Service | dotnet,hosting | Background job processing |
| Blazor UI | dotnet,blazor,css | Server or WASM |
| Microservices | dotnet,grpc,consul | gRPC + service discovery |