# Bad Implementation Patterns

Anti-patterns that implementation agents must avoid.

## Never Use

- `any` type — use proper types
- `as` assertions (except `as const`) — use type guards
- Barrel file imports — use direct imports
- Mock data in source files — fetch from real API
- `test.skip()` / `test.todo()` — will fail lint
- Global state libraries — use URL/server/form/local state
- Manual package.json edits — use `pnpm add`/`pnpm remove`

## Testing Anti-Patterns

- Early returns without assertions
- `.catch(() => false)` error hiding
- OR-logic assertions
- Position-based selection (`.nth()`, `.first()`)
- Timestamp-only names (add UUID)
- Inter-test dependencies
- **Missing `test.describe.configure({ mode: 'serial' })`** — required in every E2E file
- **Shared users across E2E files** — each `.spec.ts` needs its own dedicated user
- **Using `admin@example.com` directly** — causes session conflicts with 8 parallel workers

## Code Quality

- No premature abstraction (don't create helpers for one-time ops)
- No over-engineering (no feature flags, backward-compat shims)
- Don't edit auto-generated files (payload-types.ts, importMap.js, shadcn primitives)
