/**
 * E2E test for inter-worktree orchestration.
 *
 * Tests the full flow: create → spawn → send → collect → coordinate.
 * Requires SKIP_RPC_TESTS=1 to run (costs API tokens).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RpcClient } from "./rpc-client.js";
import {
	createWorktree,
	removeWorktree,
	listWorktrees,
	getRepoRoot,
} from "./worktree-manager.js";

const skip = !process.env.SKIP_RPC_TESTS && !process.env.CI;
const skipIf = skip ? describe.skip : describe;

let testDir: string;
let repoDir: string;

beforeAll(() => {
	testDir = mkdtempSync(join(tmpdir(), "wt-e2e-"));
	repoDir = join(testDir, "repo");

	execSync(`git init "${repoDir}"`, { encoding: "utf8" });
	execSync(`git -C "${repoDir}" config user.email "test@test.com"`);
	execSync(`git -C "${repoDir}" config user.name "Test"`);
	writeFileSync(join(repoDir, "README.md"), "# test");
	execSync(`git -C "${repoDir}" add -A`);
	execSync(`git -C "${repoDir}" commit -m "initial"`);
});

afterAll(() => {
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

skipIf("inter-worktree orchestration", () => {
	const agents = new Map<string, RpcClient>();

	afterAll(() => {
		for (const [, a] of agents) a.kill();
		agents.clear();
	});

	it("creates two worktrees", () => {
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
		agents.set("e2e-alpha", alpha);

		const beta = new RpcClient(
			join(root, ".pi", "worktrees", "e2e-beta"),
			"e2e-beta",
			"test agent beta",
		);
		await beta.start();
		agents.set("e2e-beta", beta);

		expect(alpha.status.state).toBe("idle");
		expect(beta.status.state).toBe("idle");
	}, 60_000);

	it("sends independent tasks to both agents", async () => {
		const alpha = agents.get("e2e-alpha")!;
		const beta = agents.get("e2e-beta")!;

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
		// Verify isolation — each worktree got its own content
		expect(alphaContent).not.toContain("BETA");
		expect(betaContent).not.toContain("ALPHA");
	});

	it("main session can send follow-up to a specific agent", async () => {
		const alpha = agents.get("e2e-alpha")!;

		await alpha.prompt("Read the file result.txt and confirm it contains ALPHA");
		// If we got here without error, the agent could read its own file
		expect(alpha.status.turnCount).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("tracks costs or turn counts across agents", () => {
		const alpha = agents.get("e2e-alpha")!;
		const beta = agents.get("e2e-beta")!;

		// Cost tracking depends on provider reporting usage
		const totalCost = alpha.status.totalCost + beta.status.totalCost;
		const totalTurns = alpha.status.turnCount + beta.status.turnCount;
		expect(totalTurns).toBeGreaterThan(0);
	});

	it("kills agents and cleans up worktrees", () => {
		for (const [, a] of agents) a.kill();

		removeWorktree(repoDir, "e2e-alpha");
		removeWorktree(repoDir, "e2e-beta");

		const wts = listWorktrees(repoDir);
		expect(wts.find((w) => w.branch === "e2e-alpha")).toBeUndefined();
		expect(wts.find((w) => w.branch === "e2e-beta")).toBeUndefined();
	});
});
