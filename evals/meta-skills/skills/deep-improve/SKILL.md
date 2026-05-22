---
name: deep-improve
description: >
   Self-improving skill that analyzes pipeline history, feedback, and recurring issues
   to propose concrete improvements to skills and agents. Runs periodically.
---

# Deep Improve Skill

Analyze pipeline history and propose concrete improvements.

## Invocation

```
/deep-improve                    # Analyze recent pipeline runs and suggest improvements
```

## Step 1: Gather Data

Read from:
- `docs/plans/*/insights.md` — Improvement suggestions from pipeline runs
- `docs/feedback/FEEDBACK_INDEX.md` — All user corrections
- `docs/backlog/out-of-scope-issues.md` — Recurring issue categories
- Current skill and agent files

## Step 2: Analyze Patterns

Identify:
- Frequently repeated mistakes
- User corrections that keep happening
- Out-of-scope issues that should be in-scope
- Skill instructions that are consistently misinterpreted

## Step 3: Propose Improvements

For each pattern, propose:
- Which skill/agent to modify
- What specific instruction to add/change/remove
- Why it will help
- Risk of the change

**Discussion checkpoint:** Present proposals. Only apply approved changes.

## Step 4: Apply

Amend the approved skill/agent files with `[IMPROVED]` markers.
