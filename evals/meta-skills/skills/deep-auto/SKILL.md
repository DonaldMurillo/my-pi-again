---
name: deep-auto
description: >
   Fully autonomous pipeline orchestrator. Chains deep-plan (with auto-resolved Q&A),
   deep-execute, deep-review, and optionally deep-complete into a single unattended run.
   All critic questions are resolved using codebase evidence and codified best practices.
   Resumable if interrupted. Use when the user says "deep auto", "/deep-auto", or wants
   to run the full pipeline autonomously.
imports:
   - compaction-resilience
invariants:
   - 'Preflight infrastructure check is MANDATORY — fix or abort, never skip.'
   - 'Auto-resolved Q&A must reflect genuine trade-off analysis, not path of least resistance.'
   - 'deep-review MUST be invoked — never skip review unless --skip-review was explicitly passed.'
   - "0 test failures for final PASS — inherits deep-review's no-exceptions rule."
---

# Deep Auto Skill

Fully autonomous pipeline that chains plan, execute, review, and optionally complete
without human intervention. Auto-resolves all critic Q&A using codebase evidence and
a codified decision framework.

**Behavioral directive:** Load and follow the `intellectual-honesty` skill. Even in autonomous mode, auto-resolved decisions must reflect genuine trade-off analysis, not the path of least resistance.

## Invocation

```
/deep-auto "feature description"                           # Full pipeline: plan + execute + review (3 rounds)
/deep-auto --resume {slug}                                  # Resume interrupted pipeline
/deep-auto --rounds 5 "feature description"                 # Custom review rounds
/deep-auto --complete "feature description"                 # Include deep-complete phase
/deep-auto --complete --auto-commit "feature description"   # Complete + auto-commit
/deep-auto --skip-review "feature description"              # Plan + execute only (no review)
/deep-auto --mode bug "bug description"                    # Bug-fix pipeline: validate + red + fix + verify + regression
```

## References

This skill has reference files in `references/`:

- `references/auto-resolve-framework.md` — Decision framework for auto-resolving critic Q&A
- `references/infrastructure-preflight.md` — Infrastructure checks for specific stacks

## Step 0: Preflight — Infrastructure Health Check (Auto-Fix)

**This step is MANDATORY and runs before ANYTHING else.** The pipeline MUST fix infrastructure
issues automatically. No user input. No "please start X manually." Fix it or die trying.

### Check Process

Run checks in order. Each check follows: **detect → auto-fix → verify → abort only if unfixable.**

1. **Read `references/infrastructure-preflight.md`** for stack-specific checks (database, build tools, dev server, etc.)
2. **Run each check** following the detect → auto-fix → verify pattern
3. **Abort only if** auto-fix fails after reasonable retries

### Preflight Summary

Print on success (showing what was auto-fixed):

```
[deep-auto] Preflight checks PASSED
[deep-auto]   {service}: UP {+ " [auto-started]" if it was started}
[deep-auto]   {service}: CONNECTED
[deep-auto]   {service}: AVAILABLE
```

## Step 0b: Initialize

1. Parse user input:
   - Extract feature description (everything not a flag)
   - Parse flags: `--resume`, `--rounds N` (default 3), `--complete`, `--auto-commit`, `--skip-review`, `--mode bug`
2. Generate slug from feature description (kebab-case, e.g., `add-tooltip-to-stat-cards`)
3. Check for `docs/plans/{slug}/meta.md`:
   - **Exists** → Resume mode. Read meta, find first incomplete phase using the System column.
   - **Doesn't exist** → Fresh start.
4. **Save verbatim prompt (immutable)** — Write the user's exact input (unprocessed, unedited) to
   `docs/plans/{slug}/prompt.md` (or `docs/bugs/{slug}/prompt.md` for bug mode).
   This preserves the original request for pipeline evaluation.
   **If the file already exists, NEVER overwrite it** — the first writer wins. Since deep-auto
   writes this before invoking deep-plan/deep-bug, downstream skills will see it exists and skip.

   ```markdown
   ---
   timestamp: { ISO timestamp }
   source: deep-auto
   flags: { parsed flags, e.g., --rounds 5 --complete }
   ---

   {exact user prompt, verbatim — no summarization, no slug extraction, no cleanup}
   ```

5. Read `references/auto-resolve-framework.md` for Q&A auto-resolution context.
6. **Write invariants** (compaction resilience): Write this skill's `invariants:` from
   frontmatter to `docs/plans/{slug}/invariants.md`. See `compaction-resilience` skill.
7. If `--mode bug`:
   - Instead of `docs/plans/{slug}/`, use `docs/bugs/{slug}/`
   - Check for `docs/bugs/{slug}/meta.md` for resume state
   - The bug pipeline uses `/deep-bug` instead of `/deep-plan` + `/deep-execute`

Print:

```
[deep-auto] Starting autonomous pipeline for: "{feature description}"
[deep-auto] Slug: {slug}
[deep-auto] Mode: {fresh | resume from Phase N}
[deep-auto] Review rounds: {N}
[deep-auto] Completion: {yes | no}
```

