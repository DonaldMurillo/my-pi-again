---
name: deep-plan
description: >
   Launch a multi-phase planning pipeline: research the codebase AND web for best
   practices, create a plan, generate a user flow spec, deepen it, get critiques from
   specialized agents, resolve questions, and produce a finalized plan. All state saves
   to docs/plans/{slug}/ as committable markdown. Resumable if interrupted. Use when
   the user says "deep plan", "/deep-plan", or asks for a thorough implementation plan.
imports:
   - compaction-resilience
   - product-vision
invariants:
   - 'All research agents MUST run concurrently in a SINGLE message — never spawn them one at a time.'
   - 'Never skip critic phases unless explicitly requested with --skip-critics.'
   - 'Every question in Q&A MUST use the exact format specified — no freeform questions.'
---

# Deep Plan Skill

Multi-phase planning pipeline that produces a comprehensive, critiqued plan with a user flow spec.

**Behavioral directive:** Load and follow the `intellectual-honesty` skill throughout all planning phases. Challenge the user's assumptions, take clear positions on architecture trade-offs, and name downsides honestly. A plan built on unexamined assumptions is worse than no plan.

## Invocation

```
/deep-plan "feature description"              # Full pipeline
/deep-plan --resume {slug}                     # Resume interrupted pipeline
/deep-plan --phase research "description"      # Research only (codebase + web)
/deep-plan --phase flow-spec {slug}            # Generate user flow spec from existing plan
/deep-plan --phase deepen {slug}               # Deepen existing plan
/deep-plan --phase critique {slug}             # Run critics only
/deep-plan --skip-critics "description"        # Skip critique phase
/deep-plan --critics swe,security "description" # Subset of critics
/deep-plan --auto-resolve "description"        # Auto-resolve Q&A (no human input)
/deep-plan --research "description"            # Include deep internet research (market, UX, pain points, trends)
/deep-plan --brainstorm "description"          # Run brainstorm phase before research
```

## References

This skill has reference files in `references/`:

- `references/good-patterns.md` — Established codebase patterns
- `references/bad-patterns.md` — Anti-patterns to flag
- `references/user-flow-spec-template.md` — Template for user flow specs

## Phase Dispatch

### Step 0: Initialize

1. Parse user input into a title and slug (kebab-case, e.g., `location-tracking`)
2. Check if `docs/plans/{slug}/meta.md` exists:
   - **Exists** → Resume mode. Read meta, find first incomplete phase.
   - **Doesn't exist** → Fresh start. Create directory and `meta.md`.
3. **Save verbatim prompt (immutable)** — Write the user's exact input (unprocessed, unedited) to
   `docs/plans/{slug}/prompt.md`. This preserves the original request for pipeline evaluation.
   **If the file already exists, NEVER overwrite it** — the first writer wins (e.g., deep-auto
   writes it before invoking deep-plan, so deep-plan must not clobber it).

   ```markdown
   ---
   timestamp: { ISO timestamp }
   source: deep-plan
   ---

   {exact user prompt, verbatim — no summarization, no slug extraction, no cleanup}
   ```

4. If `--phase` flag is set, jump directly to that phase.
5. If `--brainstorm` flag is set, run Phase: Brainstorm before research.
6. If `--research` flag is set, include deep internet research in Phase: Research (see below).
7. **Product vision check** (interactive mode only, NOT in `--auto-resolve`):
   - Check if `docs/product-vision.md` exists
   - If missing: invoke the `product-vision` skill's bootstrap trigger
   - If user declines: continue without vision alignment
   - In `--auto-resolve` mode: skip silently
8. **Write invariants** (compaction resilience): Write this skill's `invariants:` from
   frontmatter to `docs/plans/{slug}/invariants.md`. See `compaction-resilience` skill.

### `meta.md` Template

```markdown
# Deep Plan: {title}

- **Slug:** {slug}
- **User Prompt:** "{original request}"
- **Created:** {human-readable date}

| Phase                     | System   | Status  | Completed |
| ------------------------- | -------- | ------- | --------- |
| Research (codebase + web) | plan     | pending | —         |
| Initial Plan              | plan     | pending | —         |
| User Flow Spec            | plan     | pending | —         |
| Deepening                 | plan     | pending | —         |
| Critique                  | plan     | pending | —         |
| Q&A                       | plan     | pending | —         |
| Final Plan                | plan     | pending | —         |
| Plan Verification         | plan     | pending | —         |
| Task Breakdown            | execute  | pending | —         |
| Implementation            | execute  | pending | —         |
| Review Round 1            | review   | pending | —         |
| ├ Review                  | review   | pending | —         |
| ├ Triage                  | review   | pending | —         |
| ├ Fix                     | review   | pending | —         |
| └ Verify                  | review   | pending | —         |
| Review Round 2            | review   | pending | —         |
| ├ Review                  | review   | pending | —         |
| ├ Triage                  | review   | pending | —         |
| ├ Fix                     | review   | pending | —         |
| └ Verify                  | review   | pending | —         |
| Review Round 3            | review   | pending | —         |
| ├ Review                  | review   | pending | —         |
| ├ Triage                  | review   | pending | —         |
| ├ Fix                     | review   | pending | —         |
| └ Verify                  | review   | pending | —         |
| Full Test Suite           | review   | pending | —         |
| Completion                | complete | pending | —         |

**Resume:** Start from Research
```

