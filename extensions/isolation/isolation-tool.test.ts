/**
 * Tests for isolation extension tool-call logic.
 *
 * Tests the checkPath() function and the overall tool_call interception
 * logic without needing a real pi context.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	isHardForbidden,
	isWithinBase,
	isWithinAllowed,
	isBashCommandRestricted,
	extractPathsFromBash,
} from "./isolation-helpers.js";

const CWD = "/Users/test/project";

// ─── Tool call simulation ───────────────────────────────────────────

interface ToolCallInput {
	toolName: string;
	input: Record<string, string>;
}

/**
 * Simulates the isolation check for a tool call.
 * Mirrors the logic in isolation/index.ts tool_call handler.
 */
function simulateToolCheck(
	call: ToolCallInput,
	opts: {
		cwd: string;
		bypass?: boolean;
		enabled?: boolean;
		allowPaths?: string[];
	},
): { blocked: boolean; reason?: string } {
	const { cwd, bypass = false, enabled = true, allowPaths = [] } = opts;

	if (bypass || !enabled) return { blocked: false };

	const WRITE_TOOLS = new Set(["write", "edit"]);

	if (WRITE_TOOLS.has(call.toolName)) {
		const filePath = call.input.path ?? "";
		if (!filePath) return { blocked: false };

		if (isHardForbidden(filePath)) {
			return { blocked: true, reason: `hard-forbidden: ${filePath}` };
		}

		if (!isWithinBase(filePath, cwd) && !isWithinAllowed(filePath, allowPaths)) {
			return { blocked: true, reason: `outside cwd: ${filePath}` };
		}
	}

	if (call.toolName === "bash") {
		const command = call.input.command ?? "";
		if (!command) return { blocked: false };

		if (isBashCommandRestricted(command)) {
			const paths = extractPathsFromBash(command);
			for (const p of paths) {
				if (p.startsWith("__RECURSIVE__:")) {
					const actual = p.replace("__RECURSIVE__:", "");
					if (isHardForbidden(actual) || /\.git/.test(actual)) {
						return { blocked: true, reason: `recursive delete forbidden: ${actual}` };
					}
					if (!isWithinBase(actual, cwd) && !isWithinAllowed(actual, allowPaths)) {
						return { blocked: true, reason: `recursive delete outside cwd: ${actual}` };
					}
				} else {
					if (isHardForbidden(p)) {
						return { blocked: true, reason: `hard-forbidden: ${p}` };
					}
					if (!isWithinBase(p, cwd) && !isWithinAllowed(p, allowPaths)) {
						return { blocked: true, reason: `outside cwd: ${p}` };
					}
				}
			}
			if (paths.length === 0) {
				return { blocked: true, reason: `restricted command, no paths extracted` };
			}
		}
	}

	return { blocked: false };
}

// ─── Write/Edit tool checks ─────────────────────────────────────────

describe("isolation tool — write/edit", () => {
	const opts = { cwd: CWD, enabled: true };

	it("allows write to project files", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "src/index.ts", content: "hello" } },
			opts,
		);
		expect(result.blocked).toBe(false);
	});

	it("allows edit to project files", () => {
		const result = simulateToolCheck(
			{ toolName: "edit", input: { path: "README.md", oldText: "a", newText: "b" } },
			opts,
		);
		expect(result.blocked).toBe(false);
	});

	it("allows absolute path within cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/Users/test/project/src/new.ts", content: "" } },
			opts,
		);
		expect(result.blocked).toBe(false);
	});

	it("blocks write to hard-forbidden paths", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/etc/hosts", content: "evil" } },
			opts,
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("hard-forbidden");
	});

	it("blocks write to .git", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: ".git/refs/heads/main", content: "evil" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("blocks write to paths outside cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/tmp/evil.sh", content: "rm -rf /" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("blocks write to sibling project dirs", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/Users/test/other-project/file.ts", content: "" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("allows write to escaped path", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/tmp/build-output/bundle.js", content: "" } },
			{ cwd: CWD, enabled: true, allowPaths: ["/tmp/build-output"] },
		);
		expect(result.blocked).toBe(false);
	});

	it("skips check when bypass is on", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/etc/hosts", content: "evil" } },
			{ cwd: CWD, bypass: true },
		);
		expect(result.blocked).toBe(false);
	});

	it("skips check when isolation is disabled", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/etc/hosts", content: "evil" } },
			{ cwd: CWD, enabled: false },
		);
		expect(result.blocked).toBe(false);
	});

	it("allows write with empty path (no-op)", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { content: "hello" } },
			opts,
		);
		expect(result.blocked).toBe(false);
	});
});

