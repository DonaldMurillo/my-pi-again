# Tasks Extension — Gap Analysis & Proposals

## What's Built

### Tools (9/9)
| Tool | Status | Notes |
|------|--------|-------|
| TodoWrite | ✅ | In-memory only, ephemeral |
| TaskCreate | ✅ | Full schema, auto-block detection |
| TaskUpdate | ✅ | Status transitions, auto-block/unblock |
| TaskGet | ✅ | Full task details |
| TaskList | ✅ | Filters, sorting |
| TaskSearch | ✅ | Full-text search |
| TaskNext | ✅ | Priority-aware, dep-respecting |
| TaskDecompose | ✅ | Sequential/parallel strategies |
| TaskArchive | ✅ | Monthly archive files |

### Hooks (5/6 designed)
| Hook | Status | Notes |
|------|--------|-------|
| before_agent_start | ✅ | System prompt injection with pseudo-XML tags |
| session_start (recovery) | ✅ | Warns about in-progress tasks |
| session_start (widget) | ✅ | Refreshes widget |
| stop | ✅ | Warns if incomplete tasks |
| before_tool_call (verify) | ✅ | Auto-verifies AC on bash match |
| PreToolUse (auto-block) | ❌ | See GAP-1 |

### Smart Behaviors (4/5 designed)
| Behavior | Status | Notes |
|----------|--------|-------|
| Auto-block detection | ✅ | Can't start if blockers incomplete |
| Auto-unblock dependents | ✅ | Completing task unblocks dependents |
| Auto-branch | ❌ | See GAP-2 |
| Session recovery | ✅ | Warns on session start |
| TodoWrite sync | ✅ | Replaced with in-memory model |

### Cross-Extension Integration
| Integration | Status | Notes |
|-------------|--------|-------|
| Event bus emissions | ✅ | task:created, task:completed, etc. |
| Messenger notifications | ✅ | Assign/complete/unblock |
| Worktree owner field | ✅ | Convention-based |
| Worktree orphan cleanup | ❌ | See GAP-3 |
| Auto-spawn worktree | ❌ | See GAP-4 |

### TUI
| Feature | Status | Notes |
|---------|--------|-------|
| TodoWrite widget | ✅ | Amber/warning colors |
| Tasks widget | ✅ | Blue/accent colors |
| Footer status | ✅ | Compact counts |
| `/tasks` interactive board | ✅ | Filter, expand, navigate |
| Strikethrough completed | ✅ | Via theme.strikethrough |

### Testing
| Category | Count | Status |
|----------|-------|--------|
| Happy paths | 9 | ✅ All passing |
| Dependencies | 4 | ✅ All passing |
| Edge cases | 9 | ✅ All passing |
| Adversarial | 9 | ✅ All passing |
| Invariants | 5 | ✅ All passing |

---

## Gaps

### GAP-1: before_tool_call auto-block not preventing tool execution
The `before_tool_call` hook detects when the agent tries to start a blocked task, but it can only
*warn* via system prompt — it can't actually *prevent* the status change. The TaskUpdate execute
function does the real check, but the hook's warning is too late (the LLM already decided).

**Fix**: The TaskUpdate execute function already overrides status → blocked. The hook is just
redundant. Could remove the hook or make it stronger.

### GAP-2: Auto-branch creation
Design doc says: "When creating a task with no `branch`, optionally create a git branch
`task/<id-slug>` and link it." Not implemented.

**Effort**: Small — 20 lines in TaskCreate execute.
**Risk**: Could create branch pollution. Should be opt-in (metadata flag or config).

### GAP-3: Worktree orphan cleanup
When a worktree is cleaned up (via worktree extension), tasks owned by `worktree:<branch>`
that are still `in_progress` should be reset to `pending`. Requires listening for a
`worktree:cleanup` event on the observability bus.

**Effort**: Small — 15 lines, soft dependency.
**Blocker**: Worktree extension doesn't emit `worktree:cleanup` events yet. Need to add that.

### GAP-4: Auto-spawn worktree on task start
When `TaskUpdate({ status: "in_progress" })` is called on a task with `branch` set but no
worktree agent, the design doc says "auto-suggest: Spawn worktree agent?" Not implemented.

**Effort**: Medium — needs UI interaction (confirm dialog).
**Blocker**: Requires `ctx.ui.confirm()` which works in interactive mode but is awkward for agents.

### GAP-5: Task templates
Design doc mentions `.pi/tasks/templates/bug-fix.json`. Not implemented. Templates would
pre-fill subject, description, labels, acceptance criteria.

**Effort**: Small — read JSON files, merge with TaskCreate params.

