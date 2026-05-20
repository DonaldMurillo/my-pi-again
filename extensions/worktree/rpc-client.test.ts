/**
 * Integration test for RPC client — spawns an actual pi process.
 *
 * Requires pi to be installed and a valid provider configured.
 * Run with: npx vitest run extensions/worktree/rpc-client.test.ts
 *
 * Skips automatically if SKIP_RPC_TESTS is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { RpcClient } from "./rpc-client.js";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const skip = false;

let testDir: string;
let repoDir: string;
let client: RpcClient | null = null;

beforeAll(() => {
	testDir = mkdtempSync(join(tmpdir(), "rpc-test-"));
	repoDir = join(testDir, "repo");

	execSync(`git init "${repoDir}"`, { encoding: "utf8" });
	execSync(`git -C "${repoDir}" config user.email "test@test.com"`);
	execSync(`git -C "${repoDir}" config user.name "Test"`);
	writeFileSync(join(repoDir, "README.md"), "# test");
	execSync(`git -C "${repoDir}" add -A`);
	execSync(`git -C "${repoDir}" commit -m "initial"`);
});

afterAll(() => {
	try { client?.kill(); } catch {}
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

describe("RpcClient", () => {
	beforeAll(async () => {
		client = new RpcClient(repoDir, "test", "integration test");
		await client.start();
	}, 30_000);

	it("starts and reports idle status", () => {
		expect(client!.status.state).toBe("idle");
		expect(client!.pid).toBeDefined();
	});

	it("responds to getState", async () => {
		const resp = await client!.getState();
		expect(resp.success).toBe(true);
		expect(resp.data).toBeDefined();
	});

	it("handles a simple prompt", async () => {
		const resp = await client!.prompt("Respond with exactly: RPC_TEST_OK");
		expect(resp.success).toBe(true);
	}, 60_000);

	it("collects streaming text from agent", async () => {
		let collected = "";

		const unsub = client!.onEvent((event) => {
			if (event.type === "message_update") {
				const delta = (event as any).assistantMessageEvent;
				if (delta?.type === "text_delta" && delta?.delta) {
					collected += delta.delta;
				}
			}
		});

		await client!.prompt("Say hello in exactly 3 words");
		unsub();
		expect(collected.length).toBeGreaterThan(0);
	}, 60_000);

	it("reports agent_end after prompt completes", async () => {
		await client!.prompt("Say OK");
		expect(client!.status.state).toBe("idle");
	}, 60_000);

	it("tracks turn count", async () => {
		const before = client!.status.turnCount;
		await client!.prompt("Say OK");
		expect(client!.status.turnCount).toBeGreaterThan(before);
	}, 60_000);

	it("can be killed", () => {
		client!.kill();
		expect(client!.status.state).toBe("dead");
	});
});
