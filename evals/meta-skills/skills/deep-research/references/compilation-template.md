# Research Compilation Template

Single-document compilation of all research angles + synthesis for easy navigation and analysis. This is the "one file to read" deliverable — everything important from the research in one place, organized for quick scanning.

## Required Structure

```markdown
# Research Compilation: {feature title}

> **Generated:** {ISO timestamp}
> **Feature:** {description}
> **Angles completed:** {N}/4
> **Sources cited:** {total unique source count}

---

## TL;DR

{5-7 bullet points. The absolute essentials a decision-maker needs. Pull from synthesis executive summary but make it even more scannable.}

- **Market:** {1-line market state}
- **Users want:** {top 2-3 user needs}
- **Users hate:** {top 2-3 pain points}
- **UX best practice:** {1-line dominant pattern}
- **Trend to watch:** {1-line biggest trend}
- **Our edge:** {1-line primary opportunity}
- **Biggest risk:** {1-line top risk}

---

## 1. Competitor Landscape

### Quick Comparison

{Consolidated matrix from market research. Keep only the dimensions that differentiate.}

| App    | Platform          | Free Tier | Key Strength | Key Weakness | Pricing |
| ------ | ----------------- | --------- | ------------ | ------------ | ------- |
| {name} | {iOS/Android/Web} | {Y/N}     | {strength}   | {weakness}   | {price} |

### Market Gaps

{Numbered list of opportunities no competitor addresses well. Each with source.}

1. **{Gap}** — {why it matters} ([source]({url}))

---

## 2. User Pain Points (Ranked)

{Ranked by severity and frequency. Each entry is a mini-brief.}

### Critical (Blocks adoption)

| #   | Pain Point | Who Suffers    | Evidence            | Quote               |
| --- | ---------- | -------------- | ------------------- | ------------------- |
| 1   | {pain}     | {user segment} | {source + platform} | "{real user quote}" |

### High (Causes churn)

| #   | Pain Point | Who Suffers    | Evidence            | Quote               |
| --- | ---------- | -------------- | ------------------- | ------------------- |
| 2   | {pain}     | {user segment} | {source + platform} | "{real user quote}" |

### Medium (Frustrating but tolerated)

| #   | Pain Point | Who Suffers    | Evidence            | Quote               |
| --- | ---------- | -------------- | ------------------- | ------------------- |
| 3   | {pain}     | {user segment} | {source + platform} | "{real user quote}" |

---

## 3. UX Patterns That Work

{Proven patterns from authoritative sources. Organized by interaction type.}

### Navigation & Information Architecture

| Pattern   | Source                 | Why It Works | Example App        |
| --------- | ---------------------- | ------------ | ------------------ |
| {pattern} | {NNGroup/Baymard/etc.} | {evidence}   | {who does it well} |

### Data Entry & Forms

| Pattern   | Source   | Why It Works | Example App |
| --------- | -------- | ------------ | ----------- |
| {pattern} | {source} | {evidence}   | {example}   |

### Search & Filtering

| Pattern   | Source   | Why It Works | Example App |
| --------- | -------- | ------------ | ----------- |
| {pattern} | {source} | {evidence}   | {example}   |

### Visual Design & Media

| Pattern   | Source   | Why It Works | Example App |
| --------- | -------- | ------------ | ----------- |
| {pattern} | {source} | {evidence}   | {example}   |

### DO / DON'T Quick Reference

| DO              | DON'T          | Why                     |
| --------------- | -------------- | ----------------------- |
| {good practice} | {anti-pattern} | {evidence-based reason} |

---

## 4. Technology & Trends

### Trend Radar
```

NOW (adopt) NEXT (evaluate) LATER (watch)

---

{trend 1} {trend 4} {trend 7}
{trend 2} {trend 5} {trend 8}
{trend 3} {trend 6} {trend 9}

```

### Technology Options

| Approach | Pros | Cons | Best For | Notable Users |
| -------- | ---- | ---- | -------- | ------------- |
| {approach} | {pros} | {cons} | {use case} | {who uses it} |

---

## 5. Cross-Reference Matrix

{The highest-value section. Maps pain points to solutions to trends.}

| Pain Point | UX Solution | Trend Enabler | Competitor Gap | Priority |
| ---------- | ----------- | ------------- | -------------- | -------- |
| {pain} | {pattern from UX} | {tech trend} | {who fails here} | Must/Should/Nice |

---

## 6. Prioritized Recommendations

### Must Have

{Each backed by 2+ angles. Format: recommendation + evidence bullets.}

1. **{Recommendation}**
   - Market: {evidence}
   - Users: {evidence}
   - UX: {evidence}
   - Trend: {evidence, if applicable}

### Should Have

1. **{Recommendation}**
   - Evidence: {sources}

### Nice to Have

1. **{Recommendation}**
   - Evidence: {sources}
   - Risk: {why this might not pan out}

---

## 7. Risk Register

| Risk | Likelihood | Impact | Source | Mitigation |
| ---- | ---------- | ------ | ------ | ---------- |
| {risk} | H/M/L | H/M/L | {which angle} | {strategy} |

---

## 8. Research Gaps & Confidence

{Honest assessment of what we don't know.}

| Area | Confidence | Gap | Impact on Decisions |
| ---- | ---------- | --- | ------------------- |
| {area} | High/Med/Low | {what's missing} | {how it affects recs} |

---

## Appendix: Source Index

{All unique sources cited, grouped by type. Makes it easy to verify claims.}

### Research & Studies
- [{title}]({url}) — {what it contributed}

### Competitor Pages
- [{title}]({url}) — {what it contributed}

### User Discussions (Reddit, HN, Forums)
- [{title}]({url}) — {what it contributed}

### Documentation & Standards
- [{title}]({url}) — {what it contributed}
```

## Compilation Rules

1. **No new research** — The compilation only reorganizes and cross-references data already in the angle reports and synthesis. It does NOT perform additional web searches.
2. **Preserve source URLs** — Every claim must retain its source URL from the original angle report.
3. **Deduplicate** — If the same finding appears in multiple angles, consolidate into one entry and cite all angles.
4. **Rank everything** — Pain points by severity, recommendations by priority, risks by impact. No flat unranked lists.
5. **Keep it scannable** — Tables over paragraphs. Bullets over prose. Bold key terms.
6. **Flag thin areas** — If an angle had limited findings, note reduced confidence in the Research Gaps section.
