---
name: cmux
description: How to use cmux tools to interact with other terminal surfaces — Claude Code instances, pi agents, browsers. Triggers when you need to find, read, send to, or converse with another terminal surface. Always prefer cmux tools over bash commands like cmux list-pane-surfaces, ps, or cmux tree.
---

# cmux Surface Interaction

## Finding Surfaces

**Always start with `cmux_surfaces()`** — it lists all surfaces with auto-detected agent types:

```
cmux_surfaces()
→ surface:6  "✳ Claude Code" (Claude Code)
→ surface:9  "π - my-pi-again" (pi)
```

Agent types detected: `Claude Code`, `pi`, `browser`, `unknown`.

## Target Resolution

The `target` parameter in all tools resolves in this order:
1. Exact surface ref: `"surface:6"`
2. Exact title match
3. Fuzzy title contains: `"Claude"` matches `"✳ Claude Code"`
4. If multiple matches, the first one wins — use exact ref to disambiguate

## Talking to Claude Code

```javascript
// Simple prompt
cmux_prompt({ target: "Claude", prompt: "Explain this function" })

// With timeout
cmux_prompt({ target: "surface:11", prompt: "Review this code", timeoutMs: 60000 })

// Send a slash command
cmux_send({ target: "Claude", text: "/compact" })

// Read what's currently on screen
cmux_read({ target: "Claude" })
```

### Idle Detection

`cmux_prompt` waits for Claude Code to finish responding before returning. It detects idle state by looking for the `← for agents` indicator in Claude Code's status bar and an empty `❯` prompt.

### Response Extraction

By default `cmux_prompt` returns only the latest response (between the last two `❯` prompts). Use `returnFull: true` to get the entire terminal buffer.

## Common Patterns

### Delegate work to Claude Code
```
cmux_prompt({ target: "Claude", prompt: "Implement the auth middleware in src/middleware/auth.ts" })
```

### Check multiple Claude Code instances
```
cmux_surfaces()  // lists all, tagged with agent type
// Then target specific ones by ref
cmux_prompt({ target: "surface:6", prompt: "..." })
cmux_prompt({ target: "surface:11", prompt: "..." })
```

### Fire-and-forget command
```
cmux_send({ target: "surface:4", text: "npm test", pressEnter: true })
```

## What NOT to do

- Don't use `bash` to run `cmux list-pane-surfaces` — use `cmux_surfaces()`
- Don't use `bash` to run `ps` to detect agents — detection is built in
- Don't use `bash` to run `cmux tree` — the tools handle this internally
- Don't manually parse TTY mappings — `detectAgents()` does this for you
