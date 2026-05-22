# Good Review Patterns

What review agents should look for as positive signals.

## Code Quality

- Proper type usage (no `any`, type guards used)
- Server components for data display
- Direct imports (no barrel files)
- shadcn/ui components for UI primitives
- Zod schemas for validation
- Access control at collection level

## Testing

- Real data, no mocks
- Unique names with UUID
- Self-contained tests
- Behavioral assertions (not tautological)
- Tags on every describe block
- All tests pass — 0 failures
- `test.describe.configure({ mode: 'serial' })` in every E2E file
- Dedicated user per E2E file (one user per `.spec.ts` file, never shared)

## Accessibility

- Keyboard navigable interactive elements
- Proper form labels
- Color + non-color indicators
- Live regions for dynamic content
- Skip-to-content link present

## Performance

- Minimal `depth` in Payload queries
- `select` used to fetch only needed fields
- Pagination for list views
- Server components to minimize client bundle
