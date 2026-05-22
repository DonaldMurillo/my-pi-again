# Good Patterns

Established patterns in this codebase. Planning agents should follow these and recommend them.

## Data Fetching

- **Server components by default** — Use Payload Local API directly in server components
- **No client-side fetching for initial data** — Server components fetch, pass props down
- **Use existing query helpers** in `src/lib/queries/` before writing new ones
- **Depth control** — Always specify `depth` in Payload queries to avoid over-fetching

```typescript
// Server component fetching pattern
const payload = await getPayload({ config });
const items = await payload.find({
	collection: 'assets',
	where: whereOwner(userId),
	depth: 1,
	select: { title: true, status: true, estimatedValue: true },
});
```

## Forms

- **react-hook-form + shadcn Form** — Always use this combo for forms
- **Zod schemas for validation** — Define in `src/lib/validation/`
- **Server actions for submission** — Use Next.js server actions, not API routes
- **toast for notifications** — `import { toast } from 'sonner'`

## Access Control

- **Use helpers from `src/lib/access/`** — `ownerOnly()`, `ownerOrPublicRead()`, etc.
- **Check access at the Payload collection level** — Not in components
- **Use `whereOwner()`** for owner-scoped queries

## Type Safety

- **Never use `any`** — Use proper types from `@/payload-types`
- **Never use `as` assertions** (except `as const`) — Use type guards from `src/lib/type-guards.ts`
- **Use `Pick<>` for subsets** — Don't pass full entity types when you only need a few fields
- **Type guards for runtime validation** — `isAssetStatus()`, `toAssetStatus()`, `extractString()`

## Components

- **Functional components with hooks** — No class components
- **Server components first** — Only add `'use client'` when you need interactivity
- **shadcn/ui primitives** — Don't reinvent the wheel, use existing components
- **Direct imports** — `import { X } from '@/components/path/to/file'` not from barrel files
- **Mobile-first responsive** — See dedicated section below

## Mobile-First Responsive

### Layout

- **Mobile-first CSS**: Base styles = mobile, add `md:` and `lg:` for larger viewports
- **Responsive navigation**: Bottom tab bar on mobile (`lg:hidden`), sidebar on desktop (`hidden lg:block`)
- **Page container**: Use `.page-container py-6` for all page content

### Dialogs & Modals

- **ALL dialogs are responsive** — use `<ResponsiveDialog>` which renders Dialog on desktop, Drawer on mobile
- **No separate Dialog/Drawer choice** — the responsive wrapper IS the standard component

### Tables & Data

- **Table to card pattern** on mobile: `<Table>` on desktop, stacked cards on mobile
- **Column visibility**: `hidden md:table-cell` for non-essential columns

### Touch Targets

- **Minimum 48x48px** on all interactive elements (`min-h-12 min-w-12`)
- **8px gap** between adjacent interactive elements (`gap-2`)

### Forms

- **Single column** on mobile — never side-by-side fields below `md:`
- **Input attributes**: `inputMode`, `enterKeyHint`, `autoComplete` required on ALL inputs

### State Machine (every data view)

- **Loading**: Skeleton matching final layout shape (`loading.tsx`)
- **Empty**: Helpful message + CTA to create first item (`<EmptyState>`)
- **Error**: Error message + retry button + preserved context
- **Success**: Full content with interactive elements

### Toast

- **Position**: `bottom-center` on mobile (above bottom nav), standard on desktop
- **Offset**: CSS variable `--toast-offset` for responsive positioning

### Constants

- **Shared constants**: Extract identical arrays (like navItems) per DRY rule — 100% identical = extract immediately

## Testing

- **Real data, no mocks** — Tests hit real Payload API with isolated databases
- **Unique names with UUID** — `Test Item ${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
- **Self-contained tests** — Each test creates its own data, no inter-test dependencies
- **Behavioral tests** — Verify user actions update state, not just that elements render
- **Filter by name, not position** — `{ hasText: uniqueName }` not `.first()` or `.nth()`
- **Tags on every describe block** — `{ tag: ['@inventory', '@crud'] }`

### Pure Function Unit Test Coverage

- **100% pure functions** (no side effects, deterministic) → **100% coverage**: every branch, edge case, boundary value
- **Mostly-pure functions** (pure logic + minor deps like constants) → **80%+ coverage**: all main paths + key edge cases
- Every pure function in `src/lib/` must have a co-located `.test.ts` file
- Test boundary values: empty string, 0, null, undefined, NaN, max values
- Test error cases: invalid input, wrong types

## State Management (KISS)

- **URL state** for filters, pagination, modals (searchParams)
- **Server state** via Payload Local API in server components
- **Form state** via react-hook-form
- **Local useState** only for ephemeral UI state
- **No global state libraries** unless proven necessary

## File Organization

- **Co-located tests** — `component.test.tsx` next to `component.tsx`
- **Domain-organized lib** — `src/lib/access/`, `src/lib/validation/`, etc.
- **UI specs in `docs/ui-spec/`** — Mirror test directory structure
