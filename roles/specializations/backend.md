# Backend Engineering Skills

## Core Focus

Building server-side systems, APIs, and microservices that power applications.

## Typical Responsibilities

- Design and implement REST/GraphQL APIs
- Database design and optimization
- Authentication and authorization systems
- Business logic implementation
- API versioning and documentation
- Performance optimization
- Error handling and logging

## Common Tech Stacks

### REST API Stack
```
Language: Python/Java/Node.js/.NET/Go
Web Framework: FastAPI/Spring/Express/ASP.NET/Gin
Database: PostgreSQL/MySQL/MongoDB
ORM/Query: SQLAlchemy/Hibernate/Sequelize/EF Core
Cache: Redis/Memcached
Auth: JWT/OAuth2/SAML
API Docs: OpenAPI/Swagger
```

### Microservices Stack
```
Service Discovery: Consul/Eureka/K8s
API Gateway: Kong/Envoy/AWS API Gateway
Communication: REST/gRPC/Kafka/RabbitMQ
Tracing: Jaeger/Zipkin
Metrics: Prometheus/Grafana
```

## Backend Patterns

### Repository Pattern
```python
# Python example
class UserRepository:
    def __init__(self, db: Database):
        self.db = db
    
    async def get_by_id(self, user_id: int) -> User | None:
        return await self.db.query(
            "SELECT * FROM users WHERE id = $1",
            user_id
        )
```

### Service Layer
```python
class UserService:
    def __init__(self, repo: UserRepository):
        self.repo = repo
    
    async def create_user(self, data: CreateUserDto) -> User:
        # Business logic here
        user = User(name=data.name, email=data.email)
        return await self.repo.save(user)
```

### CQRS (when needed)
```
Commands: Create, Update, Delete → Write DB
Queries: Read → Read DB (optimized)
```

## API Design Principles

### REST Standards
```
GET    /users      → List users
GET    /users/{id} → Get user
POST   /users      → Create user
PUT    /users/{id} → Update user
PATCH  /users/{id} → Partial update
DELETE /users/{id} → Delete user
```

### Request/Response Format
```json
// Request
{
  "name": "John",
  "email": "john@example.com"
}

// Response (success)
{
  "data": {
    "id": 1,
    "name": "John",
    "email": "john@example.com",
    "createdAt": "2026-05-01T00:00:00Z"
  }
}

// Response (error)
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email already exists",
    "details": [...]
  }
}
```

### Pagination
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "hasMore": true
  }
}
```

## Database Design

### Principles
- Normalize for data integrity
- Denormalize for read performance (when justified)
- Always use appropriate indexes
- Use transactions for multi-table operations
- Plan for migrations

### Query Optimization
```sql
-- Use EXPLAIN ANALYZE
EXPLAIN ANALYZE
SELECT * FROM users WHERE email = 'test@example.com';

-- Look for: Seq Scan (bad) → Index Scan (good)
-- Look for: high cost, long execution time
```

## Authentication & Authorization

### JWT Flow
```
1. User logs in with credentials
2. Server validates and returns JWT (access + refresh)
3. Client stores JWT (httpOnly cookie preferred)
4. Client sends JWT in Authorization header
5. Server validates JWT on each request
```

### RBAC (Role-Based Access Control)
```python
PERMISSIONS = {
    'admin': ['read', 'write', 'delete', 'admin'],
    'user': ['read', 'write'],
    'guest': ['read']
}

def check_permission(role, action):
    return action in PERMISSIONS.get(role, [])
```

## Error Handling

### API Error Codes
```python
class ErrorCode(Enum):
    VALIDATION_ERROR = 400
    UNAUTHORIZED = 401
    FORBIDDEN = 403
    NOT_FOUND = 404
    CONFLICT = 409
    INTERNAL_ERROR = 500
```

### Exception Handling
```python
@app.exception_handler(NotFoundError)
async def handle_not_found(request, exc):
    return JSONResponse(
        status_code=404,
        content={"error": {"code": "NOT_FOUND", "message": str(exc)}}
    )
```

## Performance Optimization

### Caching Strategy
```
Frequently read, rarely updated? → Cache (Redis)
Session data? → Redis with TTL
Full page? → CDN cache
API response? → Consider stale-while-revalidate
```

### Rate Limiting
```python
@app.middleware
async def rate_limit(request, call_next):
    key = f"rate:{request.client.host}"
    current = await redis.incr(key)
    if current == 1:
        await redis.expire(key, 60)  # per minute
    if current > 100:  # 100 requests/minute
        return Response(status_code=429)
    return await call_next(request)
```

## Tool Loading

When HR creates a backend worker, add:

```
WORKER_SPEC=backend
WORKER_SKILLS=[from language file] + sql,database-design,redis
WORKER_TOOLS=[
  "api_client",
  "sql_migrations",
  "redis_cli",
  "load_testing_k6",
  "openapi_generator"
]
```

## Quality Checklist

- [ ] API follows REST conventions
- [ ] All endpoints have input validation
- [ ] All endpoints have proper error responses
- [ ] SQL queries use parameterized statements
- [ ] No secrets in code
- [ ] Logging at key decision points
- [ ] Transactions for multi-step operations
- [ ] Pagination on list endpoints
- [ ] Rate limiting on public endpoints
- [ ] Documentation (OpenAPI/Swagger)