### Bug Mode Branch

If `--mode bug`:

1. Invoke `/deep-bug "{description}"` (this handles all phases internally: reproduction, intent validation, clarification, red, fix, verification, regression review, and completion)
2. `/deep-bug` internally invokes `/deep-review --rounds 1 --slug {slug} --output-dir docs/bugs/{slug}/review`
3. `/deep-bug` internally invokes `/deep-complete --slug {slug}`
4. After `/deep-bug` completes all phases, the pipeline is done — skip Steps 1-4 entirely

Skip Steps 1-4 entirely -- `/deep-bug` handles its own planning, execution, review, and completion.

## Step 1: Planning Phase

**Skip if:** `meta.md` shows all plan-system phases (Research through Plan Verification) completed.

Invoke the deep-plan skill with auto-resolve and research:

```
/deep-plan --auto-resolve --research "{feature description}"
```

Or if resuming:

```
/deep-plan --resume {slug}
```

**IMPORTANT:** The `--auto-resolve` flag tells deep-plan to auto-resolve the Q&A phase without
presenting questions to the user. It uses the auto-resolve decision framework to make decisions
based on codebase evidence and codified best practices.

**The `--research` flag** ensures autonomous runs include deep internet research (market analysis,
competitor landscape, UX theory, user pain points, and industry trends) alongside codebase
research. Vision alignment within deep-research auto-defers non-aligned items to
`docs/backlog/out-of-vision-scope.md` — no prompts in auto mode.

### Gate Check

After deep-plan completes, verify:

1. `docs/plans/{slug}/final-plan.md` exists and is non-empty
2. `docs/plans/{slug}/task-graph.md` exists and is non-empty (Plan Verification output)
3. `meta.md` shows Plan Verification as completed

**On failure:**

- Try `--resume {slug}` once to recover from where it left off
- If still failing, stop and report (see Error Handling)

Print:

```
[deep-auto] Planning COMPLETE
[deep-auto]   Final plan: docs/plans/{slug}/final-plan.md
[deep-auto]   Task graph: docs/plans/{slug}/task-graph.md
[deep-auto]   Auto-resolved questions: {count} ({high-confidence}/{medium}/{low})
```

## Step 2: Execution Phase

**Skip if:** `meta.md` shows Implementation as completed.

Invoke the deep-execute skill:

```
/deep-execute {slug}
```

Or if resuming:

```
/deep-execute --resume {slug}
```

### Gate Check

After deep-execute completes, verify:

1. Run lint — must pass with 0 errors
2. Run build — must pass with 0 errors
3. `meta.md` shows Implementation as completed

**On failure:**

- If lint fails: run lint fix, then re-check
- If build fails: read the error output, attempt to fix errors
- Try `--resume {slug}` once after fixing
- If still failing, stop and report

Print:

```
[deep-auto] Execution COMPLETE
[deep-auto] Tasks completed: {done}/{total}
[deep-auto] Lint: PASS | Build: PASS
```

## Step 3: Review Phase (MANDATORY)

**Skip if:** `--skip-review` flag is set, or `meta.md` shows all review phases completed.

**CRITICAL:** This step MUST invoke `/deep-review --rounds {N} --slug {slug}`.
Do NOT substitute manual test runs or filtered tests.
The review phase runs the FULL test suite and spawns blind reviewers.

### What this is NOT:

- Running filtered test subsets is NOT a review
- Manually fixing test selectors is NOT a review round
- Running only tagged tests is NOT sufficient

### What this IS:

- `/deep-review --rounds {N} --slug {slug}` spawns blind reviewers per round
- Each round runs the full test suite
- Each round can find different issues (round 1: most, round 2: regressions, round 3: polish)

Invoke the deep-review skill:

```
/deep-review --rounds {N} --slug {slug}
```

Where N is the `--rounds` value (default 3).

### Gate Check (STRICT)

After deep-review completes:

1. **File MUST exist:** Check the test results file:
   - **Feature mode:** `docs/plans/{slug}/review/test-results.md`
   - **Bug mode:** `docs/bugs/{slug}/review/test-results.md`
   - If it does NOT exist → the review phase did NOT run the full test suite. HARD FAILURE. Re-run.
2. **Check for coverage gaps:** If `docs/plans/{slug}/execution/coverage-gaps.md` exists:
   - The completeness reviewer found MISSING flows too large for the fixer
   - **Invoke `/deep-execute --resume {slug}`** to implement the coverage gaps
   - After execution completes, **reset all review phases to pending** in `meta.md`
   - Re-invoke `/deep-review --rounds {N} --slug {slug}` from Round 1
   - This loop (review → execute → review) can happen at most **once**
3. **Read the file** and check:
   - `Meets Standards:` line — must be `YES`
   - `Failed: 0`
4. If standards NOT met:
   - Do NOT proceed to completion phase
   - Re-run `/deep-review --rounds 2 --slug {slug}` for additional fix cycles
   - If STILL not met after recovery round, stop and report as unrecoverable failure
5. Only proceed to Step 4 when the file exists AND `Meets Standards: YES`

