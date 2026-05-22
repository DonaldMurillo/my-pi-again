---
name: deep-research
description: >
   Deep internet research pipeline. Spawns parallel research agents across multiple angles
   (market, UX, pain points, trends), synthesizes findings, and produces actionable insights.
   Can run standalone or integrated into deep-plan. Use when the user says "deep research"
   or `/deep-research`.
imports:
   - compaction-resilience
   - product-vision
invariants:
   - 'All research agents MUST run concurrently in a SINGLE message — never one at a time.'
   - 'Synthesis must cross-reference across angles — not concatenate.'
   - 'Every claim must cite a source URL — no unsourced assertions.'
---

# Deep Research Skill

Deep internet research across multiple angles with synthesis and actionable output.

## Invocation

```
/deep-research "topic"                           # Standalone: research to docs/research/{slug}/
/deep-research --output {dir} "topic"            # Integrated: write to specified directory
/deep-research --resume {slug}                   # Resume interrupted research
```

## References

- `references/research-angle-template.md` — Template for individual research angles
- `references/synthesis-template.md` — Template for cross-angle synthesis
- `references/vision-alignment-template.md` — Template for vision-aligned recommendations
- `references/compilation-template.md` — Template for final compilation

## Phase 1: Research Angles

Spawn 4 research agents **in parallel**:

```
Agent 1 (deep-research-market): Market analysis, competitor landscape
Agent 2 (deep-research-ux): UX theory, user behavior, interaction patterns
Agent 3 (deep-research-pain-points): User pain points, common frustrations
Agent 4 (deep-research-trends): Industry trends, emerging practices
```

Each uses `references/research-angle-template.md` for output format.

## Phase 2: Synthesis

Spawn 1 `deep-research-synthesizer` agent:

- Reads all 4 angle reports
- Cross-references findings across angles
- Identifies themes and contradictions
- Produces synthesis using `references/synthesis-template.md`

## Phase 2.5: Compilation

Compile all research into a single actionable document using `references/compilation-template.md`.

## Phase 2.75: Vision Alignment (Optional)

If `docs/product-vision.md` exists:

- Classify findings: **Aligned** (maps to vision), **Deferred** (valid but out of scope), **Scope creep warning**
- Produce `research-vision-alignment.md`

## Resume Logic

Check which output files exist and skip completed phases.
