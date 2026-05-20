# Pi Agent Lifecycle: Idle Detection Guide

> Empirical findings from live testing with the idle-test extension battery.
> Based on pi-coding-agent event lifecycle, tested across multi-turn conversations with tool calls.

## The Event Tree

```
user sends prompt
  ├─► before_agent_start    ← isIdle=TRUE (last idle moment)
  ├─► agent_start
  │
  │   ┌─── turn (repeats while LLM calls tools) ───┐
  │   │                                              │
  │   ├─► turn_start                                 │
  │   ├─► message_start (user)                       │
  │   ├─► message_end (user)                         │
  │   ├─► message_start (assistant)                  │
  │   ├─► message_update (streaming tokens)          │
  │   ├─► message_end (assistant)                    │
  │   │                                              │
  │   │   If agent calls tools:                      │
  │   │     ├─► tool_call (can block)                │
  │   │     ├─► tool_result                          │
  │   │     ├─► message_start (toolResult)           │
  │   │     └─► message_end (toolResult)             │
  │   │                                              │
  │   └─► turn_end                                   │
  │                                                  │
  │   If turn_end had tool calls → another turn      │
  │   If turn_end had no tools → agent is done       │
  │                                                  │
  └─► agent_end              ← THE reliable "done" signal
```

## Empirical Data

Tested across 2 agent prompts:
- **Prompt 1**: Simple answer, 1 turn, 0 tool calls
- **Prompt 2**: Complex task, 12 turns, 11 tool calls

### What each signal reports

| Event | isIdle() | ctx.signal | hasPendingMessages() |
|---|---|---|---|
| `session_start` | ✅ true | ❌ undefined | false |
| `before_agent_start` | ✅ true | ❌ undefined | false |
| `agent_start` | ❌ false | ✅ defined | false |
| `turn_start` | ❌ false | ✅ defined | false |
| `turn_end` | ❌ false | ✅ defined | false |
| `agent_end` | ❌ false | ✅ defined | false |

### Key findings

1. **`isIdle()` is useless during agent processing.** It returns `true` only at `session_start` and `before_agent_start`. During all turn/message/tool events (including `agent_end`), it's `false`. Do NOT use this to detect "done".

2. **`ctx.signal` is always defined during agent processing.** It's `undefined` only before the first agent turn and between prompts. Do NOT use `!ctx.signal` as a "done" check.

3. **`hasPendingMessages()` was always `false` in testing.** May only be `true` when extensions use `pi.sendUserMessage()`.

4. **`agent_end` fires at the same millisecond as the last `turn_end`.** They are synchronous. You can use either, but `agent_end` is semantically clearer.

5. **`turn_end` with `tools=0` indicates a "final" turn**, but you can't know in real-time that no more turns follow. Only `agent_end` guarantees finality.

6. **`before_agent_start` is the last moment `isIdle=true`.** Good for pre-agent setup/reset actions.

## How to detect "agent is done responding"

### ✅ Recommended: `agent_end`

```typescript
pi.on("agent_end", async (event, ctx) => {
    // Agent has completed ALL turns for this user prompt.
    // This is the ONLY reliable signal that the agent is truly done.
    //
    // Use for:
    //   - Desktop notifications
    //   - Auto-committing file changes
    //   - Updating terminal tab title
    //   - Triggering post-agent actions (review loops, context pruning)
    //
    // event.messages — all messages from this prompt
});
```

### ❌ Unreliable approaches

```typescript
// ❌ isIdle() is false even at agent_end
pi.on("turn_end", async (event, ctx) => {
    if (ctx.isIdle()) { /* NEVER fires during agent processing */ }
});

// ❌ signal is defined even at agent_end
pi.on("turn_end", async (event, ctx) => {
    if (!ctx.signal) { /* NEVER true during agent processing */ }
});

// ❌ Can't know in real-time that this is the LAST turn_end
pi.on("turn_end", async (event, ctx) => {
    // turn_end fires after EVERY turn, including intermediate ones
    // tools=0 doesn't mean the agent won't start another turn
});
```

## Common patterns

### Desktop notification when agent finishes

```typescript
pi.on("agent_end", async () => {
    process.stdout.write("\x1b]777;notify;Pi;Ready for input\x07");
});
```

### Auto-commit changes after agent completes

```typescript
import { execSync } from "node:child_process";

pi.on("agent_end", async (event, ctx) => {
    try {
        const status = execSync("git status --porcelain", {
            cwd: ctx.cwd, encoding: "utf8", timeout: 3000,
        }).trim();

        if (!status) return; // nothing to commit

        execSync("git add -A", { cwd: ctx.cwd, timeout: 5000 });

        // Use last assistant message as commit message
        const lastMsg = event.messages
            ?.filter((m: any) => m.role === "assistant")
            .pop();
        const text = lastMsg?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")
            .slice(0, 72) || "agent changes";

        execSync(`git commit -m ${JSON.stringify(text)}`, {
            cwd: ctx.cwd, timeout: 5000,
        });
    } catch { /* ignore git errors */ }
});
```

### Terminal tab title: working vs done

```typescript
pi.on("agent_start", async () => {
    process.stdout.write("\x1b]1;⏳ pi working\x07");
});

pi.on("agent_end", async () => {
    process.stdout.write("\x1b]1;✅ pi done\x07");
});
```

### Pre-agent cleanup with isIdle

```typescript
// isIdle is TRUE here — good for pre-flight checks
pi.on("before_agent_start", async (event, ctx) => {
    // Reset per-prompt state
    // Validate preconditions
    // Modify system prompt via event.systemPrompt
});
```

## Timing reference

From live testing (12-turn conversation):

| Metric | Value |
|---|---|
| First turn (answer only) | ~27s |
| Turn with tool call | ~1-4s (varies by tool) |
| tool_result → next turn_start | ~2ms |
| Last turn_end → agent_end | ~0ms (same ms) |
| Last tool_result → last turn_end | ~22s (final answer generation) |

## Related extensions

- [notify.ts](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/notify.ts) — Desktop notifications on `agent_end`
- [tab-status](https://github.com/tmustier/pi-extensions/tree/main/tab-status) — Terminal tab indicators
- [session-recap](https://github.com/tmustier/pi-extensions/tree/main/session-recap) — One-line recap on idle
- [auto-commit-on-exit.ts](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/auto-commit-on-exit.ts) — Commits on session end
- [pi-review-loop](https://github.com/nicobailon/pi-review-loop) — Uses `agent_end` to trigger review loops
