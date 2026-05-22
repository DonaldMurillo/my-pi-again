# Bad Patterns

Anti-patterns in this codebase. Planning agents should flag these and recommend alternatives.

## TypeScript Anti-Patterns

### `any` type

```typescript
// BAD
const data: any = await fetchSomething();
// GOOD
const data: AssetWithRelations = await fetchSomething();
```

### `as` type assertions (except `as const`)

```typescript
// BAD — bypasses runtime safety
const status = item.status as AssetStatus;
// GOOD — validates at runtime
const status = toAssetStatus(item.status);
// OK — as const is safe
const COLORS = ['red', 'blue'] as const;
```

### Missing type guards

```typescript
// BAD — casting arrays
const items = docs as AssetWithRelations[];
// GOOD — map and extract with type guards
const items = docs.map((doc) => ({
	id: String(doc.id),
	status: toAssetStatus(doc.status),
}));
```

## Import Anti-Patterns

### Barrel file imports

```typescript
// BAD — we don't use index.ts barrel files
import { Breadcrumbs } from '@/components/layout';
// GOOD — direct import
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
```

## Testing Anti-Patterns

- **Mock data in source files** — Pages must fetch from real Payload API
- **Skipped or todo tests** — `test.skip()` and `test.todo()` fail lint
- **Early returns without assertions** — Use `expect().toBeTruthy()` instead of `if (!x) return`
- **`.catch(() => false)`** — Let errors propagate
- **OR-logic assertions** — Split into separate specific tests
- **Position-based selection** — Use labels/testids, not `.nth()` or `.first()`
- **Timestamp collisions** — Add UUID to names for parallel safety
- **Inter-test dependencies** — Each test creates its own data

## Architecture Anti-Patterns

- **Global state libraries** — No Redux/Zustand/Jotai. Use URL/server/form/local state.
- **Client components for data display** — Server components are the default
- **Manual package.json edits** — Always use `pnpm add`/`pnpm remove`
- **Editing auto-generated files** — Regenerate, don't edit

## Code Quality Anti-Patterns

- **Premature abstraction** — Don't create helpers for one-time operations
- **Over-engineering** — No feature flags for simple changes, no backward-compat shims
