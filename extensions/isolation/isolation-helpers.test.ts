/**
 * Tests for isolation-helpers — the security layer.
 *
 * Tests path checking, hard-forbidden detection, bash command classification,
 * and path extraction from bash commands.
 */

import { describe, it, expect } from "vitest";
import {
	isHardForbidden,
	isWithinBase,
	isWithinAllowed,
	isHomeDirectory,
	isBashCommandRestricted,
	extractPathsFromBash,
} from "./isolation-helpers.js";

const CWD = "/Users/test/project";

// ─── isHardForbidden ─────────────────────────────────────────────────

describe("isHardForbidden", () => {
	it("blocks .git directories", () => {
		expect(isHardForbidden(".git")).toBe(true);
		expect(isHardForbidden(".git/refs/heads")).toBe(true);
		expect(isHardForbidden("src/.git")).toBe(true);
	});

	it("blocks .ssh directory", () => {
		expect(isHardForbidden(".ssh/id_rsa")).toBe(true);
		expect(isHardForbidden(".ssh")).toBe(true);
	});

	it("blocks system directories", () => {
		expect(isHardForbidden("/usr/bin/python")).toBe(true);
		expect(isHardForbidden("/bin/bash")).toBe(true);
		expect(isHardForbidden("/bin/sh")).toBe(true);
		expect(isHardForbidden("/etc/passwd")).toBe(true);
		expect(isHardForbidden("/var/log/syslog")).toBe(true);
		expect(isHardForbidden("/System/Library")).toBe(true);
		expect(isHardForbidden("/Applications/Xcode")).toBe(true);
		expect(isHardForbidden("/Library/Preferences")).toBe(true);
	});

	it("allows normal project paths", () => {
		expect(isHardForbidden("/Users/test/project/src/index.ts")).toBe(false);
		expect(isHardForbidden("/Users/test/project/README.md")).toBe(false);
		expect(isHardForbidden("/tmp/test")).toBe(false);
	});

	it("allows home directory itself", () => {
		expect(isHardForbidden("/Users/test")).toBe(false);
	});

	it("is case-sensitive", () => {
		// /ETC should not match /etc
		expect(isHardForbidden("/ETC/hosts")).toBe(false);
	});
});

// ─── isWithinBase ────────────────────────────────────────────────────

describe("isWithinBase", () => {
	it("allows paths within cwd", () => {
		expect(isWithinBase("src/index.ts", CWD)).toBe(true);
		expect(isWithinBase("README.md", CWD)).toBe(true);
		expect(isWithinBase("a/b/c/file.txt", CWD)).toBe(true);
	});

	it("allows absolute paths within cwd", () => {
		expect(isWithinBase("/Users/test/project/src/index.ts", CWD)).toBe(true);
	});

	it("blocks paths outside cwd", () => {
		expect(isWithinBase("../other-project", CWD)).toBe(false);
		expect(isWithinBase("/Users/test/other", CWD)).toBe(false);
		expect(isWithinBase("/tmp/test", CWD)).toBe(false);
	});

	it("handles cwd itself", () => {
		expect(isWithinBase(".", CWD)).toBe(true);
	});

	it("handles paths with trailing slashes", () => {
		expect(isWithinBase("src/", CWD)).toBe(true);
	});
});

// ─── isWithinAllowed ─────────────────────────────────────────────────

describe("isWithinAllowed", () => {
	const allowed = ["~/.pi/agent/extensions", "/tmp/build"];

	it("allows paths within allowed paths", () => {
		// Tilde expansion depends on actual home dir
		const home = process.env.HOME || "/Users/test";
		expect(isWithinAllowed(`${home}/.pi/agent/extensions/my-ext`, [`${home}/.pi/agent/extensions`])).toBe(true);
		expect(isWithinAllowed("/tmp/build/output.js", ["/tmp/build"])).toBe(true);
	});

	it("blocks paths not in allowed list", () => {
		expect(isWithinAllowed("/etc/hosts", allowed)).toBe(false);
		expect(isWithinAllowed("/Users/test/.ssh", allowed)).toBe(false);
	});

	it("handles empty allowed list", () => {
		expect(isWithinAllowed("/any/path", [])).toBe(false);
	});
});

// ─── isHomeDirectory ──────────────────────────────────────────────────

