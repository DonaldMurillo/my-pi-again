# Tasks Extension — Design Doc

## Goal

A pi extension that gives the agent a powerful, persistent task management system. Goes beyond Claude Code's built-in TodoWrite/TaskCreate while being API-compatible so agents/skills that reference those tools "just work."

## Principles

1. **Drop-in compatible** — if a skill says "use TodoWrite" or "use TaskCreate", our extension intercepts and handles it
2. **Pi-native storage** — everything lives under `.pi/tasks/`, not `.claude/`
3. **File-based** — JSON files, git-friendly, human-readable
4. **Session-resilient** — survives `/clear`, compaction, restarts
5. **Event-emitting** — fires events on the observability bus so other extensions can react
6. **Extensible** — metadata bag, templates, custom fields, verification commands

## Claude Code Compatibility Layer

Claude Code has 6 built-in task tools. Our extension registers tools with the **same names** so when a Claude Code skill/agent references them, pi uses our implementation instead:

| Claude Code Tool | Our Tool | Notes |
|---|---|---|
| `TodoWrite` | `TodoWrite` | Enhanced: writes to disk, emits events |
| `TaskCreate` | `TaskCreate` | Enhanced: richer schema, persistence |
| `TaskUpdate` | `TaskUpdate` | Enhanced: more status options, transitions |
| `TaskGet` | `TaskGet` | Direct passthrough |
| `TaskList` | `TaskList` | Enhanced: filtering, grouping |
| — | `TaskSearch` | **New**: full-text search across tasks |
| — | `TaskDecompose` | **New**: LLM-powered task breakdown |
| — | `TaskNext` | **New**: get next actionable task (respects deps) |
| — | `TaskArchive` | **New**: archive completed tasks |

## Storage

```
.pi/tasks/
├── .gitignore          # auto-created: ignores everything in this dir
├── tasks.json          # all active tasks (fast reads, atomic writes)
├── archive/            # completed/archived tasks by month
│   └── 2025-05.json
└── templates/          # optional task templates
    └── bug-fix.json
```

Single `tasks.json` for active tasks (fast, atomic writes). Archive on demand.

### Auto-gitignore

Task state is local workspace state — it should never be committed. On first
write, the extension:

1. Creates `.pi/tasks/.gitignore` containing `*` (ignore everything in the dir)
2. Also appends `.pi/tasks/` to the project root `.gitignore` as a safety net

This follows the same pattern as `.pi/worktrees/` and `.pi/messages/` already
in this project's `.gitignore`.

## Task Schema

```typescript
interface Task {
  // Core (matches Claude Code)
  id: string;                    // ulid — sortable, unique
  subject: string;               // brief title
  description: string;           // what to do (markdown)
  activeForm?: string;           // spinner text e.g. "Running tests"
  status: TaskStatus;
  owner?: string;                // "main" | "worktree:branch" | agent name
  
  // Dependencies (matches Claude Code)
  blocks: string[];              // task IDs this task blocks
  blockedBy: string[];           // task IDs blocking this task
  
  // Extended schema
  priority: "critical" | "high" | "medium" | "low";
  effort?: "xs" | "s" | "m" | "l" | "xl";
  labels: string[];              // arbitrary tags
  parentTaskId?: string;         // for subtasks
  subtasks?: string[];           // child task IDs
  
  // Verification
  acceptanceCriteria?: AcceptanceCriterion[];
  verifyCommand?: string;        // shell command to verify completion
  
  // Time tracking
  createdAt: number;             // epoch ms
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeSpentSeconds?: number;     // accumulated work time
  
  // Session resilience
  sessionId?: string;            // which session created this
  contextFile?: string;          // file path with relevant context
  
  // Git integration
  branch?: string;               // associated git branch
  pr?: number;                   // associated PR number
  
  // Extensibility
  metadata: Record<string, unknown>;
  template?: string;             // which template was used
  source?: "claude-code" | "pi" | "github-issue" | "user" | "auto";
}

type TaskStatus =
  | "pending"       // not started
  | "in_progress"   // actively being worked on
  | "completed"     // done
  | "blocked"       // waiting on dependencies
  | "review"        // needs review
  | "deleted";      // soft delete (matches Claude Code)

interface AcceptanceCriterion {
  criterion: string;
  verified: boolean;
  verifiedAt?: number;
}
```

## Tools Detail

### `TodoWrite` (compatible)
```typescript
{
  todos: {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
  }[];
}
```
**Behavior**: Upserts tasks by matching `content`. Creates new tasks for items not in the list, marks missing items as completed. This mimics Claude Code's "replace the whole list" semantics but persists to `.pi/tasks/`.

