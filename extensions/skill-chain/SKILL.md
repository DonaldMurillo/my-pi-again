---
name: skill-chain
description: >
   Skill chain resolver extension. Resolves `imports:` and `Read skill:` references
   in SKILL.md files recursively, making chained skills available to pi as first-class
   skills. Use /skill-chain to inspect and manage skill chains.
---

# Skill Chain Extension

Resolves skill import chains so pi can load deeply nested skill graphs as composed context.

## How It Works

1. Scans configured skill directories for SKILL.md files
2. Resolves `imports:` (frontmatter) and `Read skill: <name>` (body) references
3. Follows chains recursively with cycle detection
4. Loads `references/` directory files as extra context
5. Returns all resolved skill paths to pi via `resources_discover`

## Skill Reference Mechanisms

### `imports:` (YAML frontmatter)
```yaml
---
name: my-skill
imports:
   - compaction-resilience
   - product-vision
---
```

### `Read skill: <name>` (body text)
```markdown
# My Skill

Follow the rules below.
Read skill: other-skill
```

### `references/` directory
```
my-skill/
├── SKILL.md
└── references/
    ├── template.md
    └── checklist.md
```

All three mechanisms are resolved recursively. Cycle detection prevents infinite loops.

## Configuration

Create `.pi/skill-chain.json` in your project:

```json
{
  "skillDirs": [
    "path/to/skills",
    "~/shared-skills"
  ],
  "autoResolve": ["deep-auto"]
}
```

- `skillDirs`: Directories containing skill subdirectories with SKILL.md files
- `autoResolve`: Entry points to resolve on session start (resolves the full chain)

Without `autoResolve`, all discovered skills are available but not pre-chained.

## Commands

| Command | Description |
|---------|-------------|
| `/skill-chain` | Show discovered skills and resolution status |
| `/skill-chain scan` | Rescan all directories |
| `/skill-chain resolve <name>` | Show the chain for a specific skill |
