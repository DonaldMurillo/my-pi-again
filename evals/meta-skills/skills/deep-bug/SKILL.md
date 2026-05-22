---
name: deep-bug
description: >
   Structured bug-fix pipeline. Reproduce → validate intent → write red test → fix → verify →
   regression review → complete. Never fixes without a failing test first. Resumable.
   Use when the user says "deep bug", "/deep-bug", or provides a bug report.
imports:
   - compaction-resilience
---

# Deep Bug Skill

Structured bug-fix pipeline with red-green-refactor discipline.

## Invocation

```
/deep-bug "bug description"            # Start from description
/deep-bug --report {path}              # Start from structured report
/deep-bug --resume {slug}              # Resume interrupted fix
```

## References

- `references/bug-report-template.md` — Template for structured bug reports

## Phase 0: Initialize

1. Parse description or read report file
2. Generate slug (kebab-case)
3. Create `docs/bugs/{slug}/` directory
4. Write `docs/bugs/{slug}/meta.md` with phase tracking
5. Save verbatim prompt

## Phase 1: Reproduce

1. Reproduce the bug
2. Capture evidence (logs, screenshots, error output)
3. Write to `docs/bugs/{slug}/evidence/`

## Phase 2: Validate Intent

1. Confirm the expected behavior is correct
2. Check if it's actually a feature request disguised as a bug
3. Determine bug class: Logic, UI, API, Performance, Security

## Phase 3: Red Test

Write a failing test that demonstrates the bug. This test MUST fail before any fix is applied.

## Phase 4: Fix

Implement the minimal fix that makes the test pass. Run lint + build after.

## Phase 5: Verify

1. Run the failing test — must now pass
2. Run full test suite — no regressions
3. Verify lint + build pass

## Phase 6: Regression Review

1. Write a regression test (separate from the fix test)
2. Tag with `@regression`
3. Run `/deep-review --rounds 1 --slug {slug} --output-dir docs/bugs/{slug}/review`

## Resume Logic

Check `docs/bugs/{slug}/meta.md` for current phase, resume from there.