Print:

```
[deep-auto] Review COMPLETE
[deep-auto] Rounds: {N} | Findings fixed: {count} | Out-of-scope: {count}
[deep-auto] Test results: docs/plans/{slug}/review/test-results.md — Meets Standards: YES
[deep-auto] Verdict: PASS
```

## Step 4: Completion Phase (conditional)

**Skip if:** `--complete` flag was NOT passed, or `meta.md` shows Completion as completed.

Invoke the deep-complete skill:

```
/deep-complete {slug}
```

Or with auto-commit:

```
/deep-complete --auto-commit {slug}
```

Print:

```
[deep-auto] Completion phase DONE
[deep-auto] Commits: {proposed | created}
[deep-auto] Documentation: {count} files created/updated
```

## Final Summary

After all phases complete, print:

```
[deep-auto] Pipeline COMPLETE for "{feature description}" ({slug})

Phases:
  Planning:   COMPLETE ({auto-resolved-count} questions auto-resolved)
  Execution:  COMPLETE ({task-count} tasks implemented)
  Review:     COMPLETE ({round-count} rounds, {fix-count} fixes)
  {Completion: COMPLETE (if --complete)}

Artifacts:
  - Final plan:    docs/plans/{slug}/final-plan.md
  - Flow spec:     docs/plans/{slug}/user-flow-spec.md
  - Task log:      docs/plans/{slug}/execution/task-log.md
  - Review:        docs/review/summary.md
  {- Commits:      docs/plans/{slug}/complete/commit-plan.md (if --complete)}

Low-confidence auto-resolved questions: {count}
  {list any low-confidence decisions for optional human review}

Next steps:
  - Review auto-resolved decisions in docs/plans/{slug}/questions.md
  - {If no --complete: Run `/deep-complete {slug}` to finalize commits and docs}
  - Run `/deep-improve` periodically for pipeline self-improvement
```

## Error Handling

### Recovery Strategy Per Phase

| Phase    | Failure                                                | Recovery                                             | Max Retries |
| -------- | ------------------------------------------------------ | ---------------------------------------------------- | ----------- |
| Plan     | final-plan.md missing                                  | `/deep-plan --resume {slug}`                         | 1           |
| Execute  | lint/build fails                                       | lint fix, fix errors, `--resume`                     | 1           |
| Review   | verdict NEEDS FIXES or test-results.md missing/failing | `/deep-review --rounds 2 --slug {slug}` (additional) | 1           |
| Complete | agent output missing                                   | `/deep-complete --resume {slug}`                     | 1           |

### Unrecoverable Failure Protocol

If a phase fails after its recovery attempt:

1. Update `meta.md` with current state (mark failed phase as `failed`)
2. Write failure details to `docs/plans/{slug}/auto-failure-log.md`:

   ```markdown
   # Auto Pipeline Failure

   - **Slug:** {slug}
   - **Failed Phase:** {phase name}
   - **Timestamp:** {ISO}
   - **Error:** {error output}
   - **Recovery Attempted:** {what was tried}

   ## Resume Command

   /deep-auto --resume {slug}
   ```

3. Print a clear error message:
   ```
   [deep-auto] FAILED at {phase name}
   [deep-auto] Error: {brief description}
   [deep-auto] Failure log: docs/plans/{slug}/auto-failure-log.md
   [deep-auto] Resume with: /deep-auto --resume {slug}
   ```

## Resume Logic

On `/deep-auto --resume {slug}`:

1. Read `docs/plans/{slug}/meta.md`
2. Walk the phase table top to bottom:
   - Find the first phase with status != `completed`
   - Use the **System** column to determine which skill to invoke
3. Phase-to-skill mapping:
   | System | Phases | Skill |
   |--------|--------|-------|
   | plan | Research through Plan Verification | `/deep-plan --auto-resolve --resume {slug}` |
   | execute | Task Breakdown + Implementation | `/deep-execute --resume {slug}` |
   | review | Review rounds + Full E2E Suite | `/deep-review --rounds {N} --slug {slug}` |
   | complete | Completion | `/deep-complete --resume {slug}` |
   | bug | All bug phases | `/deep-bug --resume {slug}` |
4. Jump to that step and continue the pipeline from there
5. For bug mode resumes:
   - Check `docs/bugs/{slug}/meta.md` (not `docs/plans/{slug}/meta.md`)
   - If the System column is `bug`, `review`, or `complete`, invoke `/deep-bug --resume {slug}`
   - After `/deep-bug` completes, the pipeline is done

If `auto-failure-log.md` exists, read it first to understand what previously failed.

## Important Notes

- **No human intervention required** — All decisions are made autonomously using the auto-resolve framework
- **Fully resumable** — Can be interrupted and resumed at any point via `--resume`
- **Idempotent** — Running twice with the same slug is safe (completed phases are skipped)
- **Low-confidence decisions are flagged** — User can review `questions.md` after completion to audit auto-resolved decisions
- **Existing skills are unchanged** — Only deep-plan gets the `--auto-resolve` flag addition