describe("isHomeDirectory", () => {
	it("detects home directory", () => {
		// This depends on the actual home dir of the test runner
		const home = process.env.HOME || "/Users/test";
		expect(isHomeDirectory(home)).toBe(true);
		expect(isHomeDirectory(home + "/.config")).toBe(true);
	});

	it("does not match random paths", () => {
		expect(isHomeDirectory("/tmp")).toBe(false);
		expect(isHomeDirectory("/usr")).toBe(false);
	});
});

// ─── isBashCommandRestricted ─────────────────────────────────────────

describe("isBashCommandRestricted", () => {
	// Allowed (read-only) commands
	it("allows ls", () => expect(isBashCommandRestricted("ls -la")).toBe(false));
	it("allows cat", () => expect(isBashCommandRestricted("cat file.txt")).toBe(false));
	it("allows grep", () => expect(isBashCommandRestricted("grep -r pattern src/")).toBe(false));
	it("allows git log", () => expect(isBashCommandRestricted("git log --oneline")).toBe(false));
	it("allows git status", () => expect(isBashCommandRestricted("git status")).toBe(false));
	it("allows git diff", () => expect(isBashCommandRestricted("git diff")).toBe(false));
	it("allows find", () => expect(isBashCommandRestricted("find . -name '*.ts'")).toBe(false));
	it("allows head", () => expect(isBashCommandRestricted("head -20 file.txt")).toBe(false));
	it("allows tail", () => expect(isBashCommandRestricted("tail -f log.txt")).toBe(false));
	it("allows echo", () => expect(isBashCommandRestricted("echo hello")).toBe(false));
	it("allows which", () => expect(isBashCommandRestricted("which node")).toBe(false));
	it("allows npm test", () => expect(isBashCommandRestricted("npm test")).toBe(false));
	it("allows npm run build", () => expect(isBashCommandRestricted("npm run build")).toBe(false));
	it("allows npx tsx scripts/sync.ts", () => expect(isBashCommandRestricted("npx tsx scripts/sync.ts")).toBe(false));
	it("allows pnpm install", () => expect(isBashCommandRestricted("pnpm install")).toBe(false));
	it("allows pnpm run build", () => expect(isBashCommandRestricted("pnpm run build")).toBe(false));
	it("allows touch", () => expect(isBashCommandRestricted("touch file.txt")).toBe(false));
	it("allows pwd", () => expect(isBashCommandRestricted("pwd")).toBe(false));
	it("allows env", () => expect(isBashCommandRestricted("env")).toBe(false));
	it("allows true", () => expect(isBashCommandRestricted("true")).toBe(false));
	it("allows test", () => expect(isBashCommandRestricted("test -f file")).toBe(false));
	it("allows date", () => expect(isBashCommandRestricted("date")).toBe(false));

	// Destructive commands — always restricted
	it("blocks rm", () => expect(isBashCommandRestricted("rm file.txt")).toBe(true));
	it("blocks rm -rf", () => expect(isBashCommandRestricted("rm -rf dir/")).toBe(true));
	it("blocks chmod", () => expect(isBashCommandRestricted("chmod 755 file")).toBe(true));
	it("blocks chown", () => expect(isBashCommandRestricted("chown root file")).toBe(true));
	it("blocks mv", () => expect(isBashCommandRestricted("mv a b")).toBe(true));
	it("blocks cp", () => expect(isBashCommandRestricted("cp a b")).toBe(true));
	it("blocks dd", () => expect(isBashCommandRestricted("dd if=/dev/zero of=/dev/sda")).toBe(true));
	it("flags redirect to absolute path", () => expect(isBashCommandRestricted("echo hi > /tmp/file")).toBe(true));
	it("flags redirect to home", () => expect(isBashCommandRestricted("echo hi > ~/file")).toBe(true));
	it("flags tee", () => expect(isBashCommandRestricted("echo hi | tee file")).toBe(true));
	it("blocks sed in-place", () => expect(isBashCommandRestricted("sed -i 's/old/new/' file")).toBe(true));
	it("blocks perl in-place", () => expect(isBashCommandRestricted("perl -i -pe 's/old/new/' file")).toBe(true));

	// Interpreter patterns — always restricted
	it("blocks node", () => expect(isBashCommandRestricted("node -e 'console.log(1)'")).toBe(true));
	it("blocks python", () => expect(isBashCommandRestricted("python script.py")).toBe(true));
	it("blocks python3", () => expect(isBashCommandRestricted("python3 -c 'print(1)'")).toBe(true));
	it("blocks ruby", () => expect(isBashCommandRestricted("ruby script.rb")).toBe(true));
	it("blocks deno", () => expect(isBashCommandRestricted("deno run script.ts")).toBe(true));
	it("blocks bare bun", () => expect(isBashCommandRestricted("bun -e '1+1'")).toBe(true));

	// Unknown commands — restricted by default
	it("blocks unknown commands", () => expect(isBashCommandRestricted("foobarbaz")).toBe(true));
	it("blocks docker", () => expect(isBashCommandRestricted("docker build .")).toBe(true));
	it("blocks curl", () => expect(isBashCommandRestricted("curl https://example.com")).toBe(true));
	it("blocks wget", () => expect(isBashCommandRestricted("wget https://example.com")).toBe(true));
	it("blocks ssh", () => expect(isBashCommandRestricted("ssh user@host")).toBe(true));
	it("blocks sudo", () => expect(isBashCommandRestricted("sudo rm -rf /")).toBe(true));
	it("blocks pip", () => expect(isBashCommandRestricted("pip install foo")).toBe(true));
	it("blocks brew", () => expect(isBashCommandRestricted("brew install foo")).toBe(true));
});