### GAP-6: `TaskDecompose` with LLM-powered breakdown
Current implementation requires the caller to pass `subtasks` explicitly. The design doc
envisioned the tool calling the LLM to generate the breakdown automatically.

**Effort**: Large — needs access to the LLM API from within the extension.
**Alternative**: Keep it explicit — the agent IS the LLM, so it can decompose itself.

### GAP-7: GitHub Issue sync
Design doc Phase 5: bidirectional sync between tasks and GitHub Issues. Not implemented.

**Effort**: Large — needs GitHub API integration, webhook or polling, mapping.

### GAP-8: Time tracking display
Time is tracked (startedAt → completedAt → timeSpentSeconds) but never displayed in the
widget or `/tasks` command output. Only shown in verbose `TaskGet` output.

**Effort**: Small — format and display in widget.

### GAP-9: `/tasks` TUI board doesn't show in-progress task details
The `/tasks` overlay shows task list but doesn't show subtask tree, acceptance criteria progress,
or time spent. It's basic list → expand.

**Effort**: Medium — needs richer rendering in the overlay.

### GAP-10: Session resilience — no sessionId tracking
The `sessionId` field exists in the schema but is never set. Session recovery only checks
`status: "in_progress"`, not which session created/owned the task.

**Effort**: Small — pass session ID from context.

### GAP-11: PR linking — no GitHub integration
`branch` and `pr` fields exist but `pr` is never auto-populated. Manual only.

**Effort**: Medium — needs `gh pr` integration.

---

## Proposals

### PROP-1: Task templates
Create `.pi/tasks/templates/` with JSON files that pre-fill TaskCreate fields.
```
.pi/tasks/templates/bug-fix.json
{
  "labels": ["bug"],
  "priority": "high",
  "acceptanceCriteria": [
    { "criterion": "Bug is fixed", "verified": false },
    { "criterion": "Regression test added", "verified": false }
  ]
}
```
New tool: `TaskCreate({ ..., template: "bug-fix" })` merges template defaults.
**Effort**: S. **Value**: High — reduces repetition for common task types.

### PROP-2: Auto-branch (opt-in)
When `TaskCreate({ ..., branch: "auto" })`, create `task/<ulid-prefix>-<slug>` branch.
Only when explicitly requested. Never automatic.
**Effort**: S. **Value**: Medium — nice for feature branches.

### PROP-3: Worktree orphan cleanup
Listen for `worktree:cleanup` events → reset any `in_progress` tasks owned by that worktree
back to `pending` with owner cleared. Also add the event emission to the worktree extension.
**Effort**: S. **Value**: High — prevents stale task state.

### PROP-4: Richer `/tasks` TUI board
Expand the overlay to show:
- Subtask tree (indented under parent)
- Acceptance criteria progress bars
- Time spent
- Owner/worktree assignment
- Inline TaskUpdate (change status with keyboard shortcut)

**Effort**: L. **Value**: High — makes the board actually useful.

### PROP-5: Task context files
When a task is in-progress, auto-track which files the agent touches. Store in
`task.contextFile` as a list. On session resume, show "Last touched: src/auth.ts, tests/auth.test.ts".
**Effort**: M. **Value**: Medium — better session handoff.

### PROP-6: Task verification via `/tasks verify`
Add a keyboard shortcut in the `/tasks` board that runs `verifyCommand` for the selected
task and shows pass/fail in the overlay. Also run on `TaskUpdate({ status: "completed" })`
and block if verification fails.
**Effort**: M. **Value**: High — ensures quality gates.

### PROP-7: Task stats dashboard
`/tasks stats` command showing:
- Tasks completed this week/month
- Average time per task
- Blocked time (how long tasks sit blocked)
- Completion rate by priority
**Effort**: M. **Value**: Medium — project health visibility.

### PROP-8: Export tasks
`/tasks export` → write current task list as markdown to a file. Useful for PR descriptions,
status reports, or handoff docs.
**Effort**: XS. **Value**: Medium — low effort, useful output.

---

## Priority Ranking

| Priority | Item | Effort | Value |
|----------|------|--------|-------|
| 1 | PROP-3: Worktree orphan cleanup | S | High |
| 2 | PROP-1: Task templates | S | High |
| 3 | PROP-8: Export tasks | XS | Medium |
| 4 | GAP-8: Time tracking display | S | Medium |
| 5 | GAP-2: Auto-branch (opt-in) | S | Medium |
| 6 | PROP-6: Verification in board | M | High |
| 7 | PROP-5: Context file tracking | M | Medium |
| 8 | PROP-4: Richer TUI board | L | High |
| 9 | PROP-7: Stats dashboard | M | Medium |
| 10 | GAP-7: GitHub Issue sync | L | Medium |
