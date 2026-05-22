---
name: deep-reflection
description: >
   Self-improving skill that analyzes pipeline failures and user frustration, traces them
   to skill/agent gaps, and proposes concrete amendments. Fixes the immediate problem first,
   then reflects.
imports:
   - feedback-reinforcement
   - intellectual-honesty
invariants:
   - 'Discussion checkpoint is MANDATORY before any skill/agent modification.'
   - 'Analyzer agent is read-only. Only the orchestrator (this skill) writes files.'
   - 'Max one reflection per conversation topic. Circuit breaker prevents loops.'
---

# Deep Reflection Skill

Self-improving skill that traces pipeline failures back to specific skills/agents and proposes
concrete amendments.

## Invocation

```
/deep-reflection                     # Manual trigger — analyze the current issue
/deep-reflection --from-review       # Called by /deep-review with findings as input
```

## Step 1: Identify the Problem

1. If `--from-review`: Read the review findings
2. Otherwise: Analyze the current conversation for friction points
3. Categorize: pipeline failure, user frustration, quality gap, or efficiency issue

## Step 2: Root Cause Analysis

Spawn 1 `deep-reflection-analyzer` agent (read-only):

- Traces the problem back to a specific skill or agent
- Identifies the gap: missing instruction, ambiguous wording, missing edge case
- Proposes a concrete amendment with before/after text

## Step 3: Fix the Immediate Problem

Apply the amendment to the relevant skill/agent file.

**Discussion checkpoint:** Present the proposed amendment to the user before modifying anything.

## Step 4: Feedback Entry

Save the correction to `docs/feedback/` using the `feedback-reinforcement` skill's format.
