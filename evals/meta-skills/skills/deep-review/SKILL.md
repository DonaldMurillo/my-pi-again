---
name: deep-review
description: >
   Multi-round review pipeline. Spawns blind reviewers (quality, security, a11y, performance,
   data integrity, completeness), runs the full test suite, triages findings, fixes them,
   and verifies. Runs N rounds until clean. Use when the user says "deep review", "/deep-review",
   or wants a thorough post-implementation review.
imports:
   - compaction-resilience
invariants:
   - '0 test failures for PASS — no out-of-scope dismissals for test failures. Every failing test MUST be fixed.'
   - 'In-scope/out-of-scope triage applies ONLY to code review findings, NEVER to test results.'
   - 'Always use production-like config for E2E tests. No exceptions.'
---

# Deep Review Skill

Multi-round review pipeline with blind reviewers, full test suite runs, triage, and fix verification.

## Invocation

```
/deep-review --rounds {N} --slug {slug}                # Standard: N rounds of review
/deep-review --rounds {N} --slug {slug} --output-dir {path}  # Custom output directory
```

## References

This skill has reference files in `references/`:

- `references/review-checklist.md` — Master review checklist
- `references/good-patterns.md` — Good patterns to follow
- `references/bad-patterns.md` — Anti-patterns to flag

## Step 0: Initialize

1. Read `docs/plans/{slug}/meta.md` for current state
2. Determine which review round to start from
3. **Write invariants** (compaction resilience): Write this skill's `invariants:` from
   frontmatter to `docs/plans/{slug}/invariants.md`.

## Round Structure

Each round follows the same pattern:

```
Round N:
  1. Spawn blind reviewers in parallel
  2. Run full test suite
  3. Triage findings (in-scope vs out-of-scope)
  4. Fix in-scope findings
  5. Verify fixes
  6. Gate check
```

## Step 1: Spawn Blind Reviewers

Spawn reviewers **in parallel** — each reviewer gets the changed files WITHOUT seeing other reviewers' output:

```
deep-review-quality         → docs/review/round-{N}/quality.md
deep-review-security        → docs/review/round-{N}/security.md
deep-review-completeness    → docs/review/round-{N}/completeness.md
deep-review-test-runner     → docs/review/round-{N}/test-runner.md
```

Additional reviewers based on project type:
- If frontend: `deep-review-a11y`, `deep-review-react-perf` (or equivalent)
- If API: `deep-review-data-integrity`
- If critical system: `deep-review-chaos-monkey`

Each reviewer receives:
- The list of changed files (diff against base branch)
- The plan file
- The user flow spec (if available)
- Their specific review lens

## Step 2: Run Full Test Suite

**CRITICAL:** Run the FULL test suite, not a filtered subset.

```bash
# Use the project's test runner
<package-manager> run test

# For E2E/integration tests specifically
<package-manager> run test:e2e
```

Store results in the review output directory.

## Step 3: Triage Findings

Classify each finding as:

**In-scope fixes** — Issues in changed files that should be fixed now
**Out-of-scope issues** — Pre-existing problems or unrelated concerns

**IMPORTANT:** Test failures are NEVER out-of-scope. Every failing test must be fixed.

## Step 4: Fix

For each in-scope finding:

1. Spawn `deep-review-fixer` agent
2. Apply the fix
3. Run lint + affected tests
4. Update finding status

## Step 5: Verify

After all fixes:

1. Run full test suite again
2. Verify no regressions
3. Check for coverage gaps

## Gate Check

```
YES → round passes, proceed to next round
NO  → treat as round failure, re-fix
```

## Completion

After all rounds complete:

1. Write `docs/review/summary.md` with final verdict
2. Write test results to the configured output path
3. Update `meta.md` with review status

```markdown
# Review Summary

- **Rounds:** {N}
- **Total findings:** {count}
- **Fixed:** {count}
- **Out-of-scope:** {count}
- **Test results:** Meets Standards: {YES/NO}
- **Verdict:** {PASS/NEEDS FIXES}
```
