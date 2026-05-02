# Frontend Engineering Skills

## Core Focus

Building user interfaces and experiences that users interact with directly.

## Typical Responsibilities

- Implement UI components and layouts
- Handle user interactions and events
- State management for UI
- Responsive design implementation
- Performance optimization for client
- Accessibility compliance
- Cross-browser compatibility

## Frontend Architecture

### Component Structure
```
src/
├── components/
│   ├── ui/              # Primitive components (Button, Input)
│   ├── layout/          # Layout components (Header, Sidebar)
│   ├── features/        # Feature-specific components
│   └── pages/           # Page-level components
├── hooks/               # Custom React hooks
├── contexts/            # React contexts
├── utils/               # Helper functions
└── styles/             # Global styles, themes
```

### Component Design Principles
```
1. Single Responsibility - one component, one job
2. Composition over Configuration - small components → big features
3. Props interface - TypeScript for clarity
4. Controlled vs Uncontrolled - be intentional
5. Lifting state appropriately - not too high, not too low
```

## UI Implementation Patterns

### Layout Components
```tsx
// Layout composition
function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <Header />
        {children}
      </main>
    </div>
  );
}
```

### Data Display Components
```tsx
// Table with sorting, pagination
function UserTable({ users, onSort, sort, pagination }) {
  return (
    <div>
      <table>
        <thead>
          <tr>
            <th onClick={() => onSort('name')}>Name</th>
            <th onClick={() => onSort('email')}>Email</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id}>
              <td>{user.name}</td>
              <td>{user.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination {...pagination} />
    </div>
  );
}
```

### Form Components
```tsx
// Controlled form with validation
function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  
  const validate = () => {
    const newErrors = {};
    if (!email.includes('@')) newErrors.email = 'Invalid email';
    if (password.length < 8) newErrors.password = 'Too short';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };
  
  const handleSubmit = (e) => {
    e.preventDefault();
    if (validate()) submit(email, password);
  };
  
  return (
    <form onSubmit={handleSubmit}>
      <Input 
        value={email} 
        onChange={setEmail} 
        error={errors.email} 
      />
      <Input 
        type="password"
        value={password} 
        onChange={setPassword} 
        error={errors.password} 
      />
      <button type="submit">Login</button>
    </form>
  );
}
```

## State Management

### Decision Framework

```
UI State (component-local)?
→ useState, useReducer

Shared UI State (theme, sidebar)?
→ Context or Zustand

Server State (API data)?
→ TanStack Query / SWR

Form State?
→ React Hook Form

URL State (filters, pagination)?
→ useSearchParams (React Router)
```

### Server State Pattern (TanStack Query)
```tsx
function useUser(userId: string) {
  return useQuery({
    queryKey: ['users', userId],
    queryFn: () => fetchUser(userId),
    staleTime: 5 * 60 * 1000,  // 5 minutes
    retry: 3,
  });
}

function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading, error } = useUser(userId);
  
  if (isLoading) return <Skeleton />;
  if (error) return <Error error={error} />;
  return <div>{user.name}</div>;
}
```

## Styling Approaches

### Tailwind CSS (Preferred)
```tsx
// Utility classes
<div className="flex items-center justify-between p-4 bg-white rounded-lg shadow">
  <h1 className="text-xl font-bold text-gray-900">Title</h1>
  <button className="px-4 py-2 text-white bg-blue-500 rounded hover:bg-blue-600">
    Action
  </button>
</div>
```

### CSS Modules
```css
/* Button.module.css */
.button {
  padding: 8px 16px;
  border-radius: 4px;
  background: blue;
  color: white;
}

.button:hover {
  background: darkblue;
}
```

## Performance Optimization

### Bundle Size
```
1. Code splitting - lazy load routes
2. Tree shaking - remove unused code
3. Compression - gzip/brotli
4. Image optimization - WebP, lazy load
```

### Runtime Performance
```tsx
// Virtualize long lists
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualList({ items }) {
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  });
  
  return (
    <div ref={parentRef} style={{ height: '400px', overflow: 'auto' }}>
      <div style={{ height: rowVirtualizer.getTotalSize() }}>
        {rowVirtualizer.getVirtualItems().map(virtualRow => (
          <div key={virtualRow.index}>{items[virtualRow.index].name}</div>
        ))}
      </div>
    </div>
  );
}
```

## Accessibility (a11y)

### Semantic HTML
```html
<!-- Bad -->
<div onClick={handleClick}>
  <div class="button">Click me</div>
</div>

<!-- Good -->
<button onClick={handleClick}>Click me</button>
```

### ARIA When Needed
```tsx
// Modal with proper ARIA
<div 
  role="dialog" 
  aria-modal="true" 
  aria-labelledby="modal-title"
  aria-describedby="modal-desc"
>
  <h2 id="modal-title">Confirm Action</h2>
  <p id="modal-desc">Are you sure?</p>
  <button onClick={onConfirm}>Confirm</button>
  <button onClick={onCancel}>Cancel</button>
</div>
```

### Focus Management
```tsx
// Focus trap in modal
useEffect(() => {
  if (isOpen) {
    const firstFocusable = modalRef.current?.querySelector('button');
    firstFocusable?.focus();
  }
}, [isOpen]);
```

## Responsive Design

### Mobile-First
```css
/* Base styles for mobile */
.container {
  padding: 16px;
}

/* Tablet */
@media (min-width: 768px) {
  .container {
    padding: 24px;
    max-width: 720px;
  }
}

/* Desktop */
@media (min-width: 1024px) {
  .container {
    padding: 32px;
    max-width: 1200px;
  }
}
```

## Tool Loading

When HR creates a frontend worker, add:

```
WORKER_SPEC=frontend
WORKER_SKILLS=[from language file] + css,responsive,a11y
WORKER_TOOLS=[
  "npm_cli",
  "vite_cli",
  "prettier",
  "playwright_e2e",
  "lighthouse"
]
```

## Quality Checklist

- [ ] All interactive elements are accessible
- [ ] Forms have proper validation feedback
- [ ] Loading states implemented
- [ ] Error states handled gracefully
- [ ] Responsive on all breakpoints
- [ ] No console errors
- [ ] Performance: LCP < 2.5s, FID < 100ms
- [ ] Images lazy-loaded and optimized
- [ ] Semantic HTML used correctly
- [ ] Keyboard navigation works