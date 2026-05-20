/**
 * Unit tests for worktree-manager — git operations, metadata CRUD.
 *
 * Uses a temp git repo per test suite. No pi process spawned.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	getRepoRoot,
	listWorktrees,
	createWorktree,
	removeWorktree,
	getManagedWorktrees,
} from "./worktree-manager.js";

let testDir: string;
let repoDir: string;

beforeAll(() => {
	testDir = mkdtempSync(join(tmpdir(), "wt-test-"));
	repoDir = join(testDir, "repo");

	// Create a git repo
	execSync(`git init "${repoDir}"`, { encoding: "utf8" });
	execSync(`git -C "${repoDir}" config user.email "test@test.com"`);
	execSync(`git -C "${repoDir}" config user.name "Test"`);
	// Need at least one commit for worktrees to work
	writeFileSync(join(repoDir, "README.md"), "# test");
	execSync(`git -C "${repoDir}" add -A`);
	execSync(`git -C "${repoDir}" commit -m "initial"`);
});

afterAll(() => {
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
	// Clean up any worktrees between tests
	try {
		const wts = listWorktrees(repoDir);
		for (const wt of wts) {
			if (!wt.isCurrent && !wt.isMain) {
				try { execSync(`git -C "${repoDir}" worktree remove "${wt.path}" --force`); } catch {}
			}
		}
		// Clean up metadata
		const metaPath = join(repoDir, ".pi", "worktrees.json");
		if (existsSync(metaPath)) {
			writeFileSync(metaPath, JSON.stringify({ version: 1, worktrees: [] }));
		}
	} catch {}
});

describe("getRepoRoot", () => {
	it("returns root for a git repo", () => {
		const root = getRepoRoot(repoDir);
		expect(root).toBeTruthy();
		expect(root).toContain("wt-test-");
	});

	it("returns null outside a git repo", () => {
		const root = getRepoRoot(testDir);
		expect(root).toBeNull();
	});
});

describe("listWorktrees", () => {
	it("returns main worktree for a fresh repo", () => {
		const wts = listWorktrees(repoDir);
		expect(wts.length).toBeGreaterThanOrEqual(1);
		expect(wts[0].branch).toBe("main");
		expect(wts[0].path).toBeTruthy();
	});

	it("returns empty array outside git repo", () => {
		const wts = listWorktrees(testDir);
		expect(wts).toEqual([]);
	});
});

describe("createWorktree", () => {
	it("creates a new worktree and branch", () => {
		const result = createWorktree(repoDir, "feature-test", "testing");
		expect(result.branch).toBe("feature-test");
		expect(result.created).toBe(true);
		expect(existsSync(result.path)).toBe(true);

		// Should show in worktree list
		const wts = listWorktrees(repoDir);
		const found = wts.find((w) => w.branch === "feature-test");
		expect(found).toBeDefined();
		expect(found!.path).toBe(result.path);
	});

	it("creates worktree inside .pi/worktrees/", () => {
		const result = createWorktree(repoDir, "feature-path-test", "testing path");
		expect(result.path).toContain(".pi/worktrees/feature-path-test");
	});

	it("throws if branch already has a worktree", () => {
		createWorktree(repoDir, "feature-dup", "first");
		expect(() => createWorktree(repoDir, "feature-dup", "second")).toThrow();
	});

	it("persists metadata", () => {
		createWorktree(repoDir, "feature-meta", "metadata test");
		const managed = getManagedWorktrees(repoDir);
		const found = managed.find((w) => w.branch === "feature-meta");
		expect(found).toBeDefined();
		expect(found!.purpose).toBe("metadata test");
		expect(found!.createdAt).toBeTypeOf("number");
	});
});

describe("removeWorktree", () => {
	it("removes a managed worktree", () => {
		createWorktree(repoDir, "feature-remove", "to be removed");

		removeWorktree(repoDir, "feature-remove");

		const wts = listWorktrees(repoDir);
		expect(wts.find((w) => w.branch === "feature-remove")).toBeUndefined();

		const managed = getManagedWorktrees(repoDir);
		expect(managed.find((w) => w.branch === "feature-remove")).toBeUndefined();
	});

	it("throws for unknown branch", () => {
		expect(() => removeWorktree(repoDir, "nonexistent")).toThrow();
	});
});

describe("getManagedWorktrees", () => {
	it("returns empty array for fresh repo", () => {
		const managed = getManagedWorktrees(repoDir);
		// May have leftovers from other tests, filter
		const fresh = managed.filter((w) => w.branch.startsWith("feature-"));
		expect(fresh.length).toBe(0);
	});

	it("tracks multiple worktrees", () => {
		createWorktree(repoDir, "feature-multi-1", "first");
		createWorktree(repoDir, "feature-multi-2", "second");

		const managed = getManagedWorktrees(repoDir);
		const branches = managed.map((w) => w.branch);
		expect(branches).toContain("feature-multi-1");
		expect(branches).toContain("feature-multi-2");
	});
});
