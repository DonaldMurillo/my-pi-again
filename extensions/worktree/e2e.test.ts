/**
 * E2E test for inter-worktree orchestration.
 *
 * Tests the full flow: create → spawn → send → collect → coordinate.
 * Costs API tokens. Uses try/finally for guaranteed cleanup.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { RpcClient } from "./rpc-client.js";
import {
	createWorktree,
	removeWorktree,
	listWorktrees,
	getRepoRoot,
} from "./worktree-manager.js";

let testDir: string;
let repoDir: string;
const agents: RpcClient[] = [];

// Global safety net — kills any surviving agents and removes test dir
afterAll(() => {
	for (const a of agents) {
		try { a.kill(); } catch {}
	}
	agents.length = 0;
	if (testDir) {
		try { rmSync(testDir, { recursive: true, force: true }); } catch {}
	}
});

describe("inter-worktree orchestration", () => {
	it("creates two worktrees", () => {
		testDir = mkdtempSync(join(tmpdir(), "wt-e2e-"));
		repoDir = join(testDir, "repo");

		execSync(`git init "${repoDir}"`, { encoding: "utf8" });
		execSync(`git -C "${repoDir}" config user.email "test@test.com"`);
		execSync(`git -C "${repoDir}" config user.name "Test"`);
		writeFileSync(join(repoDir, "README.md"), "# test");
		execSync(`git -C "${repoDir}" add -A`);
		execSync(`git -C "${repoDir}" commit -m "initial"`);

		createWorktree(repoDir, "e2e-alpha", "test agent alpha");
		createWorktree(repoDir, "e2e-beta", "test agent beta");

		const wts = listWorktrees(repoDir);
		expect(wts.find((w) => w.branch === "e2e-alpha")).toBeDefined();
		expect(wts.find((w) => w.branch === "e2e-beta")).toBeDefined();
	});

	it("spawns agents in both worktrees", async () => {
		const root = getRepoRoot(repoDir)!;

		const alpha = new RpcClient(
			join(root, ".pi", "worktrees", "e2e-alpha"),
			"e2e-alpha",
			"test agent alpha",
		);
		await alpha.start();
		agents.push(alpha);

		const beta = new RpcClient(
			join(root, ".pi", "worktrees", "e2e-beta"),
			"e2e-beta",
			"test agent beta",
		);
		await beta.start();
		agents.push(beta);

		expect(alpha.status.state).toBe("idle");
		expect(beta.status.state).toBe("idle");
	}, 60_000);

	it("sends independent tasks to both agents", async () => {
		const alpha = agents[0];
		const beta = agents[1];

		const [alphaResp, betaResp] = await Promise.all([
			alpha.prompt("Write a file called result.txt containing the word ALPHA. Use the write tool."),
			beta.prompt("Write a file called result.txt containing the word BETA. Use the write tool."),
		]);

		expect(alphaResp.success).toBe(true);
		expect(betaResp.success).toBe(true);
	}, 120_000);

	it("both agents wrote to their own worktree (isolated)", () => {
		const root = getRepoRoot(repoDir)!;

		const alphaResult = join(root, ".pi", "worktrees", "e2e-alpha", "result.txt");
		const betaResult = join(root, ".pi", "worktrees", "e2e-beta", "result.txt");

		const alphaContent = readFileSync(alphaResult, "utf8");
		const betaContent = readFileSync(betaResult, "utf8");

		expect(alphaContent).toContain("ALPHA");
		expect(betaContent).toContain("BETA");
		expect(alphaContent).not.toContain("BETA");
		expect(betaContent).not.toContain("ALPHA");
	});

	it("main session can send follow-up to a specific agent", async () => {
		const alpha = agents[0];

		await alpha.prompt("Read the file result.txt and confirm it contains ALPHA");
		expect(alpha.status.turnCount).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("tracks costs or turn counts across agents", () => {
		const alpha = agents[0];
		const beta = agents[1];

		const totalTurns = alpha.status.turnCount + beta.status.turnCount;
		expect(totalTurns).toBeGreaterThan(0);
	});

	it("kills agents and cleans up worktrees", () => {
		for (const a of agents) {
			try { a.kill(); } catch {}
		}
		agents.length = 0;

		removeWorktree(repoDir, "e2e-alpha");
		removeWorktree(repoDir, "e2e-beta");

		const wts = listWorktrees(repoDir);
		expect(wts.find((w) => w.branch === "e2e-alpha")).toBeUndefined();
		expect(wts.find((w) => w.branch === "e2e-beta")).toBeUndefined();

		// Clean up test dir immediately
		try { rmSync(testDir, { recursive: true, force: true }); } catch {}
	});
});
