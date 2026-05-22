# Root Cause Analysis Framework

## The "5 Whys" Method

For each fixup issue, trace the failure through 5 levels of causation. Stop early if you
reach a genuine root cause before level 5.

### Template

```markdown
# RCA: {issue title}

## Category: {REGRESSION | MISSED | SKILL}

## What Happened

{1-2 sentences describing the observable problem}

## 5 Whys

### Why 1: Immediate Cause

{What directly caused the problem}
**Evidence:** {file:line, git diff, test output}

### Why 2: Why Was It Not Prevented?

{What guard should have caught this but didn't}
**Evidence:** {missing test, vague spec section, absent checklist}

### Why 3: Why Was the Guard Missing?

{Why the prevention mechanism didn't exist or was insufficient}
**Evidence:** {spec gap, task breakdown omission, reviewer limitation}

### Why 4: Why Did the Process Allow This Gap?

{What structural weakness in the pipeline created the gap}
**Evidence:** {skill file section, template limitation, phase design}

### Why 5: Root Cause

{The fundamental process issue that, if fixed, prevents this class of problem}
**Proposed fix:** {concrete change to skill/template/checklist}

## Test Coverage Assessment

- **Did a test exist for this behavior?** YES / NO
- **If YES, why didn't it catch the issue?**
   - Test targets wrong behavior
   - Test uses wrong assertions
   - Test passes but doesn't verify the actual UX
   - Test was skipped/disabled
- **If NO, should one have existed?** YES / NO
   - **If YES, which phase should have created it?**
      - Flow spec test matrix
      - Test-writer task in execution
      - Review test-runner
   - **Why wasn't it created?**
      - Not in flow spec test matrix
      - Task breakdown didn't include a test task
      - Test-writer misunderstood the requirement

## Pipeline Phase Attribution

**Which phase should have prevented this?**

| Phase            | Should Have Caught? | Why It Didn't |
| ---------------- | ------------------- | ------------- |
| Plan (deep-plan) | {yes/no}            | {reason}      |
| Spec (flow-spec) | {yes/no}            | {reason}      |
| Deepening        | {yes/no}            | {reason}      |
| Critics          | {yes/no}            | {reason}      |
| Execution        | {yes/no}            | {reason}      |
| Review           | {yes/no}            | {reason}      |

## Process Improvement

**Recommendation:** {concrete change — not "be more careful" but "add X checklist to Y phase"}

**Scope:** {which skill file or template to modify}

**Effort:** {trivial — add a line to a checklist | moderate — new section in a skill | significant — new agent or phase}
```

## Category-Specific Guidance

### REGRESSION RCA

Focus on the test suite. A regression means something worked before and broke. The central
question is: **why didn't the test suite protect us?**

Investigate:

1. `git diff` — What change introduced the regression?
2. `grep` for existing tests covering the affected behavior
3. If tests exist, run them — do they actually pass? Are they testing the right thing?
4. If no tests, check the flow spec test matrix — was this behavior listed?

### MISSED RCA

Focus on the plan-to-code gap. A missed requirement means the plan said to do something
and the code doesn't do it. The central question is: **where did the intent get lost?**

Investigate:

1. Read `final-plan.md` — find the exact section describing this requirement
2. Read `execution/task-breakdown.md` — was there a task for this?
3. If task exists, read the task log — was it marked done? By which implementer?
4. If marked done, check the code — was it implemented incorrectly, or not at all?
5. Read review reports — did any reviewer flag this as missing?

### SKILL RCA

Focus on the skill guidance. A skill issue means the deep-\* toolchain itself made a wrong
decision. The central question is: **where is the skill file insufficient?**

Investigate:

1. Identify which skill file governs the decision that went wrong
2. Read the relevant section — is the rule there? Is it clear? Is it strong enough?
3. If the rule exists, check `docs/plans/{slug}/invariants.md` — was it in the invariants?
4. If in invariants, check compaction — did this happen after a context compaction?
5. If not in invariants, should it be?
