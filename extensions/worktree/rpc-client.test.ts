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

const skip = !process.env.SKIP_RPC_TESTS && !process.env.CI;
const skipIf = skip ? describe.skip : describe;

let testDir: string;
let repoDir: string;

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
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

skipIf("RpcClient", () => {
	let client: RpcClient;

	beforeAll(async () => {
		client = new RpcClient(repoDir, "test", "integration test");
		await client.start();
	}, 30_000);

	afterAll(() => {
		client?.kill();
	});

	it("starts and reports idle status", () => {
		expect(client.status.state).toBe("idle");
		expect(client.pid).toBeDefined();
	});

	it("responds to getState", async () => {
		const resp = await client.getState();
		expect(resp.success).toBe(true);
		expect(resp.data).toBeDefined();
	});

	it("handles a simple prompt", async () => {
		const resp = await client.prompt("Respond with exactly: RPC_TEST_OK");
		expect(resp.success).toBe(true);
	}, 60_000);

	it("collects streaming text from agent", async () => {
		let collected = "";

		const unsub = client.onEvent((event) => {
			if (event.type === "message_update") {
				const delta = (event as any).assistantMessageEvent;
				if (delta?.type === "text_delta" && delta?.delta) {
					collected += delta.delta;
				}
			}
		});

		await client.prompt("Say hello in exactly 3 words");
		// Wait for agent_end
		await new Promise<void>((resolve) => {
			const u2 = client.onEvent((event) => {
				if (event.type === "agent_end") { u2(); resolve(); }
			});
		});

		unsub();
		expect(collected.length).toBeGreaterThan(0);
	}, 60_000);

	it("reports agent_end after prompt completes", async () => {
		let gotAgentEnd = false;
		const unsub = client.onEvent((event) => {
			if (event.type === "agent_end") gotAgentEnd = true;
		});

		await client.prompt("Say OK");
		// Small delay to let events flow
		await new Promise((r) => setTimeout(r, 2000));

		unsub();
		expect(gotAgentEnd).toBe(true);
	}, 60_000);

	it("tracks turn count", async () => {
		const before = client.status.turnCount;
		await client.prompt("Say OK");
		await new Promise((r) => setTimeout(r, 2000));
		expect(client.status.turnCount).toBeGreaterThan(before);
	}, 60_000);

	it("can be killed", () => {
		const pid = client.pid;
		client.kill();
		expect(client.status.state).toBe("dead");
		// Process should be gone
		expect(() => process.kill(pid!, 0)).toThrow();
	});
});
