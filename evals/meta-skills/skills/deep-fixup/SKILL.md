---
name: deep-fixup
description: >
   Post-pipeline fix-up skill. Root cause analysis for every issue, TDD fixes, and
   spec/doc amendments. Never patches without understanding why. Resumable.
imports:
   - compaction-resilience
invariants:
   - 'Root cause analysis is MANDATORY for every item — no skip, no --quick flag. RCA is the core value.'
   - 'Every regression and missed requirement gets a TDD fix — failing test first, then fix.'
   - 'Plan/spec docs MUST be amended with [AMENDED] markers — never silently update docs.'
   - 'Discussion checkpoint is MANDATORY — present findings and let user decide what to act on.'
---

# Deep Fixup Skill

Post-pipeline fix-up with mandatory root cause analysis for every issue.

## Invocation

```
/deep-fixup {slug}                     # Fix up issues found post-pipeline
/deep-fixup --resume {slug}            # Resume interrupted fixup
```

## References

- `references/rca-framework.md` — Framework for root cause analysis

## Step 0: Initialize

1. Read the issue list (from review, user report, or failed tests)
2. Create fixup directory: `docs/plans/{slug}/fixup-{N}/`
3. Write initial state

## Step 1: Triage

Spawn `deep-fixup-triager` agent:

- Classify each issue: regression, missed requirement, spec gap, or new feature request
- Prioritize by severity
- Identify which issues are in-scope for this fixup

**Discussion checkpoint:** Present triage to user. Only proceed with approved items.

## Step 2: Root Cause Analysis

For each in-scope issue, spawn `deep-fixup-rca` agent:

- 5-Why analysis
- Trace back to the specific plan/task/review gap
- Document the root cause

## Step 3: Fix (TDD)

For each RCA'd issue:

1. Write a failing test that demonstrates the issue
2. Implement the fix
3. Verify test passes
4. Run lint + build

## Step 4: Amend Docs

For each fix, update the relevant plan/spec docs with `[AMENDED]` markers.

## Step 5: Verify

Run full test suite. No regressions allowed.

## Resume Logic

Check fixup directory for completed steps, resume from first incomplete.
