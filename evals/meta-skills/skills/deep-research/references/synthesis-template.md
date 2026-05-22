# Synthesis Report Template

The synthesizer agent produces the final deliverable that users and deep-plan actually read. The key value is **cross-referencing** — connecting findings across angles, not just summarizing them.

## Required Structure

```markdown
# Research Synthesis: {feature title}

## Executive Summary

{3-5 sentences. Readable by someone who won't read the individual research files. Cover: what the market looks like, what users struggle with, what works well in UX, and what's coming next. End with a clear recommendation.}

## Competitor Matrix (Consolidated)

{Pull from market research. Organize by dimensions that matter for our feature.}

| Dimension   | Leader | Average | Laggard | Our Opportunity              |
| ----------- | ------ | ------- | ------- | ---------------------------- |
| {dimension} | {who}  | {who}   | {who}   | {what we can do differently} |

## Top Pain Points x Our Solutions

{This is the cross-reference table — the most valuable part. Map each pain point to a UX solution and a trend that could help.}

| Pain Point | Severity | Competitors Affected | UX Pattern to Solve        | Trend to Leverage |
| ---------- | -------- | -------------------- | -------------------------- | ----------------- |
| {pain}     | {sev}    | {which competitors}  | {pattern from UX research} | {trend, if any}   |

## Recommendations (Prioritized)

### Must Have — Validated by multiple angles

{Each recommendation MUST cite evidence from at least 2 research angles.}

1. **{Recommendation}**
   - Market evidence: {what competitors get wrong — from research-market.md}
   - UX evidence: {what research says works — from research-ux.md}
   - User evidence: {what users complain about — from research-pain-points.md}
   - How: {brief implementation direction for our stack}

### Should Have — Strong evidence from 1-2 angles

1. **{Recommendation}**
   - Evidence: {sources and reasoning}
   - How: {brief direction}

### Nice to Have — Emerging or speculative

1. **{Recommendation}**
   - Evidence: {source}
   - Risk: {what could go wrong or why this might not pan out}

## Risk Register

{Risks identified across all angles that could affect our implementation.}

| Risk   | Source Angle           | Likelihood | Impact | Mitigation            |
| ------ | ---------------------- | ---------- | ------ | --------------------- |
| {risk} | {market/UX/pain/trend} | H/M/L      | H/M/L  | {what to do about it} |

## Gaps in Research

{Honesty section — what we don't know.}

- {What we couldn't find or verify}
- {Angles that had thin results}
- {Contradictions between sources that remain unresolved}
- {Areas that would benefit from deeper investigation}
```

## Cross-Referencing Rules

The synthesis must demonstrate these connections (where they exist):

1. **Market gap -> Pain point**: "Competitor X lacks feature Y" + "Users complain about missing Y" = strong signal
2. **Pain point -> UX pattern**: "Users struggle with Z" + "NNGroup recommends pattern W for Z" = actionable solution
3. **Trend -> Market gap**: "New API enables X" + "No competitor does X yet" = opportunity
4. **UX pattern -> Trend**: "Pattern P works well" + "Trend T makes P easier/better" = future-proof choice

If an angle file is missing (partial run), note it explicitly and lower confidence levels for recommendations that would have relied on that angle.
