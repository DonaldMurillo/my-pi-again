/**
 * Tasks extension — LIVE agent session tests.
 *
 * These tests start a real `pi --mode rpc` subprocess, send real prompts
 * that trigger real tool calls, and verify the extensions actually work.
 *
 * Run: npx vitest run tests/tasks.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
} from "node:fs";

// ─── Test workspace ──────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), ".tmp", "tasks-test-workspace");

// ─── RPC helpers ─────────────────────────────────────────────────────

interface JsonLine {
	[key: string]: unknown;
	type: string;
}

class RpcClient {
	private proc: ChildProcess;
	private buffer = "";
	private pending: Array<{
		resolve: (line: JsonLine) => void;
		predicate: (line: JsonLine) => boolean;
	}> = [];
	private lines: JsonLine[] = [];

	constructor(cwd: string) {
		this.proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.stdout!.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			this.drain();
		});
	}

	private drain() {
		while (true) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;

			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);

			if (!line.trim()) continue;

			try {
				const obj = JSON.parse(line);
				this.lines.push(obj);

				// Check pending waiters
				for (let i = this.pending.length - 1; i >= 0; i--) {
					if (this.pending[i].predicate(obj)) {
						this.pending[i].resolve(obj);
						this.pending.splice(i, 1);
					}
				}
			} catch {
				// Ignore non-JSON lines
			}
		}
	}

	send(cmd: Record<string, unknown>): Promise<JsonLine> {
		const json = JSON.stringify(cmd) + "\n";
		this.proc.stdin!.write(json);
		return this.waitFor(
			(line) =>
				line.type === "response" && line.command === cmd.type,
			30_000,
		);
	}

	prompt(message: string): Promise<JsonLine> {
		return this.send({ type: "prompt", message });
	}

	waitFor(predicate: (line: JsonLine) => boolean, timeoutMs = 30_000): Promise<JsonLine> {
		// Check existing lines first
		const existing = this.lines.find(predicate);
		if (existing) {
			this.lines = this.lines.filter((l) => l !== existing);
			return Promise.resolve(existing);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timeout waiting for event")),
				timeoutMs,
			);

			this.pending.push({
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
				predicate,
			});
		});
	}

	/** Wait for agent to finish processing (agent_end event). */
	waitForAgentEnd(timeoutMs = 60_000): Promise<JsonLine> {
		return this.waitFor((l) => l.type === "agent_end", timeoutMs);
	}

	/** Wait for a specific tool to be called. */
	waitForToolCall(toolName: string, timeoutMs = 30_000): Promise<JsonLine> {
		return this.waitFor(
			(l) => l.type === "tool_execution_start" && l.toolName === toolName,
			timeoutMs,
		);
	}

	/** Collect all events until agent_end, then return them. */
	async runPrompt(message: string, timeoutMs = 60_000): Promise<JsonLine[]> {
		const events: JsonLine[] = [];

		// Don't use a permanent collector — just wait for agent_end
		await this.prompt(message);

		// Poll for agent_end, collecting all events
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			// Check if we got agent_end
			const endIdx = this.lines.findIndex((l) => l.type === "agent_end");
			if (endIdx >= 0) {
				// Return everything up to and including agent_end
				const result = this.lines.splice(0, endIdx + 1);
				return result;
			}
			// Wait a bit and check again
			await new Promise((r) => setTimeout(r, 200));
		}

		// Return whatever we have
		return this.lines.splice(0);
	}

	kill() {
		this.proc.kill();
	}
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("tasks extension — live agent tests", { timeout: 120_000 }, () => {
	let client: RpcClient;

	beforeAll(() => {
		// Create test workspace
		mkdirSync(TEST_DIR, { recursive: true });
		writeFileSync(join(TEST_DIR, "package.json"), '{"name":"test-project"}');

		// Ensure extensions are synced
		client = new RpcClient(TEST_DIR);
	});

	afterAll(() => {
		client?.kill();
		// Clean up test workspace
		try {
			rmSync(TEST_DIR, { recursive: true, force: true });
		} catch { /* ignore */ }
	});

	it("should create a task via TaskCreate tool", async () => {
		const events = await client.runPrompt(
			"Create a task with TaskCreate: subject='Write tests', priority='high', labels=['testing', 'backend']",
		);

		// Debug: log event types
		const types = events.map((e) => e.type);
		console.log("Event types:", types);

		// Check if agent errored or used different tools
		const toolStarts = events.filter((e) => e.type === "tool_execution_start");
		console.log("Tool calls:", toolStarts.map((e) => (e as any).toolName));

		// Should have called TaskCreate
		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && (e as any).toolName === "TaskCreate",
		);
		expect(toolStart).toBeDefined();
		expect(toolStart!.toolName).toBe("TaskCreate");

		// Verify the tasks file was written to disk
		const tasksFile = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		expect(existsSync(tasksFile)).toBe(true);

		const store = JSON.parse(readFileSync(tasksFile, "utf8"));
		const tasks = Object.values(store.tasks) as any[];
		expect(tasks.length).toBeGreaterThanOrEqual(1);

		const task = tasks.find((t) => t.subject === "Write tests");
		expect(task).toBeDefined();
		expect(task!.priority).toBe("high");
		expect(task!.labels).toContain("testing");
		expect(task!.labels).toContain("backend");
		expect(task!.status).toBe("pending");

		// Verify auto-gitignore was created
		expect(existsSync(join(TEST_DIR, ".pi", "tasks", ".gitignore"))).toBe(true);
		expect(readFileSync(join(TEST_DIR, ".pi", "tasks", ".gitignore"), "utf8").trim()).toBe("*");
	});

	it("should update a task via TaskUpdate tool", async () => {
		// First get the task ID from the file
		const tasksFile = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		const store = JSON.parse(readFileSync(tasksFile, "utf8"));
		const taskId = Object.keys(store.tasks)[0];

		const events = await client.runPrompt(
			`Use TaskUpdate to set task ${taskId} to status "in_progress"`,
		);

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TaskUpdate",
		);
		expect(toolStart).toBeDefined();

		// Verify on disk
		const updated = JSON.parse(readFileSync(tasksFile, "utf8"));
		expect(updated.tasks[taskId].status).toBe("in_progress");
		expect(updated.tasks[taskId].startedAt).toBeDefined();
	});

	it("should list tasks via TaskList tool", async () => {
		const events = await client.runPrompt(
			"Use TaskList to show all tasks with status in_progress or pending",
		);

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TaskList",
		);
		expect(toolStart).toBeDefined();
	});

	it("should replace tasks via TodoWrite tool", async () => {
		const events = await client.runPrompt(
			"Use TodoWrite to set todos: [{content: 'Build feature', status: 'in_progress', activeForm: 'Building feature'}, {content: 'Deploy', status: 'pending'}]",
		);

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TodoWrite",
		);
		expect(toolStart).toBeDefined();

		// Verify on disk
		const tasksFile = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		const store = JSON.parse(readFileSync(tasksFile, "utf8"));
		const tasks = Object.values(store.tasks) as any[];

		// "Write tests" from earlier should now be completed (absent from TodoWrite)
		const writeTests = tasks.find((t) => t.subject === "Write tests");
		expect(writeTests!.status).toBe("completed");

		// New tasks should exist
		const buildFeature = tasks.find((t) => t.subject === "Build feature");
		expect(buildFeature).toBeDefined();
		expect(buildFeature!.status).toBe("in_progress");

		const deploy = tasks.find((t) => t.subject === "Deploy");
		expect(deploy).toBeDefined();
		expect(deploy!.status).toBe("pending");
	});

	it("should find next task via TaskNext tool", async () => {
		const events = await client.runPrompt("Use TaskNext to get the next actionable task");

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TaskNext",
		);
		expect(toolStart).toBeDefined();
	});

	it("should complete a task and auto-unblock dependents", async () => {
		// Step 1: Create Task A
		await client.runPrompt(
			"Use TaskCreate to create a task with subject 'Blocker Task'. Return only the task ID.",
		);

		// Get Task A's ID
		const tasksFile = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		const store1 = JSON.parse(readFileSync(tasksFile, "utf8"));
		const taskA = Object.values(store1.tasks).find((t: any) => t.subject === "Blocker Task") as any;
		expect(taskA).toBeDefined();

		// Step 2: Create Task B blocked by Task A
		await client.runPrompt(
			`Use TaskCreate to create a task with subject 'Dependent Task', blockedBy: ['${taskA.id}']. Return only the task ID.`,
		);

		const store2 = JSON.parse(readFileSync(tasksFile, "utf8"));
		const taskB = Object.values(store2.tasks).find((t: any) => t.subject === "Dependent Task") as any;
		expect(taskB).toBeDefined();
		expect(taskB.status).toBe("blocked");

		// Step 3: Complete Task A — should auto-unblock Task B
		await client.runPrompt(
			`Use TaskUpdate to set task ${taskA.id} to status "completed"`,
		);

		// Verify Task B is now auto-unblocked
		const store3 = JSON.parse(readFileSync(tasksFile, "utf8"));
		const taskB2 = store3.tasks[taskB.id];
		expect(taskB2.status).toBe("pending"); // auto-unblocked!
	});

	it("should search tasks via TaskSearch tool", async () => {
		const events = await client.runPrompt(
			"Use TaskSearch to search for tasks matching 'feature'",
		);

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TaskSearch",
		);
		expect(toolStart).toBeDefined();
	});

	it("should archive completed tasks via TaskArchive tool", async () => {
		const events = await client.runPrompt(
			"Use TaskArchive to archive all completed tasks",
		);

		const toolStart = events.find(
			(e) => e.type === "tool_execution_start" && e.toolName === "TaskArchive",
		);
		expect(toolStart).toBeDefined();

		// Verify archive file was created
		const archiveDir = join(TEST_DIR, ".pi", "tasks", "archive");
		expect(existsSync(archiveDir)).toBe(true);

		// Verify active tasks no longer include completed ones
		const tasksFile = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		const store = JSON.parse(readFileSync(tasksFile, "utf8"));
		const completed = Object.values(store.tasks).filter((t: any) => t.status === "completed");
		expect(completed.length).toBe(0);
	});
});
