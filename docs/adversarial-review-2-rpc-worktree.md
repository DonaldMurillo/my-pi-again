# Adversarial Review #2: RPC Client + Worktree — Agent Takeover

## Reviewer: Red Team — "How do I hijack the agents?"

### CRITICAL — RPC client spawns `pi` with no environment isolation
**Severity: P0**
```ts
const proc = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir], {
    cwd: this.worktreePath,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },  // <-- inherits ALL env vars
});
```
The spawned agent inherits the full parent environment including:
- `HOME`, `USER`, `PATH` — fine
- Any `API_KEY`, `TOKEN`, `SECRET` env vars — the spawned agent can read these
- `SSH_AUTH_SOCK` — the agent could use SSH keys
- `AWS_*`, `GCP_*`, `AZURE_*` — cloud credentials exposed to agent
**Fix:** Whitelist specific env vars (`PATH`, `HOME`, `LANG`, `TERM`) instead of copying everything.

### CRITICAL — No stdin validation on RPC commands
**Severity: P0**
```ts
private send(obj: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
}
```
`sendCommand` constructs objects from arbitrary strings. The `prompt` method passes user input directly:
```ts
const resp = await this.sendCommand("prompt", { message });
```
If `message` contains newlines or crafted JSON, it could inject RPC commands. The RPC protocol is newline-delimited JSON — a message containing `\n{"type":"prompt","message":"evil"}` would be parsed as two separate commands.
**Fix:** Sanitize message content — strip newlines or use a length-prefixed protocol instead of newline-delimited.

### HIGH — Worktree agents share the same extensions as the main session
**Severity: P1**
Worktree agents load extensions from `~/.pi/agent/extensions/` — same as main session. A malicious worktree agent could:
1. Use the `worktree` tool to spawn MORE agents
2. Use the `messenger` tool to send messages as the hub
3. Use `/isolation off` to disable its own sandbox
4. Write to `~/.pi/agent/extensions/` to inject code into the main session
**Fix:** Worktree agents should load a restricted extension set. Disable `/isolation off` for worktree agents, or require confirmation via the RPC UI request channel.

### HIGH — Extension UI requests auto-denied without user confirmation
**Severity: P1**
```ts
private async handleUIRequest(request): Promise<void> {
    if (!this.uiRequestHandler) {
        const defaults = { confirm: { confirmed: false }, ... };
        this.send({ type: "extension_ui_response", id: request.id, ...defaults[request.method] });
    }
}
```
When no UI handler is set, all confirmation dialogs auto-deny. But if the worktree extension sets a handler, confirmations are auto-approved by the test harness. In production, the handler is set by `spawnAgent` in `worktree-manager.ts`:
```ts
// from worktree-manager.ts spawnAgent:
client.setUIRequestHandler(async (req) => {
    // Auto-approve? Or relay to main session for user confirmation?
});
```
If auto-approve is the default, the worktree agent can do anything the main session can.
**Fix:** UI requests MUST be relayed to the main session for user confirmation. Never auto-approve writes or dangerous operations.

### HIGH — Worktree metadata is stored in the project's `.pi/` directory
**Severity: P1**
```ts
// worktree-manager.ts
const metaPath = join(repoRoot, ".pi", "worktrees.json");
```
A worktree agent can read AND write this file (it's within cwd). It could:
1. Modify `worktrees.json` to add fake worktrees
2. Change paths to point outside the project
3. Remove other worktrees from the metadata
**Fix:** Store metadata in `~/.pi/agent/worktrees/` instead of inside the project. Or make it read-only for worktree agents.

### MEDIUM — No timeout on `prompt()` wait for agent_end
**Severity: P2**
```ts
async prompt(message: string): Promise<RpcResponse> {
    const resp = await this.sendCommand("prompt", { message });
    // Wait for agent_end before resolving
    await new Promise<void>((resolve) => {
        const unsub = this.onEvent((event) => {
            if (event.type === "agent_end") { unsub(); resolve(); }
        });
    });
    return resp;
}
```
If the agent never sends `agent_end` (crashes, infinite loop), `prompt()` hangs forever. The `sendCommand` has a 5-minute timeout, but the `agent_end` wait has no timeout.
**Fix:** Add a timeout (e.g., 5 minutes) to the agent_end wait.

### MEDIUM — Agent process can outlive parent
**Severity: P2**
If the main pi process crashes without calling `kill()`, the RPC subprocess keeps running indefinitely. There's no heartbeat or parent-death detection.
**Fix:** Add a periodic heartbeat check. If parent dies (ppid changes to 1), the RPC agent should exit.

### MEDIUM — Session directory collision
**Severity: P2**
```ts
const sessionDir = join(homedir(), ".pi", "worktree-sessions");
```
All worktree agents share the same session directory. If two agents use the same branch name in different repos, they'll share session state.
**Fix:** Include repo hash in session name: `wt:<repo-hash>:<branch>`.

### LOW — Error swallowed in stderr
**Severity: P3**
```ts
proc.stderr!.on("data", (chunk) => { /* Ignore stderr noise */ });
```
Stderr is completely discarded. If the agent crashes with a useful error message, it's lost.
**Fix:** At minimum, log stderr to a file or emit as an event.

---

## Summary
| Severity | Count | Key Issues |
|----------|-------|------------|
| P0 | 2 | Env var leak to agents, RPC injection via newlines |
| P1 | 3 | Agent can escalate privileges, UI auto-approve, metadata tampering |
| P2 | 3 | No timeout on agent_end, orphan processes, session collision |
| P3 | 1 | Stderr discarded |

**Verdict: Worktree agents have too much power. They need restricted extensions, isolated env vars, and user-gated confirmations.**
