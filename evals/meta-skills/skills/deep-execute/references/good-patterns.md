# Good Implementation Patterns

Patterns for implementation agents to follow when writing code.

## Server Components First

```typescript
// Default — no directive needed
export function ItemList({ items }: { items: Item[] }) { ... }

// Only when interactivity is needed
'use client';
export function ItemForm() { ... }
```

## Data Fetching

```typescript
const payload = await getPayload({ config });
const items = await payload.find({
	collection: 'assets',
	where: whereOwner(userId),
	depth: 1,
	select: { title: true, status: true },
});
```

## Forms: react-hook-form + shadcn + Zod

```typescript
const schema = z.object({ name: z.string().min(1) });
// Use shadcn Form component with useForm()
```

## Type Safety

- Import types from `@/payload-types`
- Use type guards from `src/lib/type-guards.ts`
- Use `Pick<>` for subsets
- `as const` is OK, other `as` is not

## Direct Imports

```typescript
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
```

## Access Control

- Use helpers from `src/lib/access/`
- `whereOwner()` for owner-scoped queries

## Testing

- Real data, no mocks
- Unique names: `Test ${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
- Self-contained tests
- Tags on every describe block
- `test.describe.configure({ mode: 'serial' })` in every E2E file
- Dedicated user per E2E file — add to `src/seed/test-credentials.ts`, `src/seed/migrations/001-initial-users.ts`, `tests/helpers/auth.ts`

### Pure Function Unit Tests

- 100% pure functions (no side effects, deterministic) → **100% unit test coverage**
- Mostly-pure functions (pure logic + minor deps) → **80%+ coverage**
- Co-located `.test.ts` files for every pure function in `src/lib/`