// ─── Bash tool checks ───────────────────────────────────────────────

describe("isolation tool — bash", () => {
	const opts = { cwd: CWD, enabled: true };

	it("allows safe commands (ls, cat, grep)", () => {
		for (const cmd of ["ls", "ls -la", "cat README.md", "grep -r pattern src/", "git status"]) {
			const result = simulateToolCheck(
				{ toolName: "bash", input: { command: cmd } },
				opts,
			);
			expect(result.blocked, `Expected "${cmd}" to be allowed`).toBe(false);
		}
	});

	it("allows npm/pnpm test and build", () => {
		for (const cmd of ["npm test", "npm run build", "pnpm install", "pnpm test"]) {
			const result = simulateToolCheck(
				{ toolName: "bash", input: { command: cmd } },
				opts,
			);
			expect(result.blocked, `Expected "${cmd}" to be allowed`).toBe(false);
		}
	});

	it("blocks rm -rf on .git", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "rm -rf .git" } },
			opts,
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("recursive delete");
	});

	it("blocks rm -rf outside cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "rm -rf /tmp/something" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("allows rm -rf within cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "rm -rf node_modules" } },
			opts,
		);
		expect(result.blocked).toBe(false);
	});

	it("blocks destructive commands with no extractable paths", () => {
		// `chmod` with no path args that match our regex
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "chmod" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("blocks python script execution", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "python3 -c 'import os'" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("blocks node eval", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "node -e 'console.log(1)'" } },
			opts,
		);
		expect(result.blocked).toBe(true);
	});

	it("allows bash with empty command (no-op)", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: {} },
			opts,
		);
		expect(result.blocked).toBe(false);
	});
});

// ─── Read tool (always allowed) ─────────────────────────────────────

describe("isolation tool — read", () => {
	it("allows read tool unconditionally", () => {
		const result = simulateToolCheck(
			{ toolName: "read", input: { path: "/etc/hosts" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(false);
	});
});

// ─── Bypass and disabled modes ───────────────────────────────────────

describe("isolation tool — modes", () => {
	it("bypass allows everything", () => {
		for (const call of [
			{ toolName: "write", input: { path: "/etc/hosts", content: "x" } },
			{ toolName: "bash", input: { command: "rm -rf /" } },
		]) {
			expect(simulateToolCheck(call, { cwd: CWD, bypass: true }).blocked).toBe(false);
		}
	});

	it("disabled allows everything", () => {
		for (const call of [
			{ toolName: "write", input: { path: "/etc/hosts", content: "x" } },
			{ toolName: "bash", input: { command: "rm -rf /" } },
		]) {
			expect(simulateToolCheck(call, { cwd: CWD, enabled: false }).blocked).toBe(false);
		}
	});
});

// ─── Escape hatches ─────────────────────────────────────────────────

describe("isolation tool — escape hatches", () => {
	it("allows write to escaped path", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/tmp/deploy/bundle.js", content: "" } },
			{ cwd: CWD, enabled: true, allowPaths: ["/tmp/deploy"] },
		);
		expect(result.blocked).toBe(false);
	});

	it("still blocks hard-forbidden even with escape hatch", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/etc/hosts", content: "x" } },
			{ cwd: CWD, enabled: true, allowPaths: ["/etc"] },
		);
		expect(result.blocked).toBe(true);
	});

	it("does not allow non-matching escaped paths", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "/tmp/other/file.txt", content: "" } },
			{ cwd: CWD, enabled: true, allowPaths: ["/tmp/deploy"] },
		);
		expect(result.blocked).toBe(true);
	});
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe("isolation tool — edge cases", () => {
	it("handles nested paths correctly", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "src/deep/nested/file.ts", content: "" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(false);
	});

	it("handles path traversal attempts", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "../../etc/hosts", content: "x" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(true);
	});

	it("handles dot-dot in the middle of path", () => {
		const result = simulateToolCheck(
			{ toolName: "write", input: { path: "src/../src/file.ts", content: "" } },
			{ cwd: CWD, enabled: true },
		);
		// This resolves within cwd, so should be allowed
		expect(result.blocked).toBe(false);
	});

	it("handles unknown tool names (allowed)", () => {
		const result = simulateToolCheck(
			{ toolName: "grep", input: { pattern: "test" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(false);
	});

	it("handles mv destination outside cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "mv file.txt /tmp/" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(true);
	});

	it("handles cp to destination outside cwd", () => {
		const result = simulateToolCheck(
			{ toolName: "bash", input: { command: "cp secret.txt /tmp/" } },
			{ cwd: CWD, enabled: true },
		);
		expect(result.blocked).toBe(true);
	});
});