### `TaskCreate` (compatible + extended)
```typescript
{
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  
  // Extended (optional, ignored by Claude Code)
  priority?: "critical" | "high" | "medium" | "low";
  effort?: "xs" | "s" | "m" | "l" | "xl";
  labels?: string[];
  parentTaskId?: string;
  blocks?: string[];
  blockedBy?: string[];
  acceptanceCriteria?: string[];
  verifyCommand?: string;
  branch?: string;
  template?: string;
}
```

### `TaskUpdate` (compatible + extended)
```typescript
{
  taskId: string;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: "pending" | "in_progress" | "completed" | "blocked" | "review" | "deleted";
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;  // null values delete keys
  
  // Extended
  priority?: "critical" | "high" | "medium" | "low";
  effort?: "xs" | "s" | "m" | "l" | "xl";
  labels?: { add?: string[]; remove?: string[] };
  acceptanceCriteria?: { index: number; verified: boolean }[];
  branch?: string;
  pr?: number;
}
```

### `TaskGet` (compatible)
```typescript
{ taskId: string }
```
Returns full task object.

### `TaskList` (compatible + extended)
```typescript
{
  status?: TaskStatus | TaskStatus[];
  owner?: string;
  labels?: string[];
  priority?: string;
  parentTaskId?: string | null;  // null = top-level only
  limit?: number;
  sort?: "created" | "priority" | "effort" | "updated";
}
```

### `TaskNext` (new)
```typescript
{
  owner?: string;   // filter by owner
  labels?: string[]; // must have all labels
}
```
Returns the highest-priority task that is:
1. `status: "pending"`
2. All `blockedBy` tasks are `completed`
3. Sorted by priority → creation time

### `TaskDecompose` (new)
```typescript
{
  taskId: string;
  strategy?: "sequential" | "parallel" | "phases";
}
```
Uses the LLM to break a large task into subtasks with dependency relationships. Returns the created subtask IDs.

### `TaskArchive` (new)
```typescript
{
  status?: "completed" | "deleted";
  olderThan?: number;  // epoch ms
}
```
Moves tasks out of active `tasks.json` into archive files.

## Commands

| Command | Description |
|---|---|
| `/tasks` | Interactive task board (TUI component) |
| `/tasks list` | Print all tasks to chat |
| `/tasks next` | Show next actionable task |
| `/tasks create` | Interactive task creation wizard |
| `/tasks archive` | Archive completed tasks |
| `/tasks clean` | Remove archived files |

## Events (observability bus)

```typescript
bus.emit("task:created", { taskId, source });
bus.emit("task:updated", { taskId, changes: string[] });
bus.emit("task:completed", { taskId, timeSpentSeconds });
bus.emit("task:blocked", { taskId, blockedBy: string[] });
bus.emit("task:unblocked", { taskId }); // when all blockers complete
bus.emit("tasks:archived", { count });
```

## Hooks

- **session_start**: Load tasks from `.pi/tasks/tasks.json`, emit summary
- **stop**: Check if all tasks are completed, warn if not
- **PreToolUse** (bash): If a `verifyCommand` is set on the in-progress task and the bash command matches, auto-verify acceptance criteria

## Smart Behaviors

1. **Auto-block detection**: When `TaskUpdate(status: "in_progress")` is called, check if all `blockedBy` tasks are completed. If not, set status to `blocked` instead and warn.

2. **Auto-unblock**: When a task is marked `completed`, check all tasks that it `blocks`. If all their `blockedBy` are now complete, emit `task:unblocked`.

3. **Auto-branch**: When creating a task with no `branch`, optionally create a git branch `task/<id-slug>` and link it.

4. **Session recovery**: On session start, check for tasks with `status: "in_progress"` from a previous session and prompt to resume or reset.

5. **TodoWrite sync**: When `TodoWrite` is called, map the flat list to existing tasks. New items get created, completed items get marked done, removed items get marked completed.

## File Format

```json
{
  "version": 1,
  "projectId": "my-pi-again",
  "tasks": {
    "01JX5QR...": { ... },
    "01JX5QS...": { ... }
  },
  "nextOrder": 3,
  "updatedAt": 1716200000000
}
```

Tasks keyed by ID for O(1) lookup. Ordered by insertion (ULIDs are time-sortable).

## Cross-Extension Integration

### Worktree Integration

Tasks and worktrees have a natural 1:1 relationship — a task represents work
to be done, a worktree provides the isolated workspace to do it in.

**`owner` field convention:**
- `"main"` — owned by the main session (default)
- `"worktree:<branch>"` — assigned to a worktree agent
- `"<agent-name>"` — assigned to a named agent

