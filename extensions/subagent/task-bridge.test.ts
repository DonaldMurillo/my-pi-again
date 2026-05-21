import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	renderAgentSubItem,
	registerTaskAutoUpdate,
	readResult,
	type TaskInfo,
	type AgentStatusReport,
	type TaskBridgeCallbacks,
} from "./task-bridge.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Mock theme ──────────────────────────────────────────────────────

const mockTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	bg: (_color: string, text: string) => text,
} as any;

// ─── Tests ───────────────────────────────────────────────────────────

describe("task-bridge", () => {
	describe("renderAgentSubItem", () => {
		it("renders working agent sub-item", () => {
			const task: TaskInfo = {
				id: "abc123",
				subject: "Fix bug",
				status: "in_progress",
				priority: "high",
				owner: "agent:fixer",
			};

			const agents: AgentStatusReport[] = [{
				name: "fixer",
				model: "zai/glm-4.5-air",
				state: "working",
				pid: 12345,
				turns: 3,
				cost: 0.0023,
				duration: 15000,
			}];

			const result = renderAgentSubItem(task, agents, mockTheme);
			expect(result).toBeTruthy();
			expect(result).toContain("agent:fixer");
			expect(result).toContain("working");
			expect(result).toContain("glm-4.5-air");
			expect(result).toContain("turn 3");
			expect(result).toContain("$0.0023");
			expect(result).toContain("15s");
		});

		it("renders idle agent", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Review",
				status: "in_progress",
				priority: "medium",
				owner: "agent:reviewer",
			};

			const agents: AgentStatusReport[] = [{
				name: "reviewer",
				model: "zai/glm-5-turbo",
				state: "idle",
				turns: 0,
				cost: 0,
				duration: 2000,
			}];

			const result = renderAgentSubItem(task, agents, mockTheme);
			expect(result).toContain("agent:reviewer");
			expect(result).toContain("idle");
		});

		it("renders done agent", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Review",
				status: "completed",
				priority: "medium",
				owner: "agent:reviewer",
			};

			const agents: AgentStatusReport[] = [{
				name: "reviewer",
				model: "zai/glm-5-turbo",
				state: "done",
				turns: 5,
				cost: 0.01,
				duration: 120000,
			}];

			const result = renderAgentSubItem(task, agents, mockTheme);
			expect(result).toContain("done");
			expect(result).toContain("2m 0s");
		});

		it("renders failed agent with error", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Fix",
				status: "in_progress",
				priority: "high",
				owner: "agent:fixer",
			};

			const agents: AgentStatusReport[] = [{
				name: "fixer",
				model: "zai/glm-4.5-air",
				state: "failed",
				turns: 2,
				cost: 0.001,
				duration: 30000,
				error: "Process exited",
			}];

			const result = renderAgentSubItem(task, agents, mockTheme);
			expect(result).toContain("failed");
			expect(result).toContain("Process exited");
		});

		it("renders offline agent when no matching agent found", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Fix",
				status: "in_progress",
				priority: "high",
				owner: "agent:dead-agent",
			};

			const result = renderAgentSubItem(task, [], mockTheme);
			expect(result).toContain("offline");
		});

		it("returns null for non-agent owner", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Fix",
				status: "pending",
				priority: "high",
				owner: "main",
			};

			expect(renderAgentSubItem(task, [], mockTheme)).toBeNull();
		});

		it("returns null for no owner", () => {
			const task: TaskInfo = {
				id: "abc",
				subject: "Fix",
				status: "pending",
				priority: "high",
			};

			expect(renderAgentSubItem(task, [], mockTheme)).toBeNull();
		});
	});

	describe("registerTaskAutoUpdate", () => {
		it("updates task on agent completion", () => {
			const updatedTasks: Array<{ id: string; updates: Record<string, unknown> }> = [];
			const tasks = new Map<string, TaskInfo & { metadata?: Record<string, unknown> }>();
			tasks.set("task-1", {
				id: "task-1",
				subject: "Fix bug",
				status: "in_progress",
				priority: "high",
				owner: "agent:fixer",
				metadata: {},
			});

			const callbacks: TaskBridgeCallbacks = {
				updateTask(id, updates) {
					updatedTasks.push({ id, updates });
				},
				loadTask(id) {
					return tasks.get(id) ?? null;
				},
			};

			// Mock events
			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const mockEvents = {
				emit(event: string, data: unknown) {},
				on(event: string, handler: (data: unknown) => void) {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event)!.push(handler);
					return () => {};
				},
			};

			registerTaskAutoUpdate(mockEvents, callbacks);

			// Simulate completion event
			const completionHandlers = handlers.get("subagent:completed") ?? [];
			expect(completionHandlers.length).toBe(1);

			completionHandlers[0]({
				name: "fixer",
				task: "task-1",
				status: "done",
				output: "Fixed the bug",
				turns: 3,
				cost: 0.002,
				resultFile: "/tmp/result.json",
			});

			// Task should be updated
			expect(updatedTasks).toHaveLength(1);
			expect(updatedTasks[0].id).toBe("task-1");
			expect(updatedTasks[0].updates.status).toBe("completed");
			expect((updatedTasks[0].updates.metadata as any).subagentResult).toBe("/tmp/result.json");
		});

		it("sets task to blocked on agent failure", () => {
			const updatedTasks: Array<{ id: string; updates: Record<string, unknown> }> = [];
			const tasks = new Map<string, TaskInfo & { metadata?: Record<string, unknown> }>();
			tasks.set("task-2", {
				id: "task-2",
				subject: "Fix bug",
				status: "in_progress",
				priority: "high",
				owner: "agent:fixer",
				metadata: {},
			});

			const callbacks: TaskBridgeCallbacks = {
				updateTask(id, updates) {
					updatedTasks.push({ id, updates });
				},
				loadTask(id) {
					return tasks.get(id) ?? null;
				},
			};

			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const mockEvents = {
				emit() {},
				on(event: string, handler: (data: unknown) => void) {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event)!.push(handler);
					return () => {};
				},
			};

			registerTaskAutoUpdate(mockEvents, callbacks);

			const completionHandlers = handlers.get("subagent:completed") ?? [];
			completionHandlers[0]({
				name: "fixer",
				task: "task-2",
				status: "failed",
				error: "Process crashed",
			});

			expect(updatedTasks).toHaveLength(1);
			expect(updatedTasks[0].updates.status).toBe("blocked");
		});

		it("ignores events without task ID", () => {
			const updatedTasks: Array<{ id: string; updates: Record<string, unknown> }> = [];
			const callbacks: TaskBridgeCallbacks = {
				updateTask(id, updates) {
					updatedTasks.push({ id, updates });
				},
				loadTask() { return null; },
			};

			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const mockEvents = {
				emit() {},
				on(event: string, handler: (data: unknown) => void) {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event)!.push(handler);
					return () => {};
				},
			};

			registerTaskAutoUpdate(mockEvents, callbacks);

			const completionHandlers = handlers.get("subagent:completed") ?? [];
			completionHandlers[0]({ name: "no-task", status: "done" });

			expect(updatedTasks).toHaveLength(0);
		});

		it("ignores tasks owned by different agent", () => {
			const updatedTasks: Array<{ id: string; updates: Record<string, unknown> }> = [];
			const tasks = new Map<string, TaskInfo & { metadata?: Record<string, unknown> }>();
			tasks.set("task-3", {
				id: "task-3",
				subject: "Fix",
				status: "in_progress",
				priority: "high",
				owner: "agent:other-agent",  // different agent
				metadata: {},
			});

			const callbacks: TaskBridgeCallbacks = {
				updateTask(id, updates) {
					updatedTasks.push({ id, updates });
				},
				loadTask(id) {
					return tasks.get(id) ?? null;
				},
			};

			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const mockEvents = {
				emit() {},
				on(event: string, handler: (data: unknown) => void) {
					if (!handlers.has(event)) handlers.set(event, []);
					handlers.get(event)!.push(handler);
					return () => {};
				},
			};

			registerTaskAutoUpdate(mockEvents, callbacks);

			const completionHandlers = handlers.get("subagent:completed") ?? [];
			completionHandlers[0]({
				name: "fixer",  // different from "other-agent"
				task: "task-3",
				status: "done",
			});

			expect(updatedTasks).toHaveLength(0);
		});
	});

	describe("readResult", () => {
		const TEST_DIR = join(homedir(), ".pi-test-task-bridge");

		beforeEach(() => {
			const resultsDir = join(TEST_DIR, ".pi", "agents", "results");
			mkdirSync(resultsDir, { recursive: true });
			writeFileSync(
				join(resultsDir, "test-agent.json"),
				JSON.stringify({
					agentName: "test-agent",
					status: "done",
					output: "Task completed",
					turns: 3,
					cost: 0.005,
					duration: 10000,
				}),
			);
		});

		afterEach(() => {
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("reads result file from disk", () => {
			const result = readResult(TEST_DIR, "test-agent");
			expect(result).not.toBeNull();
			expect(result!.agentName).toBe("test-agent");
			expect(result!.status).toBe("done");
			expect(result!.turns).toBe(3);
			expect(result!.cost).toBe(0.005);
		});

		it("returns null for missing result", () => {
			const result = readResult(TEST_DIR, "nonexistent");
			expect(result).toBeNull();
		});
	});
});
