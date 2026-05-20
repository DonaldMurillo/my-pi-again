---
name: meta-skills
description: Discovers and bridges skills from Claude, Cursor, Copilot, and other ecosystems into pi. Use /meta-skills to list and scan external skills.
---

# Meta-Skills

This extension discovers skills from external AI coding tools and makes them available inside pi as first-class skills.

## Supported Ecosystems

| Source | Path | Type |
|--------|------|------|
| Claude | `~/.claude/skills/` | `claude` |
| Claude Plugins | `~/.claude/plugin-skills/` | `claude-plugin` |
| Cursor | `.cursor/skills/` | `cursor` |
| Copilot | `.github/copilot/skills/` | `copilot` |
| Any | configurable | `generic` |

## Configuration

Create `.pi/meta-skills.json` in your project root, or `~/.pi/agent/meta-skills.json` for global config:

```json
{
  "sources": [
    { "root": "~/.claude/skills", "type": "claude" },
    { "root": "~/.claude/plugin-skills", "type": "claude-plugin" },
    { "root": ".cursor/skills", "type": "cursor" },
    { "root": ".github/copilot/skills", "type": "copilot" }
  ]
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/meta-skills` | List discovered external skills |
| `/meta-skills scan` | Rescan all sources |
| `/meta-skills sources` | Show configured sources |

## Deduplication

- Pi built-in skills always take priority over external skills with the same name.
- When multiple external sources provide a skill with the same name, the first configured source wins.