**TaskCreate + Worktree flow:**
```
1. TaskCreate({ subject: "Add auth", branch: "feat/auth" })
   → creates task, sets task.branch = "feat/auth"

2. TaskUpdate({ taskId, status: "in_progress" })
   → extension sees task.branch is set, task has no worktree yet
   → auto-suggests: "Spawn worktree agent for feat/auth to work on this?"
   → if confirmed: worktree create + spawn, sets task.owner = "worktree:feat/auth"

3. Worktree agent completes work
   → agent calls TaskUpdate({ taskId, status: "completed" })
   → extension emits task:completed, auto-unblocks dependents
```

**TaskNext aware of worktrees:**
When `TaskNext` returns a task that has `branch` set, the response includes
a hint: `"This task has branch 'feat/auth'. Consider spawning a worktree agent."`

**Smart assignment:**
`TaskUpdate({ owner: "worktree:auto" })` picks the first idle worktree agent.
If none exist, prompts to create one.

**Cleanup:**
When a worktree is cleaned up (via the worktree extension), any task with
`owner: "worktree:<branch>"` that is still `in_progress` gets set back to
`pending` with owner cleared, so it's not orphaned.

**How it works technically:**
- Tasks extension imports from `../worktree/worktree-manager.js` to call
  `getManagedWorktrees()`, `getAgent()`, `spawnAgent()` directly
- Listens for `worktree:cleanup` events on the bus (if worktree extension
  emits them) to handle orphaned tasks
- No runtime dependency — if worktree extension isn't loaded, task.branch
  is just a string field, no worktree features activate

### Messenger Integration

Tasks use the messenger to coordinate between main session and worktree agents.

**Task assignment via messenger:**
When a task is assigned to `"worktree:feat/auth"`:
```
messenger.send("feat/auth", 
  "Assigned task #01JX5QR: Add auth\n" +
  "Description: Implement JWT auth...\n" +
  "Acceptance criteria: ...\n" +
  "Mark completed with TaskUpdate({ taskId: '01JX5QR', status: 'completed' })"
)
```

**Task completion notifications:**
When a task is completed, broadcast to all agents:
```
messenger.broadcast("Task #01JX5QR 'Add auth' completed by worktree:feat/auth")
```
This lets blocked agents know to check if they're now unblocked.

**Dependency resolution via messages:**
When task B is blocked by task A, and task A completes:
```
messenger.send("worktree:feat/B", 
  "Unblocked! Task #A 'Add auth' is complete. You can start now."
)
```

**How it works technically:**
- Tasks extension imports from `../messenger/message-bus.js`
- Creates a `MessageBus` instance with `agentName: "tasks"`
- On task events that require notification, calls `bus.send()` / `bus.broadcast()`
- No runtime dependency — if messenger extension isn't loaded, messages
  are still written to `.pi/messages/` (the bus is just file I/O)

### Event Bus Integration

The tasks extension emits events via the observability bus:

```typescript
import { bus } from "../observability/bus.js";

bus.emit("task:created", { taskId, source, subject });
bus.emit("task:updated", { taskId, changes: string[] });
bus.emit("task:completed", { taskId, timeSpentSeconds });
bus.emit("task:blocked", { taskId, blockedBy: string[] });
bus.emit("task:unblocked", { taskId });
bus.emit("task:assigned", { taskId, owner });
bus.emit("tasks:archived", { count });
```

Other extensions can subscribe:
```typescript
bus.on("task:completed", ({ taskId }) => { ... });
bus.on("task:unblocked", ({ taskId }) => { ... });
```

## Compatibility Notes

- When running in a Claude Code repo, agents/skills that call `TodoWrite` or `TaskCreate` hit our tools
- Our tools store under `.pi/tasks/`, never write to `.claude/`
- If `.claude/` has existing task data we don't touch it — we start fresh in `.pi/`
- The `activeForm` field is preserved exactly for Claude Code agent spinners
- `metadata` from Claude Code calls is stored as-is in our `metadata` bag

## Implementation Plan

1. **Phase 1**: Core storage layer (with auto-gitignore) + all 5 Claude Code compatible tools + `/tasks` command
2. **Phase 2**: Worktree integration (auto-assign, spawn-on-start), messenger notifications, event bus
3. **Phase 3**: `TaskNext`, `TaskDecompose` (LLM-powered), verification commands, templates
4. **Phase 4**: TUI component for `/tasks`, time tracking, archive management
5. **Phase 5**: Git integration (auto-branch, PR linking), GitHub Issue sync
