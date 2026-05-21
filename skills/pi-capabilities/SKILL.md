---
name: pi-capabilities
description: Reference for pi's built-in tools and extensions. Auto-loads when the agent needs to list surfaces, talk to other terminals, manage tasks, use sub-agents, interact with cmux, view files, check isolation, or any operation that has a dedicated tool. Use whenever the agent considers using bash to replicate functionality that already exists as a pi tool or extension.
---

# Pi Capabilities

You have access to powerful tools and extensions beyond bash. **Always prefer built-in tools over raw shell commands.**

## cmux Integration

You run inside cmux. Interact with other terminal surfaces directly.

| Tool | Purpose |
|------|---------|
| `cmux_surfaces()` | List all surfaces with agent type detection (Claude Code, pi, browser) |
| `cmux_read({ target })` | Read visible text from any surface |
| `cmux_send({ target, text, pressEnter? })` | Inject text into a surface (fire-and-forget) |
| `cmux_prompt({ target, prompt, timeoutMs? })` | Full round-trip: send prompt → wait → get response |

**Target resolution:** exact ref → exact title → fuzzy title → agent type match.

### Common mistakes to avoid

- ❌ `cmux list-pane-surfaces` via bash — use `cmux_surfaces()`
- ❌ `ps` to detect agents — agent detection is built into `cmux_surfaces()`
- ❌ `cmux tree --all` manually — tools do this internally
- ✅ Just call `cmux_surfaces()` to get a tagged list with agent types

## File Viewing

| Tool | Purpose |
|------|---------|
| `view_file({ path, line? })` | Open file in syntax-highlighted overlay. Supports directories for file tree. |
| `diff_file({ path, staged?, oldPath?, newPath? })` | Show inline diff for git diffs or file comparisons |

## Assistants

| Tool | Purpose |
|------|---------|
| `activate_assistant({ name })` | Open interactive assistant modal (debugger, coder, reviewer, are-we-there-yet) |
| `send_assistant_context({ context, label? })` | Send extra info to the active assistant |

**Command:** `/assistant` to open modal, `/assistant activate|deactivate`

## Isolation

Filesystem isolation restricts writes to the project directory. Ambiguous commands go to an LLM judge.

**Command:** `/isolation [status|allow <path>|deny <path>|enable|disable]`

Automatic — hooks into `tool_call` events to intercept blocked writes.

## Observability

Shared event bus with lifecycle hooks, error tracking, and event log.

**Command:** `/observe` — modal showing agent state, event log, and errors

## Context Viewer

**Command:** `/context` — overlay showing token usage breakdown

## Custom Pi Info

**Command:** `/custom-pi` — overlay showing git branch, model, isolation config

## Meta-Skills

Bridges skills from Claude, Cursor, Copilot ecosystems into pi.

**Command:** `/meta-skills [list|scan|status|sources]`

## Task Management

| Tool | Purpose |
|------|---------|
| `TaskCreate({ subject, ... })` | Create a structured task |
| `TaskUpdate({ taskId, ... })` | Update status, labels, dependencies |
| `TaskGet({ taskId })` | Get full task details |
| `TaskList({ ... })` | List/filter tasks |
| `TaskSearch({ query })` | Search tasks by text |
| `TaskNext()` | Get highest-priority actionable task |
| `TaskDecompose({ taskId, subtasks })` | Break task into subtasks with deps |
| `TaskArchive()` | Archive completed/deleted tasks |
| `TodoWrite({ todos })` | Replace in-memory todo list |

**Command:** `/tasks` — interactive task board overlay

## Sub-agents & Worktrees

| Tool | Purpose |
|------|---------|
| `subagent({ action: "spawn", ... })` | Spawn a named sub-agent |
| `subagent({ action: "fanout", ... })` | Parallel dispatch across items |
| `worktree({ action: "create", ... })` | Create git worktree + agent |
| `worktree({ action: "send", ... })` | Message a worktree agent |

## Messenger

| Action | Purpose |
|--------|---------|
| `messenger({ action: "send", to, body })` | Send message to another agent |
| `messenger({ action: "inbox" })` | Read your inbox |
| `messenger({ action: "agents" })` | List known agents |