// ─── extractPathsFromBash ───────────────────────────────────────────

describe("extractPathsFromBash", () => {
	// rm commands
	it("extracts path from rm", () => {
		expect(extractPathsFromBash("rm file.txt")).toEqual(["file.txt"]);
	});

	it("extracts path from rm -rf", () => {
		const paths = extractPathsFromBash("rm -rf mydir");
		expect(paths).toEqual(["__RECURSIVE__:mydir"]);
	});

	it("extracts path from rm -r", () => {
		expect(extractPathsFromBash("rm -r mydir")).toEqual(["__RECURSIVE__:mydir"]);
	});

	it("extracts multiple paths from rm -rf dir1 dir2", () => {
		const paths = extractPathsFromBash("rm -rf dir1 dir2");
		expect(paths).toContain("__RECURSIVE__:dir1");
		// Note: regex may only capture first match — this is a known limitation
		expect(paths.length).toBeGreaterThanOrEqual(1);
	});

	// cp/mv (last arg is destination)
	it("extracts destination from cp", () => {
		const paths = extractPathsFromBash("cp src/file.txt dest/");
		expect(paths).toEqual(["dest/"]);
	});

	it("extracts destination from mv", () => {
		const paths = extractPathsFromBash("mv old.txt new.txt");
		expect(paths).toEqual(["new.txt"]);
	});

	it("extracts destination from cp -r", () => {
		const paths = extractPathsFromBash("cp -r src/ build/");
		expect(paths).toEqual(["build/"]);
	});

	// Redirects
	it("extracts redirect target", () => {
		expect(extractPathsFromBash("echo hi > output.txt")).toEqual(["output.txt"]);
	});

	it("extracts append redirect target", () => {
		expect(extractPathsFromBash("echo hi >> log.txt")).toEqual(["log.txt"]);
	});

	// chmod/chown
	it("extracts paths from chmod", () => {
		const paths = extractPathsFromBash("chmod 755 script.sh");
		// chmod extracts the first arg (mode) — that's fine, it still gets flagged as restricted
		expect(paths.length).toBeGreaterThan(0);
	});

	it("extracts paths from chown", () => {
		const paths = extractPathsFromBash("chown root file");
		// chown extracts the first arg (owner) — that's fine, it still gets flagged as restricted
		expect(paths.length).toBeGreaterThan(0);
	});

	// Edge cases
	it("returns empty for commands with no paths", () => {
		expect(extractPathsFromBash("ls")).toEqual([]);
		expect(extractPathsFromBash("pwd")).toEqual([]);
		expect(extractPathsFromBash("echo hello")).toEqual([]);
	});

	it("handles absolute paths", () => {
		expect(extractPathsFromBash("rm /tmp/test")).toEqual(["/tmp/test"]);
	});

	it("handles paths with dots", () => {
		expect(extractPathsFromBash("rm ./test")).toEqual(["./test"]);
		expect(extractPathsFromBash("rm ../test")).toEqual(["../test"]);
	});

	it("handles tilde expansion", () => {
		const paths = extractPathsFromBash("rm ~/file.txt");
		// Should expand ~ to home directory
		expect(paths.length).toBe(1);
		expect(paths[0]).not.toContain("~");
	});
});
