# Java Engineer Skills

## Language-Specific Tools

| Category | Tool | Purpose |
|----------|------|---------|
| Build Tool | Maven / Gradle | Dependency management, build |
| Package Manager | Maven Central | Library dependencies |
| Runtime | JDK 17+ | LTS version preferred |
| Linter | Checkstyle / Spotless | Code style enforcement |
| Formatter | Google Java Format | Consistent formatting |
| Test | JUnit 5, Mockito | Unit testing |
| Coverage | JaCoCo | Code coverage reports |

## Frameworks & Libraries

### Web Frameworks
- **Spring Boot** - REST APIs, web applications
- **Spring MVC** - Traditional web (legacy)
- **Quarkus** / **Micronaut** - Lightweight, cloud-native

### Data Access
- **Spring Data JPA** - ORM (Hibernate)
- **MyBatis** - SQL mapping
- **JDBC Template** - Raw SQL when needed

### Testing
- **JUnit 5** - Unit testing
- **Mockito** - Mocking
- **AssertJ** - Fluent assertions
- **Testcontainers** - Integration testing
- **Selenium** / **Playwright** - E2E testing

### Security
- **Spring Security** - Authentication/Authorization
- **OAuth2 / OIDC** - SSO, JWT validation

### Build & Deploy
- **Docker** - Containerization
- **Maven/Gradle plugins** - CI/CD integration

## Java-Specific Conventions

### Project Structure (Maven/Gradle)
```
src/
├── main/
│   ├── java/com/company/project/
│   │   ├── controller/    # REST controllers
│   │   ├── service/       # Business logic
│   │   ├── repository/    # Data access
│   │   ├── model/         # Domain entities
│   │   ├── dto/           # Data transfer objects
│   │   ├── config/        # Configuration
│   │   └── exception/     # Exception handling
│   └── resources/
│       ├── application.yml
│       └── db/migration/   # Flyway/Liquibase
└── test/
    └── java/...
```

### Naming Conventions
- **Packages**: `com.company.module` (lowercase)
- **Classes**: PascalCase (e.g., `UserService`)
- **Methods**: camelCase (e.g., `getUserById`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_RETRY_COUNT`)
- **Variables**: camelCase (e.g., `userRepository`)

### Java Standards
```java
// Class structure
public class UserService {
    private final UserRepository userRepository;
    
    // Constructor injection (preferred)
    public UserService(UserRepository userRepository) {
        this.userRepository = Objects.requireNonNull(userRepository);
    }
    
    public User getUserById(Long id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new UserNotFoundException(id));
    }
}

// Use records for DTOs (JDK 16+)
public record UserDto(Long id, String name, String email) {}
```

### Spring Boot Standards
```yaml
# application.yml
spring:
  datasource:
    url: ${DATABASE_URL}
    username: ${DATABASE_USER}
    password: ${DATABASE_PASSWORD}
  jpa:
    hibernate:
      ddl-auto: validate  # Never auto in prod
    show-sql: false
    properties:
      hibernate:
        format_sql: true
```

## Testing Standards

### Unit Test Structure
```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    
    @Mock
    private UserRepository userRepository;
    
    @InjectMocks
    private UserService userService;
    
    @Test
    void getUserById_existingUser_returnsUser() {
        // Arrange
        Long userId = 1L;
        User expected = new User(userId, "Test");
        when(userRepository.findById(userId)).thenReturn(Optional.of(expected));
        
        // Act
        User result = userService.getUserById(userId);
        
        // Assert
        assertThat(result.getId()).isEqualTo(userId);
        assertThat(result.getName()).isEqualTo("Test");
    }
}
```

### Coverage Requirements
- Service layer: 80%+
- Controller layer: 70%+
- Repository layer: 60%

## Security Checklist

- [ ] Use `PreparedStatement` for raw SQL
- [ ] Input validation with annotations (`@Valid`, `@NotNull`)
- [ ] Secrets in environment variables, not config files
- [ ] JWT validation with proper issuer
- [ ] CORS configured for allowed origins
- [ ] Rate limiting on public endpoints
- [ ] SQL injection prevention (JPA handles parameterized queries)

## Performance Considerations

- Use `Optional` properly to avoid NPE
- Stream API for collection processing (but don't overuse)
- Batch inserts with `saveAll()` in JPA
- Connection pooling (HikariCP - Spring default)
- Second-level cache (Redis/Ehcache) when needed
- Async processing with `@Async` and `CompletableFuture`

## Tool Loading for Task

When HR creates a Java worker, inject:

```
WORKER_SKILLS=java,springboot,hibernate,junit,mockito
WORKER_TOOLS=[
  "maven_cli",
  "java_compiler",
  "spring_boot_cli",
  "junit_runner",
  "db_migration_flyway"
]
```

## Common Task Patterns

| Task | Tools to Load | Notes |
|------|---------------|-------|
| REST API | java,springboot,jpa,security | Use Spring Boot 3.x |
| Microservices | java,springcloud,feign,ribbon | Service discovery |
| Batch Processing | java,springbatch,quartz | Scheduled jobs |
| Real-time | java,websockets,stomp | WebSocket/SSE |
| GraphQL | java,springboot,graphql | Use GraphQL SPQR |