# Bug Report Template

This template defines the required fields for a structured bug report used by the `/deep-bug` pipeline.

## Required Fields

| Field            | Type                              | Required             | Description                                                           |
| ---------------- | --------------------------------- | -------------------- | --------------------------------------------------------------------- |
| slug             | string (kebab-case)               | Always               | Unique identifier derived from title                                  |
| title            | string                            | Always               | Short description of the bug                                          |
| bugClass         | enum: UI, API, Logic              | Always               | Classification determining validation and test approach               |
| severity         | enum: critical, high, medium, low | Always               | Impact severity                                                       |
| affectedUrl      | string                            | UI and API bugs only | URL where bug occurs (page or API endpoint). Optional for Logic bugs. |
| stepsToReproduce | ordered list                      | Always               | Numbered steps to reproduce the bug                                   |
| expected         | string                            | Always               | What should happen                                                    |
| actual           | string                            | Always               | What actually happens                                                 |

## Optional Fields

| Field          | Type          | Description                       |
| -------------- | ------------- | --------------------------------- |
| environment    | string        | Browser, OS, viewport if relevant |
| errorLogs      | string        | Console errors, server errors     |
| visualEvidence | string        | Screenshot paths or descriptions  |
| reportedBy     | string        | Who reported the bug              |
| reportedAt     | ISO timestamp | When the bug was reported         |

## Bug Class Guide

| Indicator                                         | Bug Class | Validation Method         | Test Type            |
| ------------------------------------------------- | --------- | ------------------------- | -------------------- |
| URL is a page (`/dashboard/...`, `/settings/...`) | UI        | Browser via agent-browser | E2E Playwright       |
| URL is API endpoint (`/api/...`)                  | API       | curl / HTTP requests      | E2E Playwright (API) |
| No URL, logic/data description                    | Logic     | Source code review        | Vitest unit test     |

## Template

```markdown
---
slug: { kebab-case-slug }
title: { short description }
bugClass: UI | API | Logic
severity: critical | high | medium | low
affectedUrl: { URL where bug occurs, or N/A for Logic bugs }
environment: { browser, OS, viewport if relevant }
reportedBy: { who reported }
reportedAt: { ISO timestamp }
---

## Steps to Reproduce

1. Navigate to {URL}
2. {action}
3. {action}
   ...

## Expected Behavior

{What should happen}

## Actual Behavior

{What actually happens}

## Error Logs (optional)

{Console errors, server errors, stack traces}

## Visual Evidence (optional)

{Screenshot paths or descriptions}
```

## Parsing Rules

When the `/deep-bug` skill receives free-text input, it should:

1. Extract a title from the first sentence
2. Generate slug from title (kebab-case, max 50 chars)
3. Determine `bugClass`:
   - If description mentions a page URL (`/dashboard/...`): UI
   - If description mentions API endpoint (`/api/...`): API
   - If description mentions logic, data, calculation, or no URL: Logic
4. Look for URL patterns (starting with `/` or `http`) to populate `affectedUrl`
5. Look for numbered steps or temporal ordering words ("then", "after", "next") to populate `stepsToReproduce`
6. Look for "should" or "expected" language to populate `expected`
7. Look for "but", "instead", "actually" language to populate `actual`
8. Default severity to `medium` if not specified
9. Default `reportedAt` to current timestamp
10.   If `bugClass` is UI or API and `affectedUrl` cannot be derived, ask clarifying questions
11.   If `bugClass` is Logic, `affectedUrl` defaults to `N/A`
12.   If `stepsToReproduce` cannot be derived, ask clarifying questions
