# Review Checklist

Standard checklist for review agents.

## Mandatory Checks

- [ ] `pnpm lint` passes with 0 errors
- [ ] `pnpm build` passes with 0 errors
- [ ] All unit tests pass (`pnpm test:unit:run`)
- [ ] All E2E tests pass (`pnpm test:isolated --prod`)
- [ ] No `any` types in changed files
- [ ] No `as` assertions in changed files (except `as const`)
- [ ] Access control verified for new endpoints/pages

## Code Quality

- [ ] DRY — no duplication with existing utilities
- [ ] KISS — simplest approach that works
- [ ] SRP — each file/function has one responsibility
- [ ] Types — proper typing, type guards where needed
- [ ] Patterns — follows established codebase conventions

## Accessibility (for UI changes)

- [ ] Keyboard navigation works
- [ ] Form fields have labels
- [ ] Color is not sole indicator
- [ ] Dynamic content uses live regions
- [ ] Touch targets >= 44x44px

## Testing (for new features)

- [ ] User flow spec coverage complete
- [ ] Happy path tests exist
- [ ] Error case tests exist
- [ ] Mobile tests exist
- [ ] Tests use unique data (UUID)
- [ ] Tests are self-contained

## Pure Function Coverage

- [ ] 100% pure functions (no side effects, deterministic) have **100% test coverage**
- [ ] Mostly pure functions (pure logic + minor deps) have **80%+ test coverage**
- [ ] Every export in `src/lib/` that is a pure function has a corresponding `.test.ts`

## Parallel Test Isolation (for new E2E test files)

- [ ] `test.describe.configure({ mode: 'serial' })` present in every file
- [ ] Dedicated test user per file (not shared with other files)
- [ ] User added to `src/seed/test-credentials.ts`
- [ ] User seeded in `src/seed/migrations/001-initial-users.ts`
- [ ] Login helper added to `tests/helpers/auth.ts`
- [ ] No direct use of `admin@example.com` or `testCredentials.superAdmin`
