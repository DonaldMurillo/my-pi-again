---
name: feedback-reinforcement
description: >
   Shared skill for all deep-plan, deep-execute, and deep-review agents. Provides two
   capabilities: (1) Surface past user corrections relevant to the current task, and
   (2) Save new corrections when the user overrides an agent's output. Feedback is stored
   in docs/feedback/ as committable markdown files with a searchable index.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Feedback Reinforcement Skill

This skill gives agents a learning loop. When loaded, agents can recall past user corrections and save new ones.

## 1. Surface Past Feedback (On Agent Startup)

At the start of your task, check for relevant past corrections:

```
1. Read docs/feedback/FEEDBACK_INDEX.md (if it exists)
2. Scan for entries matching your agent type or the current feature area
3. Read the relevant feedback files
4. Apply corrections to your current work
```

**How to search:**

- By agent type: Look for entries under your agent name (e.g., `deep-plan-critic-swe`)
- By topic: Grep for keywords related to the current task
- By recency: Prioritize recent feedback over old
- **Also search `docs/solutions/`** — Grep for keywords related to the current task in the solutions knowledge base. Solutions contain reusable patterns discovered in past plans.

**How to apply:**

- Include a `## Relevant Past Feedback` section at the top of your output
- List each applicable correction with date and summary
- If a past correction conflicts with your current analysis, note the conflict and defer to the correction

## 2. Save New Feedback (When User Corrects You)

When the user rejects, modifies, or overrides your output, save a feedback entry.

### Feedback File Format

Save to `docs/feedback/{agent-type}/{slug}.md`:

```markdown
---
agent: { your-agent-name }
date: { YYYY-MM-DD }
context: { what you were working on }
tags: [keyword1, keyword2]
---

**Correction:** {What the user said to change}
**Why:** {The reason they gave, or infer from context}
**Apply when:** {When future agents should apply this correction}
```

### Update the Index

Append to `docs/feedback/FEEDBACK_INDEX.md`:

```markdown
- [{date}] **{agent-type}**: {one-line summary} → `docs/feedback/{agent-type}/{slug}.md`
```

### Create Index if Missing

If `docs/feedback/FEEDBACK_INDEX.md` doesn't exist, create it:

```markdown
# Feedback Index

Searchable index of user corrections across all agents.

## Entries
```

### Create Agent Directory if Missing

If `docs/feedback/{agent-type}/` doesn't exist, create it before saving.

## 3. When to Save Feedback

Save feedback when the user:

- **Rejects a critique** — "Don't flag X as a problem"
- **Corrects a recommendation** — "No, use Y pattern instead of Z"
- **Overrides a plan section** — "That's wrong, it should be..."
- **Adds a missing consideration** — "You missed that we always need to..."
- **Expresses a preference** — "I prefer X over Y for this project"

**Do NOT save feedback for:**

- One-time task-specific instructions ("use this variable name")
- Corrections to factual errors about the current codebase state (just fix it)
- Style preferences already documented in CLAUDE.md

## 4. Feedback Quality Rules

- **Be specific** — "Don't flag framework lifecycle hooks as SRP violations" not "Be less strict about SRP"
- **Include why** — The reason matters more than the rule, for edge case judgment
- **Include when to apply** — Helps future agents know if the feedback is relevant to their task
- **Use tags** — Keywords that help with searchability (e.g., `access-control`, `testing`, `performance`)
- **Deduplicate** — Before saving, check if a similar correction already exists. Update existing entries rather than creating duplicates.
