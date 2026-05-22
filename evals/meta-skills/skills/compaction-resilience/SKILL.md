---
name: compaction-resilience
description: >
   Protocol for preserving critical skill invariants across context compaction.
   Imported by orchestrator skills (deep-plan, deep-execute, deep-review, deep-auto).
   Uses PreCompact + PostCompact hooks to ensure non-negotiable rules survive context loss.
---

# Compaction Resilience

Long-running orchestrator skills (deep-plan, deep-execute, deep-review, deep-auto) often hit
context compaction. When compaction fires, critical rules can lose their weight — the model
"remembers" the rule existed but no longer treats it as non-negotiable. This skill provides
a protocol to prevent that.

## Architecture

```
Skill activates → writes invariants to docs/plans/{slug}/invariants.md
                         ↓
PreCompact hook  → reads invariants.md → writes .compaction-payload.md (distilled)
                         ↓
PostCompact hook → reads .compaction-payload.md → injects as systemMessage
```

## How It Works

### 1. Invariants Declaration (Frontmatter)

Each orchestrator skill declares its invariants in YAML frontmatter:

```yaml
---
name: deep-review
invariants:
   - '0 test failures for PASS — no out-of-scope dismissals for test failures'
   - 'In-scope/out-of-scope triage applies ONLY to code review findings'
imports:
   - compaction-resilience
---
```

Invariants are terse, actionable rules — not explanations. They should read like a checklist.

### 2. Activation Protocol (Step 0 of each orchestrator)

When an orchestrator skill starts with a slug, it MUST write invariants:

```
1. Read own frontmatter `invariants:` block
2. Write docs/plans/{slug}/invariants.md with:
   - Skill name
   - All invariants (verbatim from frontmatter)
   - File reference to re-read full rules
   - Activation timestamp
```

**Template for `docs/plans/{slug}/invariants.md`:**

```markdown
# Active Invariants

## {skill-name}

**Activated:** {ISO timestamp}
**Full rules:** .claude/skills/{skill-name}/SKILL.md

### Rules (non-negotiable)

- {invariant 1}
- {invariant 2}
- ...
```

Multiple skills can be active for the same slug (e.g., deep-auto activates deep-plan,
then deep-execute, then deep-review). Each appends its section. The file accumulates.

### 3. PreCompact Hook

The `pre-compact.js` hook fires before context compaction:

1. Globs `docs/plans/*/invariants.md` in the project directory
2. Reads all invariant files found
3. Distills into `docs/plans/{slug}/.compaction-payload.md`:
   - Keeps invariant rules verbatim (they're already terse)
   - Adds file references for full re-read
   - Strips any verbose context
4. Outputs the payload as stdout so it's captured in the compaction summary

### 4. PostCompact Hook

The `post-compact.js` hook fires after context compaction:

1. Globs `docs/plans/*/.compaction-payload.md` in the project directory
2. Reads all payload files found
3. Injects as `systemMessage` — this lands at the top of fresh post-compaction context

The systemMessage format:

```
⚠️ COMPACTION RESILIENCE: The following invariants are ACTIVE and NON-NEGOTIABLE.
They were declared by orchestrator skills and MUST be followed regardless of what
the compacted summary says. When in doubt, re-read the referenced skill file.

[invariants content]
```

## Adding Invariants to a New Skill

1. Add `invariants:` to your skill's frontmatter
2. Add `imports: [compaction-resilience]` to your frontmatter
3. In your Step 0, add the invariant-writing step (copy from any orchestrator)
4. That's it — the hooks handle the rest

## Design Principles

- **Declarative** — Invariants live in frontmatter, not scattered through prose
- **Terse** — Each invariant is one line. No explanations in the payload (those are in the skill file)
- **Scoped to plan** — Invariants live in `docs/plans/{slug}/`, not global state
- **Additive** — Multiple skills can register invariants for the same slug
- **Self-cleaning** — Plan directory gets cleaned up when the plan completes or branch is deleted
