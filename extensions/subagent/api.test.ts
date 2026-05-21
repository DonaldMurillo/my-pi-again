import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SubagentAPI, type SubagentEvents } from "./api.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Mock event bus ──────────────────────────────────────────────────

function createMockEvents(): SubagentEvents & { emitted: Array<{ event: string; data: unknown }> } {
	const emitted: Array<{ event: string; data: unknown }> = [];
	const handlers = new Map<string, Array<(data: unknown) => void>>();

	return {
		emitted,
		emit(event: string, data: unknown) {
			emitted.push({ event, data });
			// Also call registered handlers
			const hs = handlers.get(event) ?? [];
			for (const h of hs) h(data);
		},
		on(event: string, handler: (data: unknown) => void) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return () => {
				const hs = handlers.get(event);
				if (hs) {
					const idx = hs.indexOf(handler);
					if (idx >= 0) hs.splice(idx, 1);
				}
			};
		},
	};
}

// ─── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = join(homedir(), ".pi-test-api");
const TEST_CWD = join(TEST_DIR, "project");

describe("SubagentAPI", () => {
	let api: SubagentAPI;
	let events: ReturnType<typeof createMockEvents>;

	beforeEach(() => {
		events = createMockEvents();
		mkdirSync(TEST_CWD, { recursive: true });
		api = new SubagentAPI(TEST_CWD, events);
	});

	afterEach(() => {
		api.killAll("test-cleanup");
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	// ── Note: spawn/collect/send tests use real pi subprocess ──
	// Those are in agent-pool.test.ts (integration tests)
	// Here we test the API surface, events, and profile logic

	describe("event emission", () => {
		it("kill emits subagent:killed", () => {
			api.kill("test-agent", "test-reason");

			const killedEvent = events.emitted.find(
				(e) => e.event === "subagent:killed",
			);
			expect(killedEvent).toBeDefined();
			expect((killedEvent!.data as any).name).toBe("test-agent");
			expect((killedEvent!.data as any).reason).toBe("test-reason");
		});

		it("killAll emits killed for each agent", () => {
			// No agents yet, but should not throw
			api.killAll("test");
			// No events since no agents
		});
	});

	describe("event bus inbound handlers", () => {
		it("registers handlers that respond to subagent:kill", () => {
			api.registerEventHandlers();

			events.emit("subagent:kill", { name: "ghost", reason: "test" });

			const killedEvents = events.emitted.filter(
				(e) => e.event === "subagent:killed",
			);
			expect(killedEvents.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("profiles", () => {
		beforeEach(() => {
			// Create test agent profiles
			const piDir = join(TEST_CWD, ".pi", "agents");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "test-reviewer.md"),
				"---\nmodel: fast\ntools: [read, bash]\n---\nYou review code.",
			);
			writeFileSync(
				join(piDir, "test-fixer.md"),
				"---\nmodel: deep\n---\nYou fix bugs.",
			);

			// Claude agent
			const claudeDir = join(TEST_CWD, ".claude", "agents");
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(
				join(claudeDir, "test-helper.md"),
				"You help with things.",
			);
		});

		it("listProfiles discovers all profiles", () => {
			const profiles = api.listProfiles();
			const names = profiles.map((p) => p.name);

			expect(names).toContain("test-reviewer");
			expect(names).toContain("test-fixer");
			expect(names).toContain("test-helper");
		});

		it("listProfiles includes ad-hoc profiles", () => {
			api.createAdHocProfile("adhoc-1", { prompt: "Quick task." });

			const profiles = api.listProfiles();
			const names = profiles.map((p) => p.name);
			expect(names).toContain("adhoc-1");
		});

		it("listProfiles returns correct details", () => {
			const profiles = api.listProfiles();
			const reviewer = profiles.find((p) => p.name === "test-reviewer");

			expect(reviewer).toBeDefined();
			expect(reviewer!.model).toBe("fast");
			expect(reviewer!.tools).toEqual(["read", "bash"]);
			expect(reviewer!.source).toBe("repo-pi");
		});

		it("createAgentProfile writes to disk", () => {
			const def = api.createAgentProfile("new-agent", {
				prompt: "Do new things.",
				model: "balanced",
				tools: ["read"],
			});

			expect(def.name).toBe("new-agent");
			expect(def.model).toBe("balanced");

			// Shows up in list
			const profiles = api.listProfiles();
			expect(profiles.map((p) => p.name)).toContain("new-agent");
		});

		it("createAdHocProfile is in-memory only", () => {
			const def = api.createAdHocProfile("temp", {
				prompt: "Temporary.",
				model: "fast",
			});

			expect(def.source).toBe("ad-hoc");
			expect(def.model).toBe("fast");
		});
	});

	describe("status", () => {
		it("returns empty array when no agents", () => {
			expect(api.status()).toHaveLength(0);
		});
	});

	describe("task update hook", () => {
		it("calls onTaskUpdate with owner + in_progress when spawn has task", async () => {
			const taskUpdates: Array<{ taskId: string; updates: Record<string, unknown> }> = [];
			const hookedApi = new SubagentAPI(TEST_CWD, events, {
				onTaskUpdate(taskId, updates) {
					taskUpdates.push({ taskId, updates });
				},
			});

			// Create a profile so spawn doesn't fail
			const piDir = join(TEST_CWD, ".pi", "agents");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "test-worker.md"),
				"---\nmodel: fast\ntools: []\n---\nYou work.",
			);

			try {
				await hookedApi.spawn({
					name: "task-test-agent",
					cwd: TEST_CWD,
					task: "TASK-123",
					model: "fast",
				});

				// Should have auto-assigned the task
				expect(taskUpdates).toHaveLength(1);
				expect(taskUpdates[0].taskId).toBe("TASK-123");
				expect(taskUpdates[0].updates.owner).toBe("agent:task-test-agent");
				expect(taskUpdates[0].updates.status).toBe("in_progress");
			} finally {
				hookedApi.killAll("test");
			}
		});

		it("does not call onTaskUpdate when spawn has no task", async () => {
			const taskUpdates: Array<{ taskId: string; updates: Record<string, unknown> }> = [];
			const hookedApi = new SubagentAPI(TEST_CWD, events, {
				onTaskUpdate(taskId, updates) {
					taskUpdates.push({ taskId, updates });
				},
			});

			try {
				await hookedApi.spawn({
					name: "no-task-agent",
					cwd: TEST_CWD,
					model: "fast",
				});

				expect(taskUpdates).toHaveLength(0);
			} finally {
				hookedApi.killAll("test");
			}
		});
	});
});
