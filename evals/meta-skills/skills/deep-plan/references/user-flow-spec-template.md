# User Flow Spec Template

Use this template when generating `user-flow-spec.md` for a feature plan.

## Structure

```markdown
# User Flow Spec: {feature title}

## Actors

- {role}: {description and permissions}

## Happy Path Flows

### Flow 1: {Primary action}

1. User navigates to {URL}
2. User sees {expected UI state}
3. User clicks {element}
4. System responds with {expected behavior}
5. User is redirected to {URL}
6. User sees {confirmation}

**Preconditions:** {what must be true before this flow}
**Postconditions:** {what must be true after this flow}

## Error Flows

### Error 1: {error scenario}

1. User does {action}
2. System shows {error message}
3. User can recover by {recovery action}

## Edge Cases

- Empty state: {what happens with no data}
- Max items: {what happens at limits}
- Concurrent access: {what happens with multiple users}
- Mobile: {any mobile-specific flows}

## State Transitions

[ASCII state machine diagram]

## Accessibility Requirements

- Keyboard: {keyboard navigation expectations}
- Screen reader: {announcement expectations}
- Touch: {touch target requirements, minimum 44x44px}

## Test Matrix

| Flow   | Happy Path | Error Case | Mobile    | A11y      |
| ------ | ---------- | ---------- | --------- | --------- |
| Flow 1 | Must test  | Must test  | Must test | Must test |

## Pure Functions Created

| Function         | File          | Purity                  | Coverage Target |
| ---------------- | ------------- | ----------------------- | --------------- |
| `functionName()` | `src/lib/...` | 100% pure / mostly-pure | 100% / 80%+     |
```

## Guidelines

- Every flow must have preconditions and postconditions
- Error flows must include recovery steps
- State transitions should be drawn as ASCII diagrams
- Test matrix drives what the test writer and chaos monkey cover
- Mobile flows are mandatory — this is a mobile-first app
- Accessibility requirements are mandatory — WCAG 2.1 AA target
