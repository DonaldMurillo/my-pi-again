# Bad Review Patterns

What review agents should flag as issues.

## Code Quality Violations

- `any` types
- `as` assertions (except `as const`)
- Barrel file imports
- Client components for static display
- Missing type guards
- Files over 500 lines (concern) / 1000 lines (critical)
- Duplicated code (per DRY decision tree)

## Testing Violations

- Mock data in source files
- Skipped or todo tests
- Early returns without assertions
- `.catch(() => false)` error hiding
- OR-logic assertions
- Position-based element selection
- Inter-test dependencies
- **Missing `test.describe.configure({ mode: 'serial' })`** in E2E test files
- **Shared users across test files** (e.g., using `admin@example.com` or `testCredentials.superAdmin`)
- **Missing dedicated test user** — every E2E file needs its own user to avoid session conflicts with 8 parallel workers

## Security Red Flags

- Missing access control on new endpoints
- Unsanitized user input
- Sensitive data in API responses
- Missing Zod validation

## Performance Red Flags

- `depth: 3` or higher without justification
- N+1 query patterns (fetching in loops)
- Unbounded queries (no pagination/limit)
- Large client-side bundles from unnecessary `'use client'`
