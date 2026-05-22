---
name: zero-failures
description: 'PROACTIVE: Enforces zero test/lint/build failures at all times. Auto-triggered after any code modification task completes. No failure is ever dismissed as pre-existing or out-of-scope. Every failure gets fixed, every time.'
autoTrigger: stop
invariants:
   - '0 lint errors, 0 build errors, 0 test failures — no exceptions, no excuses'
   - 'If test infrastructure is broken, fix the infrastructure — do not skip tests'
   - 'The only acceptable failed test is one you just wrote in a TDD red phase'
---

# Zero Failures Policy

**This is the single most important rule in this codebase.**

## The Rule

Every time code is modified, before the task is considered complete:

1. `lint` — **0 errors** (warnings are OK)
2. `build` — **0 errors**
3. `unit tests` — **0 failures**
4. `integration/e2e tests` — **0 failures** (when they exist)

**No failure is EVER acceptable.** Not "pre-existing." Not "out-of-scope." Not "infrastructure issue." Not "flaky." Fix it or the task is not done.

## The Only Exception

During **TDD red phase**: you deliberately write a failing test BEFORE writing the fix. The test fails (red), you implement (green), you refactor. During the red phase — and ONLY during the red phase — a single test failure is expected. All other tests must still pass.

## Auto-Trigger Behavior

This skill is referenced by ALL orchestrator skills:

- **`/deep-execute`** — Runs lint gate after every task batch
- **`/deep-review`** — Runs full verification after every fix round
- **`/deep-complete`** — Final verification before completion
- **`/deep-bug`** — Red-green-refactor cycle with explicit phases

When ANY of these skills encounter a failure, they MUST:

1. **Stop** — Do not proceed to the next step
2. **Diagnose** — Read the error output
3. **Fix** — Resolve the root cause (not a workaround)
4. **Re-verify** — Run the check again to confirm 0 failures
5. **Only then continue** — Move to the next step

## When Test Infrastructure Is Broken

If the test runner itself fails (not a test, but the runner):

1. **Fix the runner** — Read the error, trace the cause, fix the script
2. **Re-run** — Verify the runner works
3. **Run the full suite** — Confirm 0 failures

Never say "the test infrastructure has a pre-existing issue" and move on. Fix it.

## Verification Commands

Use the project's package manager and scripts. Before running, check `package.json` for available scripts:

```bash
# Quick verification (always run these)
<package-manager> run lint          # Must exit 0 (warnings OK)
<package-manager> run build         # Must exit 0
<package-manager> run test:unit     # Must show 0 failures (or equivalent)

# Full verification (run for any significant change)
<package-manager> run test          # Must show 0 failures
```

Adapt to the project's actual script names. If scripts don't exist, use the language/toolchain's standard commands directly.

## What Counts as a Failure

- Any lint **error** (not warnings)
- Any build/compilation error
- Any test with status `failed`
- Any test runner crash or timeout
- Any non-zero exit code from verification

## What Does NOT Count as a Failure

- Lint warnings
- Expected skipped tests (e.g., environment-dependent tests in a different environment)
- Build warnings that don't produce errors
