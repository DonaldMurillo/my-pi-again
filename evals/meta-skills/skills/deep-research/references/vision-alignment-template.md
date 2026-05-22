# Vision Alignment Template

After compilation, filter all research recommendations through the product vision to prevent scope creep and ensure research serves the actual product direction.

## Required Structure

```markdown
# Vision Alignment: {feature title}

> **Product Vision:** docs/product-vision.md
> **Research:** {path to research-compilation.md}

## Vision Check

{Restate the 2-3 most relevant vision principles for this feature.}

## Aligned Recommendations

{Recommendations from research that directly serve the product vision. Keep the full evidence from the compilation.}

### Must Have (vision-aligned)

| #   | Recommendation | Vision Principle            | Evidence Summary |
| --- | -------------- | --------------------------- | ---------------- |
| 1   | {rec}          | {which principle it serves} | {brief evidence} |

### Should Have (vision-aligned)

| #   | Recommendation | Vision Principle  | Evidence Summary |
| --- | -------------- | ----------------- | ---------------- |
| 1   | {rec}          | {which principle} | {brief evidence} |

## Deferred — Out of Current Vision

{Recommendations from research that are valid findings but don't align with current product vision. These are NOT deleted — they're preserved for future vision updates.}

| #   | Recommendation | Why Deferred                                                   | Revisit When                            |
| --- | -------------- | -------------------------------------------------------------- | --------------------------------------- |
| 1   | {rec}          | {which "What We're NOT Building" item or scope filter it hits} | {condition that would make it relevant} |

## Scope Creep Warnings

{Specific areas where the research might pull the team in a direction that contradicts the vision. Be explicit about the temptation and why to resist it.}

1. **{Temptation}** — {why the research makes it look attractive} -> **Resist because:** {vision principle}

## Vision Gaps Identified

{Areas where the research reveals something the vision doesn't address. These should trigger a discussion about updating the vision, not about ignoring the vision.}

1. **{Gap}** — {what the research found that the vision doesn't cover} -> **Suggested vision update:** {proposed addition/change}
```

## Alignment Rules

1. **Vision wins over research** — if research says "build a marketplace" but vision says "NOT a marketplace", the recommendation gets deferred, not prioritized.
2. **Preserve deferred items** — don't delete recommendations that don't fit. Move them to "Deferred" with a clear "revisit when" condition. Visions evolve.
3. **Flag scope creep explicitly** — name the temptation. "AI-powered valuation" sounds great in research but if vision says "NOT a valuation service", call it out.
4. **Identify vision gaps honestly** — if research reveals something genuinely important that the vision doesn't cover, flag it for discussion. Don't silently ignore it or silently expand scope.
5. **Reference specific vision sections** — every alignment/deferral must cite which part of `docs/product-vision.md` it relates to.

## Auto Mode (deep-auto) Behavior

When running in `/deep-auto` context (no human present):

1. All non-aligned recommendations are auto-deferred to `docs/backlog/out-of-vision-scope.md`
2. Vision gaps are logged under a "Vision Gaps" section in the same file
3. No prompts, no blocking, no scope expansion
4. The alignment file is still generated for audit trail, but decisions are automatic
