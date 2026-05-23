---
name: deep-execute
description: >
   Independent execution pipeline. Takes any plan markdown as input, breaks it into
   discrete tasks with dependencies, and orchestrates specialized sub-agents to implement
   them. Enforces 0 lint/build errors after every task. Resumable if interrupted.
   Use when the user says "deep execute", "/deep-execute", or wants to implement a plan.
imports:
   - compaction-resilience
invariants:
   - 'Lint gate MUST pass after every task — 0 lint and 0 build errors. Never skip verification.'
   - 'If a lint gate fails, stop the batch and fix before continuing. Never proceed with broken state.'
   - 'Tasks within a batch run in parallel; batches run sequentially. Never reorder dependencies.'
---

# Deep Execute Skill

Independent execution system that takes any plan and implements it through orchestrated sub-agents.

## Invocation

```
/deep-execute {slug}                    # Execute plan from docs/plans/{slug}/final-plan.md
/deep-execute --resume {slug}           # Resume interrupted execution
/deep-execute {path-to-plan.md}         # Execute from any plan file
```

## References

This skill has reference files in `references/`:

- `references/good-patterns.md` — Established codebase patterns
- `references/bad-patterns.md` — Anti-patterns to flag
- `references/task-breakdown-template.md` — Template for task breakdowns

## How It Works

This skill is **fully independent** from `/deep-plan`. It takes any markdown plan as input — could be from `/deep-plan`, hand-written, or from another tool.

## Step 0: Locate Plan

1. If `{slug}` provided: Look for `docs/plans/{slug}/final-plan.md`
   - If not found, try `docs/plans/{slug}/deepened-plan.md` or `docs/plans/{slug}/initial-plan.md`
2. If file path provided: Use that file directly
3. Read `docs/plans/{slug}/meta.md` for resume state (if it exists)
4. **Write invariants** (compaction resilience): Write this skill's `invariants:` from
   frontmatter to `docs/plans/{slug}/invariants.md`. See `compaction-resilience` skill.

## Step 1: Task Breakdown

Spawn 1 `deep-execute-orchestrator` agent:

```
Input: The plan file + task-graph.md (from Plan Verification)
Output: docs/plans/{slug}/execution/task-breakdown.md
```

The orchestrator:

- Reads the plan AND `docs/plans/{slug}/user-flow-spec.md` (if it exists)
- Reads `docs/plans/{slug}/task-graph.md` — canonical source of tasks and dependencies
- **Coverage verification**: Extracts every flow from the user flow spec. Checks that
  the plan's task list covers every flow. Missing flows get a `[COVERAGE GAP]` task.
- Breaks it into small, discrete tasks (one concern per task)
- Groups tasks into parallelizable batches based on dependencies
- Assigns a worker agent type to each task
- Produces an ASCII dependency graph
- **Task persistence**: All tasks persisted to disk. Do NOT use in-memory tracking.

**Task granularity rule**: If a task would touch more than 3 files or take more than one conceptual step, split it further.

## Step 2: Execute Batches

Process batches sequentially. Within each batch, run tasks in parallel.

```
For each batch:
  1. Spawn worker isolated agents in parallel for all tasks in the batch
     - deep-execute-implementer: For code changes
     - deep-execute-test-writer: For test creation
  2. After each worker completes, run lint gate
  3. If any lint gate fails, stop and report
  4. Update task-log.md
  5. If all pass, move to next batch
```

Worker agents receive:

- The task description from task-breakdown.md
- The plan file path (for context)
- The specific files to modify
- Acceptance criteria

**Execution rule**: Each task MUST be executed by spawning a separate, isolated agent process. The main conversation only coordinates — it never implements task work directly.

## Step 3: Track Progress

Update `docs/plans/{slug}/execution/task-log.md` after each task:

```markdown
# Execution Log: {plan title}

| Task | Status  | Worker      | Started | Completed | Lint |
| ---- | ------- | ----------- | ------- | --------- | ---- |
| 1.1  | done    | implementer | 10:30   | 10:35     | pass |
| 1.2  | done    | test-writer | 10:30   | 10:33     | pass |
| 2.1  | running | implementer | 10:36   | -         | -    |
| 2.2  | pending | -           | -       | -         | -    |
```

Update `meta.md` phase status as batches complete.

## Resume Logic

On `/deep-execute --resume`:

1. Read `execution/task-log.md`
2. Find first task with status != `done`
3. Resume from that task's batch
4. Completed tasks are not re-run

## Completion

When all tasks are done:

1. Run `npm install` to install dependencies
2. Run `npx tsc --noEmit` — if it fails, FIX the type errors in the source files and re-run until it passes
3. Run `npx vitest run` — if any tests fail, FIX the code or tests and re-run until they pass
4. **NEVER proceed with broken code.** tsc MUST exit 0. vitest MUST exit 0.
5. Update `meta.md`: Implementation → completed
6. Print summary of what was implemented
7. Suggest running `/deep-review {slug}` for post-implementation review
