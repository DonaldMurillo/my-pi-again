# Subagent Extension

Spawn and manage sub-agents for parallel work in pi.

## Features

- **Agent profiles** — Define reusable agents in `.pi/agents/*.md` (pi-native) or `.claude/agents/*.md` (Claude Code compat)
- **Model tiers** — fast (glm-4.5-air), balanced (glm-5-turbo), deep (glm-5.1)
- **RPC subprocess pool** — Each agent is an isolated `pi --mode rpc` process
- **Task integration** — Bind agents to tasks, auto-update on completion, widget sub-items
- **Fan-out** — Parallel dispatch of prompts across multiple agents
- **Event bus API** — Other extensions can spawn/control agents via `pi.events`

## Quick Start

```bash
npm run sync    # sync to ~/.pi/agent/extensions/
pi              # extension auto-loads
```

### Create an agent profile

```bash
/agent create reviewer
```

Edits `.pi/agents/reviewer.md`:

```markdown
---
model: fast
tools: [read, bash, grep, find]
---
You are a code reviewer. Focus on security, performance, and correctness.
Never write code — only read and review.
```

### Use the tool

```
subagent({ action: "spawn", name: "review", profile: "reviewer", prompt: "Review src/auth/*.ts" })
subagent({ action: "status" })
subagent({ action: "collect", name: "review" })
subagent({ action: "kill", name: "review" })
```

### Fan-out parallel work

```
subagent({
  action: "fanout",
  items: [
    { prompt: "Review src/auth/*.ts for security" },
    { prompt: "Review src/api/*.ts for performance" },
    { prompt: "Review src/utils/*.ts for error handling" }
  ],
  profile: "fast",
  concurrency: 3
})
```

## Agent File Format

### Pi-native (`.pi/agents/*.md`)

```markdown
---
model: fast
tools: [read, bash, grep, find]
---
System prompt for the agent goes here.
```

| Field | Default | Description |
|-------|---------|-------------|
| `model` | `balanced` | Model tier: `fast`, `balanced`, `deep` |
| `tools` | `null` (inherit) | Tool whitelist. `[]` = no tools, `null` = inherit from parent |

### Claude Code compat (`.claude/agents/*.md`)

Plain markdown — no frontmatter. Inherits all parent tools and uses the default model tier.

```markdown
You are a code reviewer. Be concise and focused.
```

## Model Tiers

| Tier | Model | Use case |
|------|-------|----------|
| `fast` | glm-4.5-air | Simple tasks, formatting, boilerplate |
| `balanced` | glm-5-turbo | Most coding tasks |
| `deep` | glm-5.1 | Architecture, reviews, complex bugs |

Override per-project in `.pi/agent-models.json`:

```json
{
  "tiers": {
    "fast": { "provider": "openai", "model": "gpt-4o-mini" }
  }
}
```

## Tool API

```
subagent({
  action: "spawn" | "send" | "collect" | "kill" | "status" | "fanout" | "list-profiles",

  // Spawn/Send options
  name?: string,          // Agent name (required for spawn, send, collect, kill)
  profile?: string,       // Profile from .pi/agents/ or .claude/agents/
  prompt?: string,        // Initial prompt or follow-up message
  task?: string,          // Task ID to bind
  model?: string,         // Tier override: fast, balanced, deep
  tools?: string[],       // Tool whitelist override

  // Fanout options
  items?: Array<{ prompt: string; task?: string }>,
  concurrency?: number,   // Default: 3
  failFast?: boolean,     // Default: false
})
```

## Commands

| Command | Description |
|---------|-------------|
| `/agent create <name>` | Create a new agent profile |
| `/agent list` | List available profiles |
| `/agents` | Show running sub-agents |

## Event Bus API

Other extensions can control subagents via `pi.events`:

### Inbound (you → subagent)

```typescript
pi.events.emit("subagent:spawn", {
  name: "my-agent",
  profile: "reviewer",    // optional
  prompt: "Review this",  // optional
  task: "task-id",        // optional
  model: "fast",          // optional
});

pi.events.emit("subagent:send", {
  name: "my-agent",
  prompt: "Also check this",
});

pi.events.emit("subagent:kill", {
  name: "my-agent",
  reason: "done",  // optional
});
```

### Outbound (subagent → you)

```typescript
pi.events.on("subagent:spawned", (data) => {
  // { name, profile, model, task, pid }
});

pi.events.on("subagent:completed", (data) => {
  // { name, task, status: "done"|"failed", output, turns, cost, duration, resultFile, error }
});

pi.events.on("subagent:turn", (data) => {
  // { name, prompt, turnCount }
});

pi.events.on("subagent:killed", (data) => {
  // { name, reason }
});
```

## Task Integration

When an agent is bound to a task, the task widget shows:

```
● 🔥 [01KS3QHA] Refactor auth module
  └── agent:fixer ● working (glm-4.5-air) turn 2  $0.0023
```

On completion:
- Task status auto-updates (completed or blocked)
- Result saved to `.pi/agents/results/<name>.json`
- Cost and turn count recorded in task metadata

## Architecture

```
extensions/subagent/
├── index.ts              # Extension entry, tool, commands, widget
├── api.ts                # Unified API surface (tool + event bus)
├── agent-pool.ts         # RPC subprocess pool
├── agent-profile.ts      # Profile discovery & parsing
├── model-tiers.ts        # GLM tier config & resolution
├── task-bridge.ts        # Task widget + auto-update
├── fanout.ts             # Parallel dispatch helpers
├── models.json           # Default GLM tier config
├── e2e.test.ts           # Full pipeline tests
└── README.md             # This file
```

## Testing

```bash
# Unit tests (fast)
npx vitest run extensions/subagent/

# Just E2E (slow, needs pi)
npx vitest run extensions/subagent/e2e.test.ts

# All tests
npx vitest run
```

102 tests across 8 files. E2E tests use real `pi --mode rpc` subprocesses.
