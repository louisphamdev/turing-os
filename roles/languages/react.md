# React Engineer Skills

## Language-Specific Tools

| Category | Tool | Purpose |
|----------|------|---------|
| Package Manager | npm / yarn / pnpm | Dependency management |
| Runtime | Node.js 18+ | JavaScript runtime |
| Bundler | Vite / Webpack | Module bundling |
| Linter | ESLint | Code quality |
| Formatter | Prettier | Code formatting |
| Type Checker | TypeScript | Static typing |

## Frameworks & Libraries

### Core
- **React 18+** - UI library
- **Next.js** - Full-stack React framework
- **TypeScript** - Strict typing (strongly recommended)

### State Management
- **Zustand** - Lightweight, simple
- **TanStack Query (React Query)** - Server state, caching
- **Redux Toolkit** - Complex global state
- **Jotai** - Atomic state (if needed)

### Styling
- **Tailwind CSS** - Utility-first (preferred)
- **CSS Modules** - Scoped CSS
- **styled-components** / **Emotion** - CSS-in-JS

### Data Fetching
- **TanStack Query** - Async data, caching
- **SWR** - Alternative to React Query
- **fetch / axios** - HTTP client

### Form Handling
- **React Hook Form** - Performance
- **Zod** - Schema validation
- **Yup** - Validation (if legacy)

### UI Components
- **shadcn/ui** - Copy-paste components (recommended)
- **Radix UI** - Headless components
- **Headless UI** - Tailwind-compatible
- **Material UI** - If faster delivery needed

### Testing
- **Vitest** - Unit testing (Vite-native)
- **React Testing Library** - Component testing
- **Playwright** - E2E testing
- **Cypress** - Alternative E2E

## React-Specific Conventions

### Project Structure
```
src/
├── app/                    # Next.js App Router (if using Next.js)
│   ├── page.tsx           # Page components
│   ├── layout.tsx         # Layouts
│   └── api/               # API routes
├── components/
│   ├── ui/                # shadcn/ui components
│   ├── features/          # Feature-specific components
│   └── shared/            # Reusable components
├── lib/
│   ├── api/               # API client, fetch wrappers
│   ├── utils/             # Helper functions
│   └── constants.ts       # App constants
├── hooks/                 # Custom React hooks
├── types/                 # TypeScript types
└── __tests__/             # Test files
```

### Component Patterns

```tsx
// Preferred: Functional component with hooks
import { useState, useEffect } from 'react';

interface UserCardProps {
  userId: string;
  onSelect?: (user: User) => void;
}

export function UserCard({ userId, onSelect }: UserCardProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    fetchUser(userId).then(setUser).finally(() => setIsLoading(false));
  }, [userId]);
  
  if (isLoading) return <Skeleton />;
  if (!user) return <NotFound />;
  
  return (
    <div onClick={() => onSelect?.(user)}>
      <Avatar src={user.avatar} />
      <span>{user.name}</span>
    </div>
  );
}
```

### TypeScript Standards

```typescript
// Define types properly - avoid 'any'
interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
}

// Use discriminated unions for states
type AsyncState<T> = 
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error };

// Props interface for component
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}
```

### Hook Patterns

```typescript
// Custom hook for API data
function useUser(userId: string) {
  const [state, setState] = useState<AsyncState<User>>({ status: 'idle' });
  
  useEffect(() => {
    setState({ status: 'loading' });
    fetchUser(userId)
      .then(data => setState({ status: 'success', data }))
      .catch(error => setState({ status: 'error', error }));
  }, [userId]);
  
  return state;
}

// Use in component
function UserProfile({ userId }: { userId: string }) {
  const { status, data, error } = useUser(userId);
  
  if (status === 'loading') return <Spinner />;
  if (status === 'error') return <Error message={error.message} />;
  return <div>{data.name}</div>;
}
```

## Testing Standards

### Component Testing
```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { UserCard } from './UserCard';

describe('UserCard', () => {
  it('shows loading state', () => {
    render(<UserCard userId="123" />);
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
  
  it('displays user name when loaded', async () => {
    // Mock fetch
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      json: () => Promise.resolve({ id: '1', name: 'Test User' })
    } as Response);
    
    render(<UserCard userId="1" />);
    expect(await screen.findByText('Test User')).toBeInTheDocument();
  });
});
```

### Coverage Requirements
- Components: 70%+
- Hooks: 80%+
- Utils: 90%+

## Security Checklist

- [ ] Sanitize user input (prevent XSS)
- [ ] Use `dangerouslySetInnerHTML` sparingly and sanitize first
- [ ] Validate all props with TypeScript
- [ ] Store sensitive data in httpOnly cookies, not localStorage
- [ ] Use CSP headers
- [ ] Validate API responses (not just trust blindly)

## Performance Considerations

- Use `React.memo` for expensive components
- `useMemo` for expensive calculations
- `useCallback` for callback props
- Virtualize long lists (react-window / react-virtual)
- Code splitting with `React.lazy` / dynamic imports
- Image optimization with `next/image` or `lazyload`

## Tool Loading for Task

When HR creates a React worker, inject:

```
WORKER_SKILLS=react,typescript,tailwind,nextjs,vitest
WORKER_TOOLS=[
  "npm_cli",
  "vite_cli",
  "eslint",
  "prettier",
  "playwright",
  "tanstack_query"
]
```

## Common Task Patterns

| Task | Tools to Load | Notes |
|------|---------------|-------|
| Dashboard/Admin UI | react,typescript,tailwind,recharts | Data visualization |
| E-commerce | react,nextjs,stripe,headlessui | Full-stack |
| Form-heavy App | react,react-hook-form,zod | Complex validation |
| Real-time | react,socket.io,swr | Live updates |
| Mobile-like | react,react-native-web,pwa | Progressive web app |

## State Management Decision Tree

```
Need global state?
├── Auth/User state? → Zustand or Context
├── Server data/caching? → TanStack Query
├── Complex state logic? → Redux Toolkit
└── Simple local? → useState/useReducer

Avoid:
- Redux for simple state (overkill)
- Context for frequently changing data (re-render issues)
- localStorage for sensitive data
```