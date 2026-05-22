# Feedback Entry Format

Template for saving user corrections to `docs/feedback/{agent-type}/{slug}.md`.

## File Format

```markdown
---
agent: { agent-name }
date: { YYYY-MM-DD }
context: { what you were working on }
tags: [keyword1, keyword2]
---

**Correction:** {What the user said to change}
**Why:** {The reason they gave, or infer from context}
**Apply when:** {When future agents should apply this correction}
```

## Index Entry Format

Append to `docs/feedback/FEEDBACK_INDEX.md`:

```markdown
- [{date}] **{agent-type}**: {one-line summary} → `docs/feedback/{agent-type}/{slug}.md`
```

## Examples

### Critic feedback

```markdown
---
agent: deep-plan-critic-swe
date: 2026-03-15
context: Critiqued plan for "location tracking"
tags: [payloadcms, srp, hooks]
---

**Correction:** Don't flag PayloadCMS collection hooks as SRP violations.
**Why:** These are framework conventions, not design choices.
**Apply when:** Reviewing any plan that involves PayloadCMS collections.
```

### Research feedback

```markdown
---
agent: deep-plan-researcher
date: 2026-03-12
context: Researching patterns for "item export"
tags: [queries, src/lib]
---

**Correction:** Always check src/lib/queries/ before suggesting new query helpers.
**Why:** There are many existing helpers that cover common patterns.
**Apply when:** Doing pattern research for any feature.
```