**Rules for the meta table:**

- Q&A phase name updates to reflect resolution: `Q&A (auto-resolved)` or `Q&A (resolved)`
- Phase title tells the agent exactly where to restart
- Review rounds scale: add Review Round 4/5/6 using the same pattern
- **Use persistent task storage for task tracking — not in-memory todo lists.** Tasks must survive interruptions.

### Phase: Brainstorm (Optional — requires `--brainstorm` flag)

Spawn 3 brainstormer agents **in parallel**:

```
Agent 1 (deep-plan-brainstormer): lens = "user-first"
  - Write to: docs/plans/{slug}/brainstorm/user-first.md

Agent 2 (deep-plan-brainstormer): lens = "simplicity"
  - Write to: docs/plans/{slug}/brainstorm/simplicity.md

Agent 3 (deep-plan-brainstormer): lens = "scalability"
  - Write to: docs/plans/{slug}/brainstorm/scalability.md
```

After all complete, present the 3 approaches and let the user pick one or synthesize.

### Phase: Research (Locator → Analyzer Pattern)

Research uses a **two-tier model** for cost/speed efficiency:

**CRITICAL: All Agent tool calls MUST be in a SINGLE message so they run concurrently.**

**Tier 1: Locate** — Spawn 5 locator agents **in parallel** using a fast/cheap model:

```
Agent 1 (deep-plan-locator): angle = "codebase"
  - Write to: docs/plans/{slug}/research/locate-codebase.md

Agent 2 (deep-plan-locator): angle = "patterns"
  - Write to: docs/plans/{slug}/research/locate-patterns.md

Agent 3 (deep-plan-locator): angle = "docs"
  - Write to: docs/plans/{slug}/research/locate-docs.md

Agent 4 (deep-plan-locator): angle = "git-history"
  - Write to: docs/plans/{slug}/research/locate-git-history.md

Agent 5 (deep-plan-web-researcher): web best practices
  - Write to: docs/plans/{slug}/research/research-web.md
```

**Tier 1b: Synthesize** — Read all locate-\*.md files. Deduplicate candidates, rank by relevance, select top findings for deep analysis.

**Tier 2: Analyze** — Spawn 3 analyzer agents **in parallel** using a capable model:

```
Agent 1 (deep-plan-analyzer): angle = "architecture"
  - Reads: locate-codebase.md + locate-git-history.md
  - Write to: docs/plans/{slug}/research/research-architecture.md

Agent 2 (deep-plan-analyzer): angle = "patterns"
  - Reads: locate-patterns.md + locate-docs.md
  - Write to: docs/plans/{slug}/research/research-patterns.md

Agent 3 (deep-plan-analyzer): angle = "domain"
  - Reads: locate-codebase.md + locate-patterns.md
  - Write to: docs/plans/{slug}/research/research-domain.md
```

Each locator/analyzer agent gets the user's feature description, their angle, and the output file path.

After all complete, update `meta.md`: Research → completed.

### Phase: Research — Deep Internet Research (Optional — requires `--research` flag)

When `--research` flag is set, invoke `/deep-research` in integrated mode AFTER the codebase
research completes. This adds market analysis, UX theory, user pain points, and industry trends.

```
/deep-research --output docs/plans/{slug}/research/ "{feature description}"
```

**Resume handling:** If research compilation already exists, skip this phase.

**In `--auto-resolve` mode:** Vision alignment auto-defers non-aligned items. No prompts.

### Phase: Initial Plan

**Run in main conversation** (has all research context).

1. Read ALL research files from `research/`
2. Synthesize into `initial-plan.md` with sections:
   - **Goal**: What the feature achieves
   - **Architecture**: High-level approach and key decisions
   - **Changes**: Files to create/modify with descriptions
   - **Data Model**: New data structures, schemas, relationships (if applicable)
   - **API Changes**: New endpoints, modified interfaces (if applicable)
   - **UI Changes**: New pages/components/flows (if applicable)
   - **Testing Strategy**: Testing priorities — (1) E2E/integration tests first (TDD), (2) unit tests for pure functions. No mocks for external dependencies when possible.
      - **Pure function coverage**: 100% pure functions → 100% test coverage. Mostly-pure → 80%+ coverage.
   - **Web Research Insights**: Key takeaways from best practices research
   - **Open Questions**: Unresolved items from research

