# Auto-Resolution Decision Framework

When critics raise questions during the planning phase, resolve them using this priority-ordered
decision tree. Apply rules from highest to lowest priority — stop at the first rule that clearly
applies. For each question, document: the question, the chosen option, the evidence, and the rule applied.

## Decision Tree (in priority order)

### Rule 1: Codebase Precedent (highest priority)

- Search the codebase for how similar decisions were made before
- If a clear pattern exists (3+ instances), follow it
- **Evidence required:** file paths and code snippets showing the pattern
- **Example:** "Should we use server actions or API routes?" → grep for both patterns, use whichever the codebase predominantly uses
- **When to skip:** If the existing pattern is clearly wrong or outdated (e.g., deprecated API)

### Rule 2: Existing Convention

- Check CLAUDE.md, project docs/, and reference files for documented conventions
- If a convention exists, follow it even if the critic suggests otherwise
- **Evidence required:** quote the relevant convention with file path
- **Example:** "Should we add a barrel file?" → CLAUDE.md says "Use direct imports, not barrel files" → follow convention

### Rule 3: Security-First

- For any question with security implications, choose the more secure option
- Never defer security fixes ("skip for now" is not acceptable for security)
- Access control questions default to most restrictive, then relax if needed
- Input validation defaults to strict validation at system boundaries
- **Evidence required:** explain the security risk of the alternative option
- **Example:** "Should we validate this input on client only or server too?" → always validate server-side

### Rule 4: KISS (Keep It Simple)

- Between options of similar value, choose the simpler one
- "Simple" = fewer files changed, fewer new abstractions, fewer dependencies, less indirection
- Prefer editing existing files over creating new ones
- Prefer flat structures over nested hierarchies
- **Evidence required:** compare complexity (LOC, file count, abstraction layers) for each option
- **Example:** "Custom hook or inline logic?" → if used once, inline it

### Rule 5: Mobile-First

- For UX/layout questions, prefer the mobile-optimized option
- Reference CLAUDE.md's "mobile-first responsive design" directive
- Touch targets must be at least 44x44px
- Critical actions must be reachable with one hand (bottom of screen)
- **Evidence required:** describe mobile behavior of each option
- **Example:** "Sidebar nav or bottom tabs on mobile?" → bottom tabs for mobile

### Rule 6: Performance > Features

- For performance vs. feature-richness trade-offs, prefer performance
- **Exception:** if the feature IS the core of what's being built, features win
- Prefer server components over client components
- Prefer pagination over loading all data
- Prefer lazy loading for non-critical UI
- **Evidence required:** describe the performance impact of each option
- **Example:** "Load all items or paginate?" → paginate unless the feature specifically requires showing all

### Rule 7: Defer Non-Essential Scope

- If a question is about adding scope beyond the original feature request, defer it
- Add deferred items to the backlog rather than expanding the PR
- The original feature description is the source of truth for scope
- "Nice to have" additions get deferred; "must have for correctness" stays
- **Evidence required:** compare the suggestion to the original feature description
- **Example:** "Should we also add bulk delete while building the list view?" → defer to backlog

### Rule 8: Less Code Change (tiebreaker)

- When no other rule applies and options are genuinely equivalent, choose the one requiring less code change
- Smaller diffs are easier to review, less likely to introduce bugs, and faster to implement
- **Evidence required:** estimate diff size for each option
- **Example:** "Use existing utility with small adaptation vs. write new utility?" → adapt existing

## Output Format

For each auto-resolved question, write this to `questions.md`:

```
### Q{N}: {title} [AUTO-RESOLVED]
**Source:** {which critic(s) raised this}
**Rule applied:** {rule number and name}
**Decision:** Option {letter} -- {description}
**Evidence:** {codebase search results, convention quotes, or reasoning}
**Confidence:** High/Medium/Low
```

### Confidence Levels

- **High** — Rule 1 or 2 applied with clear evidence (pattern found, convention documented)
- **Medium** — Rules 3-6 applied with reasonable justification
- **Low** — Rules 7-8 applied as tiebreaker, or evidence was ambiguous

Low-confidence decisions should be flagged in the final plan summary so the user can review them if desired.
