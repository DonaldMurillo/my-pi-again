# Infrastructure Preflight Checks

Stack-specific infrastructure checks to run before the pipeline begins.
Adapt these to the project's actual technology stack.

## How to Use

1. Read the project's `package.json`, config files, and `README.md` to identify the stack
2. Run the relevant checks below
3. Follow the detect → auto-fix → verify pattern for each

## Common Checks

### Check: Dependency Installation

```bash
# Detect package manager
[ -f "pnpm-lock.yaml" ] && echo "pnpm" && exit 0
[ -f "yarn.lock" ] && echo "yarn" && exit 0
[ -f "package-lock.json" ] && echo "npm" && exit 0
[ -f "bun.lockb" ] && echo "bun" && exit 0

# Install if node_modules missing
[ ! -d "node_modules" ] && <package-manager> install
```

### Check: Build Tools

```bash
# Verify build works
<package-manager> run build
# Or language-specific:
# go build ./...
# cargo build
# dotnet build
```

### Check: Test Runner

```bash
# Verify test runner works
<package-manager> run test -- --dry-run
# Or framework-specific:
# go test ./... -count=0
# cargo test --no-run
```

### Check: Lint/Format

```bash
# Verify linter works
<package-manager> run lint
# Or:
# golangci-lint run
# cargo clippy
```

### Check: Database (if applicable)

```bash
# Check if database is reachable
# Adapt the connection check to the project's database
# e.g., pg_isready, mysqladmin ping, mongo --eval "ping 1"
```

### Check: Dev Server Port

```bash
# Check for port conflicts on the dev server port
lsof -ti:{port} > /dev/null 2>&1 && echo "WARN: Port {port} in use" || echo "PASS: Port {port} available"
```

## Pattern: Detect → Auto-Fix → Verify

For each check:

1. **Detect** — Run the health check command
2. **Auto-fix** — If failed, attempt a reasonable fix (start service, install deps, free port)
3. **Verify** — Re-run the health check
4. **Abort only if** — Auto-fix failed after reasonable retries

## Stack-Specific Additions

Copy this file to your project's `.claude/skills/deep-auto/references/` and add
stack-specific checks. The pipeline reads this file during preflight.
