/**
 * E2E tests — full pipeline with real pi subprocess.
 *
 * Tests the new async flow:
 *   spawn() → returns immediately
 *   collect() → waits for agent_end, returns result
 *   Fanout → spawns all, waits for all via collect()
 *
 * Uses real `pi --mode rpc` subprocesses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SubagentAPI, type SubagentEvents } from "./api.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

const TEST_DIR = join(homedir(), ".pi-test-e2e");
const TEST_CWD = join(TEST_DIR, "project");

function createRecordingEvents(): SubagentEvents & { recorded: Array<{ event: string; data: unknown }> } {
	const recorded: Array<{ event: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		recorded,
		emit(event: string, data: unknown) {
			recorded.push({ event, data });
			const hs = handlers.get(event) ?? [];
			for (const h of hs) { try { h(data); } catch { /* */ } }
		},
		on(event: string, handler: (data: unknown) => void) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return () => {
				const hs = handlers.get(event);
				if (hs) { const idx = hs.indexOf(handler); if (idx >= 0) hs.splice(idx, 1); }
			};
		},
	};
}

describeIf("subagent E2E", () => {
	let api: SubagentAPI;
	let events: ReturnType<typeof createRecordingEvents>;
	let taskUpdates: Array<{ taskId: string; updates: Record<string, unknown> }>;

	beforeEach(() => {
		events = createRecordingEvents();
		taskUpdates = [];
		mkdirSync(TEST_CWD, { recursive: true });

		// Create test agent profile
		const piDir = join(TEST_CWD, ".pi", "agents");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "test-reviewer.md"),
			"---\nmodel: fast\ntools: [read, bash]\n---\nYou are a test reviewer. Be very concise. Reply with exactly what is asked.",
		);

		api = new SubagentAPI(TEST_CWD, events, {
			maxConcurrency: 3,
			timeoutMs: 120_000,
			onTaskUpdate(taskId, updates) {
				taskUpdates.push({ taskId, updates });
			},
		});
		api.registerEventHandlers();
	});

	afterEach(() => {
		api.killAll("test-cleanup");
		try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
		const sessionDir = join(homedir(), ".pi", "subagent-sessions");
		try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* */ }
	});

	// ── Scenario 1: spawn returns immediately, collect waits ──

	it("scenario 1: spawn → returns fast → collect waits → result on disk", async () => {
		const spawnStart = Date.now();
		const receipt = await api.spawn({
			name: "e2e-basic",
			cwd: TEST_CWD,
			model: "fast",
			prompt: "Reply with exactly: e2e-test-ok",
		});
		const spawnDuration = Date.now() - spawnStart;

		// spawn should return quickly (< 10s — the agent hasn't finished yet)
		expect(spawnDuration).toBeLessThan(10_000);
		expect(receipt.agentName).toBe("e2e-basic");
		expect(receipt.message).toContain("spawned");

		// spawned event fired
		const spawned = events.recorded.find((e) => e.event === "subagent:spawned");
		expect(spawned).toBeDefined();
		expect((spawned!.data as any).name).toBe("e2e-basic");

		// collect should wait for completion
		const result = await api.collect("e2e-basic");

		expect(result.status).toBe("done");
		expect(result.turns).toBeGreaterThanOrEqual(1);
		expect(result.duration).toBeGreaterThan(0);

		// Result file on disk
		expect(result.resultFile).toBeTruthy();
		expect(existsSync(result.resultFile!)).toBe(true);

		const saved = JSON.parse(readFileSync(result.resultFile!, "utf8"));
		expect(saved.agentName).toBe("e2e-basic");

		// completed event fired
		const completed = events.recorded.find((e) => e.event === "subagent:completed");
		expect(completed).toBeDefined();
		expect((completed!.data as any).status).toBe("done");
	}, 90_000);

	// ── Scenario 2: Task binding with auto-assignment ──

	it("scenario 2: spawn with task → auto-assigns owner + auto-completes + auto-cleans up", async () => {
		const TASK_ID = "e2e-task-auto-123";

		await api.spawn({
			name: "e2e-tasked",
			cwd: TEST_CWD,
			model: "fast",
			prompt: "Reply with exactly: tasked-ok",
			task: TASK_ID,
		});

		// Auto-assignment: task should have been updated immediately
		expect(taskUpdates.length).toBeGreaterThanOrEqual(1);
		const assignUpdate = taskUpdates.find((u) => u.taskId === TASK_ID);
		expect(assignUpdate).toBeDefined();
		expect(assignUpdate!.updates.owner).toBe("agent:e2e-tasked");
		expect(assignUpdate!.updates.status).toBe("in_progress");

		const result = await api.collect("e2e-tasked");

		expect(result.taskId).toBe(TASK_ID);

		// Auto-completion: task should be marked completed
		const completeUpdate = taskUpdates.find(
			(u) => u.taskId === TASK_ID && u.updates.status === "completed",
		);
		expect(completeUpdate).toBeDefined();
		expect(completeUpdate!.updates.metadata).toHaveProperty("subagentResult");

		// Auto-cleanup: agent should be gone from pool after collect
		const statusAfter = api.status();
		expect(statusAfter.find((s) => s.name === "e2e-tasked")).toBeUndefined();

		const completed = events.recorded.find((e) => e.event === "subagent:completed");
		expect((completed!.data as any).task).toBe(TASK_ID);
	}, 90_000);

	// ── Scenario 3: Profile resolution ──

	it("scenario 3: spawn with profile → correct profile used", async () => {
		await api.spawn({
			name: "e2e-profile",
			cwd: TEST_CWD,
			profile: "test-reviewer",
			prompt: "Reply with exactly one word: ok",
		});

		const result = await api.collect("e2e-profile");
		expect(result.status).toBe("done");

		const spawned = events.recorded.find((e) => e.event === "subagent:spawned");
		expect((spawned!.data as any).profile).toBe("test-reviewer");
	}, 90_000);

	// ── Scenario 4: Event bus ──

	it("scenario 4: event bus kill works", async () => {
		await api.spawn({
			name: "e2e-event-bus",
			cwd: TEST_CWD,
			model: "fast",
		});

		events.emit("subagent:kill", { name: "e2e-event-bus", reason: "test" });

		const killed = events.recorded.find(
			(e) => e.event === "subagent:killed" && (e.data as any).name === "e2e-event-bus",
		);
		expect(killed).toBeDefined();
	});

	// ── Scenario 5: Status while running ──

	it("scenario 5: status shows running agents in real-time", async () => {
		await api.spawn({
			name: "e2e-status",
			cwd: TEST_CWD,
			model: "fast",
			prompt: "Reply: status-ok",
		});

		// Check status immediately — agent should be in the pool
		const reports = api.status();
		expect(reports.length).toBeGreaterThanOrEqual(1);
		const agent = reports.find((r) => r.name === "e2e-status");
		expect(agent).toBeDefined();
		expect(agent!.model).toContain("glm");

		// Now collect to clean up
		await api.collect("e2e-status");
	}, 90_000);

	// ── Scenario 6: List profiles ──

	it("scenario 6: listProfiles discovers repo agents", () => {
		const profiles = api.listProfiles();
		const names = profiles.map((p) => p.name);
		expect(names).toContain("test-reviewer");
	});

	// ── Scenario 7: Fanout ──

	it("scenario 7: fanout spawns in parallel and waits for all", async () => {
		const results = await api.fanout({
			items: [
				{ prompt: "Reply exactly: fanout-1" },
				{ prompt: "Reply exactly: fanout-2" },
				{ prompt: "Reply exactly: fanout-3" },
			],
			cwd: TEST_CWD,
			model: "fast",
			concurrency: 3,
		});

		expect(results.length).toBe(3);
		expect(results.every((r) => r.status === "done")).toBe(true);

		// Multiple completion events
		const completions = events.recorded.filter((e) => e.event === "subagent:completed");
		expect(completions.length).toBeGreaterThanOrEqual(3);
	}, 180_000);

	// ── Scenario 8: collect auto-cleans up and result persists on disk ──

	it("scenario 8: collect auto-cleans up and result persists on disk", async () => {
		await api.spawn({
			name: "e2e-disk-read",
			cwd: TEST_CWD,
			model: "fast",
			prompt: "Reply: disk-read-ok",
		});

		// Wait for completion
		const result = await api.collect("e2e-disk-read");
		expect(result.status).toBe("done");
		expect(result.resultFile).toBeTruthy();

		// Agent auto-cleaned from pool
		expect(api.status().find((s) => s.name === "e2e-disk-read")).toBeUndefined();

		// Now collect should read from disk (agent is gone)
		const diskResult = await api.collect("e2e-disk-read");
		expect(diskResult.agentName).toBe("e2e-disk-read");
		expect(diskResult.output).toBeTruthy();
	}, 90_000);
});
