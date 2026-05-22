# Task Breakdown Template

Template for `execution/task-breakdown.md`.

```markdown
# Execution Tasks: {plan title}

## Dependency Graph
```

Batch 1: [1.1 Task] [1.2 Task]
↓ ↓
Batch 2: [2.1 Task] ←──┘
↓
Batch 3: [3.1 Task] [3.2 Task]

```

## Batch 1 (parallel)

### Task 1.1: {title}
- **Worker:** deep-execute-implementer | deep-execute-test-writer | manual
- **Input:** {context/files needed}
- **Changes:** {files to create/modify}
- **Acceptance Criteria:**
  - [ ] Criterion 1
  - [ ] Criterion 2
- **Lint gate:** `pnpm lint && pnpm build`

## Batch 2 (depends on Batch 1)

### Task 2.1: {title}
- **Depends on:** Task 1.1, Task 1.2
- **Worker:** ...
```

## Granularity Rules

- One concern per task
- Max 3 files per task
- Self-contained with clear input/output
- Verifiable acceptance criteria