Update `meta.md`: Initial Plan → completed.

### Phase: User Flow Spec

Spawn 1 `deep-plan-flow-spec` agent:

```
Input: docs/plans/{slug}/initial-plan.md + research/
Output: docs/plans/{slug}/user-flow-spec.md
Template: references/user-flow-spec-template.md
```

The flow spec generates:

- Actors and their permissions
- Happy path flows (step-by-step)
- Error flows with recovery steps
- Edge cases (empty state, limits, mobile)
- State transition diagrams
- Accessibility requirements
- Test matrix

**This spec becomes the north star for all testing.** Must be created BEFORE any implementation code.

Update `meta.md`: User Flow Spec → completed.

### Phase: Deepening

Spawn 1 `deep-plan-deepener` agent:

```
Input: docs/plans/{slug}/initial-plan.md + user-flow-spec.md
Output: docs/plans/{slug}/deepened-plan.md
```

The deepener makes 3 passes:

1. Concreteness — File paths, function signatures, code snippets
2. Completeness — Error handling, edge cases, migration, rollback
3. Actionability — "What to do" + "how to verify" per section

Update `meta.md`: Deepening → completed.

### Phase: Critique

Spawn critic agents **in parallel**:

```
deep-plan-critic-swe        → docs/plans/{slug}/critiques/critique-swe.md
deep-plan-critic-security   → docs/plans/{slug}/critiques/critique-security.md
deep-plan-critic-ux         → docs/plans/{slug}/critiques/critique-ux.md
deep-plan-critic-perf       → docs/plans/{slug}/critiques/critique-perf.md
```

Each reads `deepened-plan.md` AND `user-flow-spec.md`.

If `--critics` flag is set, only spawn the specified critics.
If `--skip-critics` flag is set, skip this phase entirely.

Update `meta.md`: Critique → completed.

### Phase: Q&A

**Run in main conversation** (requires user interaction — unless `--auto-resolve` is set).

1. Read all critique files from `critiques/`
2. Synthesize into `questions.md`:
   - Deduplicate questions across critics
   - Prioritize by severity
   - Group by topic
3. **If `--auto-resolve` flag is set** (used by `/deep-auto`):
   - Read the auto-resolve framework from `references/auto-resolve-framework.md`
   - For each question, apply the decision tree
   - Document each decision with: rule applied, chosen option, evidence, confidence level
   - Mark all answers as `[AUTO-RESOLVED]`
   - Flag low-confidence decisions in the completion summary
4. **If `--auto-resolve` is NOT set** (default interactive mode):
   - Present questions using the format below

#### Question Formatting Rules (IMPORTANT)

```
**Q{N}: {Short title}**
**Source:** {which critic(s) raised this}

{2-3 sentence plain-English explanation of the problem.}

- **(A)** {Option description in plain English}
- **(B)** {Option description in plain English}
- **(C)** {Option description in plain English} *(if applicable)*
```

Write for a product owner, not a developer. Every question must have at least 2 options.

### Phase: Final Plan

Produce `final-plan.md` incorporating all Q&A answers, critique resolutions, and the coverage trace.

This is the **canonical plan artifact** — all downstream phases reference this file.

Update `meta.md`: Final Plan → completed.

### Phase: Plan Verification (MANDATORY — never skip)

#### Check A: Critics Incorporated

Cross-reference every critique resolution in `questions.md` against `final-plan.md`'s task list.

**Gate:** Every resolution maps to a task or an explicit deferral with justification.

#### Check B: User Intention Check

Compare the original user prompt (`prompt.md`) against `final-plan.md`.
**Gate:** Every user intent maps to at least one deliverable.

#### Check C: Coverage Trace

Map every flow from `user-flow-spec.md` to deliverable files and tasks.

```markdown
## Coverage Trace

| Flow                    | Source      | Task # | Deliverable File                   | Status     |
| ----------------------- | ----------- | ------ | ---------------------------------- | ---------- |
| Flow 1: Enqueue         | Plan Task 7 | 7      | src/api/queue.ts                    | ✅         |
| Flow 2: Admin Dashboard | Critique R6 | ??     | ???                                | ❌ MISSING |
```

**Gate:** No ❌ MISSING items remain.

#### Check D: Task Graph

Generate a dependency task graph as `task-graph.md`.

**CRITICAL: Use persistent task storage for all tasks.**

**Gate:** Task graph is complete with all tasks and dependencies.

#### Verification Result

If all four checks pass: Update `meta.md`: Plan Verification → completed.
If any check fails: Loop back to Final Plan (max 2 attempts).

## Resume Logic

On every phase entry, check:

1. Does the expected output file exist and is it non-empty?
2. If yes, skip to next phase.
3. If partially complete, note in meta and continue.
