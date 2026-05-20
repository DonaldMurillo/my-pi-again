# my-pi-again

Pi extensions framework. Source of truth — sync to `~/.pi/agent/extensions/` for deployment.

## Testing Philosophy

**REAL AGENT SESSION TESTS ARE WHAT MATTER.**

Unit tests on helper functions are theater. What proves the system works is:
1. Start a real `pi --mode rpc` subprocess
2. Send real prompts that trigger real tool calls
3. Verify the extensions actually intercept/block/allow those tool calls
4. Check that files are written/blocked correctly on disk
5. Verify event bus events were emitted, messages were delivered, worktrees were created

The test suite should exercise the FULL pipeline: prompt → agent → tool call → extension hook → filesystem. Anything less is a lie.

## Documentation

- [Agent Idle Detection](docs/idle-detection.md) — How to reliably detect when the agent is done responding

## Extensions

| Extension | Description |
|-----------|-------------|
| `isolation` | Restricts agent filesystem writes to project directory, LLM judge for ambiguous commands |
| `observability` | Shared event bus, lifecycle hooks, error tracking, `/observe` modal |
| `worktree` | Git worktree management + RPC agent orchestration |
| `messenger` | Inter-agent file-based messaging via `.pi/messages/` |
| `meta-skills` | Bridges skills from Claude, Cursor, Copilot ecosystems into pi |
| `context-viewer` | `/context` overlay showing token usage breakdown |
| `custom-pi` | `/custom-pi` overlay showing git branch, model, isolation config |
| `file-viewer` | Syntax-highlighted file overlay with scroll, search, mouse clicks |

## Quick start

```bash
npm install
npm run sync    # sync extensions to ~/.pi/agent/extensions/
pi              # extensions auto-load
```

## Adding a new extension

1. Create `extensions/<name>/index.ts`
2. Export a default function: `export default function(pi: ExtensionAPI) { ... }`
3. Run `npm run sync`
4. Restart pi or run `/reload`
```
