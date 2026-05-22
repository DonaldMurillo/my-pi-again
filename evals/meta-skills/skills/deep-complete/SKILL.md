---
name: deep-complete
description: >
   Completion phase. Commits code, generates documentation, and produces a final summary.
   Run after deep-review passes. Use when the user says "deep complete", "/deep-complete",
   or wants to finalize the pipeline.
imports:
   - compaction-resilience
---

# Deep Complete Skill

Finalization phase — commits, docs, and summary.

## Invocation

```
/deep-complete {slug}                    # Standard completion
/deep-complete --auto-commit {slug}      # Auto-commit without confirmation
/deep-complete --resume {slug}           # Resume interrupted completion
```

## Step 0: Pre-flight

1. Confirm Implementation and all review phases are completed
2. If review is not completed, abort: "Review phase is not complete. Run `/deep-review` first."
3. If `complete/` directory exists, check which outputs are present for resume logic

## Step 1: Generate Commit Plan

1. Stage all changed files: `git add -A` (or selective staging based on plan)
2. Review the diff: `git diff --cached`
3. Create a structured commit plan in `docs/plans/{slug}/complete/commit-plan.md`:

```markdown
# Commit Plan

## Commits

### Commit 1: {short description}
- {file1}: {what was changed}
- {file2}: {what was changed}

### Commit 2: {short description}
- {file3}: {what was changed}
...

## Verification
- Lint: PASS
- Build: PASS
- Tests: PASS
```

## Step 2: Execute Commits (with --auto-commit) or Present (without)

**With `--auto-commit`:** Execute the commits as planned.
**Without:** Present the commit plan for user review.

## Step 3: Documentation

1. Update any relevant README files
2. Generate API documentation if endpoints were added
3. Update changelog if one exists
4. Write `docs/plans/{slug}/complete/summary.md`

## Step 4: Final Summary

Update `meta.md`: Completion → completed.

Print:

```
[deep-complete] Pipeline COMPLETE
[deep-complete]   Commits: {count}
[deep-complete]   Files changed: {count}
[deep-complete]   Documentation: {count} files
```
