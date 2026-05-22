# Research Angle Template

This template defines the consistent structure that all 4 research angle agents follow. Each agent customizes the middle "Findings" sections based on their specific angle, but the outer structure remains the same.

## Required Sections

Every research angle output MUST include these sections in this order:

```markdown
# {Angle} Research: {feature title}

## Search Queries Executed

Document every search performed, including those that returned no useful results.

- `{query 1}` — {N useful results}
- `{query 2}` — {N useful results}
- `{query 3}` — no useful results

## [Angle-Specific Findings]

{Each agent defines their own sections here — see individual agent definitions.}
{Market: Competitor Landscape, Feature Comparison Matrix, Market Gaps}
{UX: Established Design Patterns, DO/DON'T lists, Mobile/A11y}
{Pain Points: Pain Point Catalog, Anti-Pattern Catalog, Users Wish For}
{Trends: Trend Radar (Now/Next/Later), Standards, AI/ML, Web Platform}

## Key Takeaways

Numbered list of the most actionable insights. Each MUST include a source URL.

1. {Insight} — {source URL}
2. {Insight} — {source URL}
```

## Quality Rules

1. **Every claim needs a source URL** — no unsourced assertions
2. **Prefer 2024-2026 sources** — flag older ones with "dated"
3. **Document failed searches** — knowing what ISN'T available is valuable
4. **Be specific** — "users complain about slow loading" is weak; "Reddit user reported 8-second load times on inventory pages (source: URL)" is strong
5. **Distinguish evidence from opinion** — usability study results > individual blog posts > your inference
6. **Note contradictions** — if two sources disagree, present both with URLs and let the synthesizer resolve
