# my-pi-extensions

Pi extensions framework. Source of truth — sync to `~/.pi/agent/extensions/` for deployment.

## Documentation

- [Agent Idle Detection](docs/idle-detection.md) — How to reliably detect when the agent is done responding

## Extensions

| Extension | Description |
|-----------|-------------|
| `meta-skills` | Bridges skills from Claude, Cursor, Copilot, and other ecosystems into pi |
| `isolation` | Restricts agent filesystem writes to project directory |

## Quick start

```bash
# Install deps
npm install

# Sync all extensions to ~/.pi/agent/extensions/
npm run sync

# Preview without writing
npm run sync:dry

# Then start pi (extensions auto-load from ~/.pi/agent/extensions/)
pi
```

## Adding a new extension

1. Create `extensions/<name>/index.ts`
2. Export a default function: `export default function(pi: ExtensionAPI) { ... }`
3. Run `npm run sync`
4. Restart pi or run `/reload`

## Extension details

### meta-skills

Discovers external skills and returns them via `resources_discover` so pi loads them as first-class skills.

**Config:** `.pi/meta-skills.json` or `~/.pi/agent/meta-skills.json`
```json
{
  "sources": [
    { "root": "~/.claude/skills", "type": "claude" },
    { "root": "~/.claude/plugin-skills", "type": "claude-plugin" },
    { "root": ".cursor/skills", "type": "cursor" }
  ]
}
```

**Commands:** `/meta-skills <list|scan|sources>`

### isolation

Restricts agent to only write/edit/delete within project cwd.

**Config:** `.pi/isolation.json`
```json
{ "enabled": true, "allowPaths": [], "blockHomeDirectory": true }
```

**Commands:** `/isolation <status|on|off|allow|reset>`
