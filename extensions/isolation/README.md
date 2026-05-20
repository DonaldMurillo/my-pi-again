# 🔒 Isolation Extension

Restricts the agent to only write/edit/delete files within the conversation's base working directory (`cwd`). Prevents filesystem escapes.

## Features

- **Path sandboxing** — blocks `write` and `edit` tools targeting paths outside `cwd`
- **Bash analysis** — detects destructive bash commands (`rm`, `tee`, redirects) and blocks those targeting external paths
- **Escape hatches** — `/isolation allow <path>` for when you need a specific directory
- **Config file** — `.pi/isolation.json` for persistent settings
- **Home directory protection** — blocks writes to `~` by default

## Commands

| Command | Description |
|---------|-------------|
| `/isolation status` | Show current isolation state |
| `/isolation on` | Enable isolation |
| `/isolation off` | Emergency bypass (writes anywhere) |
| `/isolation allow <path>` | Add escape hatch |
| `/isolation reset` | Clear all escape hatches |

## Configuration

Create `.pi/isolation.json` in your project root:

```json
{
  "enabled": true,
  "allowPaths": ["/tmp/build-output"],
  "blockHomeDirectory": true
}
```

## How It Works

1. On `session_start`, loads config from `.pi/isolation.json`
2. On `tool_call`, checks the tool name:
   - **write/edit** — extracts `path` from input, checks against `cwd` + allow list
   - **bash** — analyzes command for destructive patterns, extracts target paths, checks those
   - **everything else** — passes through (read-only tools are safe)
3. Returns `{ block: true, reason }` for violations

## Files

- `extensions/isolation/index.ts` — extension registration and tool interception
- `extensions/isolation/isolation-helpers.ts` — pure functions (testable)
- `tests/isolation.test.ts` — 13/13 tests covering path resolution and bash analysis
