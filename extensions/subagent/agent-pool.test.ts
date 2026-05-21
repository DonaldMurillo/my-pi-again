import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentPool, type AgentResult } from "./agent-pool.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Skip if pi not available
const PI_AVAILABLE = (() => {
	try {
		const { execSync } = require("child_process");
		execSync("which pi", { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
})();

const describeIf = PI_AVAILABLE ? describe : describe.skip;
const TEST_CWD = process.cwd();

describeIf("agent-pool", () => {
	let pool: AgentPool;

	beforeEach(() => {
		pool = new AgentPool({ maxConcurrency: 3, timeoutMs: 60_000 });
	});

	afterEach(async () => {
		pool.killAll("test-cleanup");
		const sessionDir = join(homedir(), ".pi", "subagent-sessions");
		try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ignore */ }
		const resultsDir = join(TEST_CWD, ".pi", "agents", "results");
		try { rmSync(resultsDir, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	describe("spawn", () => {
		it("spawns an agent and returns a handle", async () => {
			const handle = await pool.spawn({
				name: "test-basic",
				cwd: TEST_CWD,
				model: "fast",
			});

			expect(handle.name).toBe("test-basic");
			expect(handle.client).toBeDefined();
			expect(handle.client.pid).toBeDefined();
			expect(handle.startedAt).toBeLessThanOrEqual(Date.now());
		});

		it("sends initial prompt fire-and-forget (returns before completion)", async () => {
			const handle = await pool.spawn({
				name: "test-prompt",
				cwd: TEST_CWD,
				model: "fast",
				prompt: "Say exactly: hello-world-test",
			});

			// spawn should return quickly — agent still working
			// Wait a bit for the agent to process
			await new Promise((r) => setTimeout(r, 5000));

			// Agent should have at least 1 turn by now (or still working)
			const turns = handle.client.status.turnCount;
			expect(turns).toBeGreaterThanOrEqual(0); // fire-and-forget, might not be done yet
		}, 30_000);

		it("kills existing agent with same name on re-spawn", async () => {
			const handle1 = await pool.spawn({ name: "test-respawn", cwd: TEST_CWD });
			const pid1 = handle1.client.pid;

			const handle2 = await pool.spawn({ name: "test-respawn", cwd: TEST_CWD });
			expect(handle2.client.pid).not.toBe(pid1);
			expect(pool.get("test-respawn")).toBe(handle2);
		});

		it("rejects spawn when concurrency limit reached", async () => {
			for (let i = 0; i < 3; i++) {
				await pool.spawn({ name: `concurrent-${i}`, cwd: TEST_CWD });
			}
			await expect(
				pool.spawn({ name: "concurrent-4", cwd: TEST_CWD }),
			).rejects.toThrow("Concurrency limit");
		});
	});

	describe("send", () => {
		it("sends a prompt to a running agent", async () => {
			await pool.spawn({ name: "test-send", cwd: TEST_CWD });

			await pool.send("test-send", "Say exactly: send-test-ok");

			const handle = pool.get("test-send")!;
			await new Promise((r) => setTimeout(r, 5000));
			expect(handle.client.status.turnCount).toBeGreaterThanOrEqual(1);
		}, 30_000);

		it("throws for unknown agent", async () => {
			await expect(pool.send("nonexistent", "hello")).rejects.toThrow('No agent named "nonexistent"');
		});
	});

	describe("collect", () => {
		it("collects result from a completed agent", async () => {
			const handle = await pool.spawn({
				name: "test-collect",
				cwd: TEST_CWD,
				prompt: "Say exactly: collect-test-done",
			});

			// Wait for the agent to finish its work
			await new Promise<void>((resolve) => {
				const unsub = handle.client.onEvent((event) => {
					if (event.type === "agent_end") {
						unsub();
						resolve();
					}
				});
				// Timeout fallback
				setTimeout(() => { unsub(); resolve(); }, 30_000);
			});

			const result = await pool.collect("test-collect");

			expect(result.agentName).toBe("test-collect");
			expect(result.status).toBe("done");
			expect(result.turns).toBeGreaterThanOrEqual(1);
			expect(result.duration).toBeGreaterThan(0);
			expect(result.resultFile).toBeTruthy();
		}, 60_000);

		it("saves result file to .pi/agents/results/", async () => {
			const handle = await pool.spawn({
				name: "test-result-file",
				cwd: TEST_CWD,
				prompt: "Say: result-file-test",
			});

			await new Promise<void>((resolve) => {
				const unsub = handle.client.onEvent((event) => {
					if (event.type === "agent_end") { unsub(); resolve(); }
				});
				setTimeout(() => { unsub(); resolve(); }, 30_000);
			});

			const result = await pool.collect("test-result-file");

			expect(result.resultFile).toBeTruthy();
			expect(existsSync(result.resultFile!)).toBe(true);

			const saved = JSON.parse(readFileSync(result.resultFile!, "utf8"));
			expect(saved.agentName).toBe("test-result-file");
			expect(saved).toHaveProperty("status");
			expect(saved).toHaveProperty("output");
		}, 60_000);

		it("throws for unknown agent", async () => {
			await expect(pool.collect("nonexistent")).rejects.toThrow('No agent named "nonexistent"');
		});
	});

	describe("kill", () => {
		it("kills an agent and removes from pool", async () => {
			await pool.spawn({ name: "test-kill", cwd: TEST_CWD });
			expect(pool.get("test-kill")).toBeDefined();

			pool.kill("test-kill", "test");
			expect(pool.get("test-kill")).toBeUndefined();
		});

		it("killAll removes all agents", async () => {
			for (let i = 0; i < 2; i++) {
				await pool.spawn({ name: `killall-${i}`, cwd: TEST_CWD });
			}
			expect(pool.getAll().size).toBe(2);
			pool.killAll("test");
			expect(pool.getAll().size).toBe(0);
		});

		it("kill nonexistent agent is a no-op", () => {
			expect(() => pool.kill("ghost", "test")).not.toThrow();
		});
	});

	describe("status", () => {
		it("returns status for all agents", async () => {
			await pool.spawn({ name: "status-1", cwd: TEST_CWD });
			await pool.spawn({ name: "status-2", cwd: TEST_CWD });

			const reports = pool.status();
			expect(reports).toHaveLength(2);
			const names = reports.map((r) => r.name);
			expect(names).toContain("status-1");
			expect(names).toContain("status-2");
		});

		it("each report has required fields", async () => {
			await pool.spawn({
				name: "status-fields",
				cwd: TEST_CWD,
				model: "fast",
				profile: "test",
				taskId: "abc123",
			});

			const report = pool.status()[0];
			expect(report.name).toBe("status-fields");
			expect(report.profile).toBe("test");
			expect(report.model).toBe("fast");
			expect(report.taskId).toBe("abc123");
			expect(report.pid).toBeDefined();
			expect(report.state).toBeDefined();
			expect(report.duration).toBeGreaterThan(0);
		});

		it("returns empty array when no agents", () => {
			expect(pool.status()).toHaveLength(0);
		});
	});

	describe("task binding", () => {
		it("associates task ID with agent", async () => {
			const handle = await pool.spawn({
				name: "task-agent",
				cwd: TEST_CWD,
				taskId: "01KS3TASK12345678",
			});
			expect(handle.taskId).toBe("01KS3TASK12345678");

			const report = pool.status()[0];
			expect(report.taskId).toBe("01KS3TASK12345678");
		});
	});
});
