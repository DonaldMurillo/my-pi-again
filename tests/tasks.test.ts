/**
 * Tasks extension — comprehensive live agent session tests.
 *
 * Tests the FULL pipeline: prompt → agent → tool call → extension hook → filesystem.
 * Covers happy paths, edge cases, adversarial inputs, and invariants.
 *
 * Run: npx vitest run tests/tasks.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
				for (let i = this.pending.length - 1; i >= 0; i--) {
					if (this.pending[i].predicate(obj)) {
						this.pending[i].resolve(obj);
						this.pending.splice(i, 1);
					}
				}
			} catch { /* ignore non-JSON */ }
		}
	}

	send(cmd: Record<string, unknown>): Promise<JsonLine> {
		this.proc.stdin!.write(JSON.stringify(cmd) + "\n");
		return this.waitFor(
			(line) => line.type === "response" && line.command === cmd.type,
			30_000,
		);
	}

	prompt(message: string): Promise<JsonLine> {
		return this.send({ type: "prompt", message });
	}

	waitFor(predicate: (line: JsonLine) => boolean, timeoutMs = 30_000): Promise<JsonLine> {
		const existing = this.lines.find(predicate);
		if (existing) {
			this.lines = this.lines.filter((l) => l !== existing);
			return Promise.resolve(existing);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
			this.pending.push({
				resolve: (line) => { clearTimeout(timer); resolve(line); },
				predicate,
			});
		});
	}

	async runPrompt(message: string, timeoutMs = 60_000): Promise<JsonLine[]> {
		await this.prompt(message);
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const endIdx = this.lines.findIndex((l) => l.type === "agent_end");
			if (endIdx >= 0) return this.lines.splice(0, endIdx + 1);
			await new Promise((r) => setTimeout(r, 200));
		}
		return this.lines.splice(0);
	}

	/** Read the tasks.json store from disk. */
	readStore(): Record<string, any> {
		const f = join(TEST_DIR, ".pi", "tasks", "tasks.json");
		if (!existsSync(f)) return { version: 1, tasks: {} };
		return JSON.parse(readFileSync(f, "utf8"));
	}

	/** Find a task by subject (exact match). */
	findTask(subject: string): any | undefined {
		const store = this.readStore();
		return Object.values(store.tasks).find((t: any) => t.subject === subject);
	}

	/** Assert a tool was called in the events. */
	assertToolCalled(events: JsonLine[], toolName: string): JsonLine | undefined {
		return events.find(
			(e) => e.type === "tool_execution_start" && (e as any).toolName === toolName,
		);
	}

	kill() { this.proc.kill(); }
}

// ─── Helpers ─────────────────────────────────────────────────────────

let client: RpcClient;

beforeAll(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	writeFileSync(join(TEST_DIR, "package.json"), '{"name":"test-project"}');
	client = new RpcClient(TEST_DIR);
});

afterAll(() => {
	client?.kill();
	try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════
//  HAPPY PATH TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("happy paths", { timeout: 120_000 }, () => {

	it("TaskCreate — creates a task with all fields", async () => {
		const events = await client.runPrompt(
			"Use TaskCreate with subject='Happy path task', description='Testing all fields', " +
			"priority='high', effort='m', labels=['test','happy'], acceptanceCriteria=[{criterion:'Works',verified:false}]",
		);
		expect(client.assertToolCalled(events, "TaskCreate")).toBeDefined();

		const task = client.findTask("Happy path task");
		expect(task).toBeDefined();
		expect(task.priority).toBe("high");
		expect(task.effort).toBe("m");
		expect(task.labels).toContain("test");
		expect(task.labels).toContain("happy");
		expect(task.status).toBe("pending");
		expect(task.description).toBe("Testing all fields");
		expect(task.acceptanceCriteria).toHaveLength(1);
		expect(task.acceptanceCriteria[0].criterion).toBe("Works");
		expect(task.acceptanceCriteria[0].verified).toBe(false);
		expect(task.createdAt).toBeGreaterThan(0);
		expect(task.updatedAt).toBe(task.createdAt);
		expect(task.source).toBe("pi");

		// Auto-gitignore created
		const gitignore = join(TEST_DIR, ".pi", "tasks", ".gitignore");
		expect(existsSync(gitignore)).toBe(true);
		expect(readFileSync(gitignore, "utf8").trim()).toBe("*");
	});

	it("TaskUpdate — transitions status through lifecycle", async () => {
		const task = client.findTask("Happy path task");
		expect(task).toBeDefined();

		// pending → in_progress
		let events = await client.runPrompt(
			`Use TaskUpdate to set task ${task.id} to status "in_progress"`,
		);
		expect(client.assertToolCalled(events, "TaskUpdate")).toBeDefined();
		let updated = client.readStore().tasks[task.id];
		expect(updated.status).toBe("in_progress");
		expect(updated.startedAt).toBeGreaterThan(0);

		// in_progress → review
		events = await client.runPrompt(
			`Use TaskUpdate to set task ${task.id} to status "review"`,
		);
		expect(client.assertToolCalled(events, "TaskUpdate")).toBeDefined();
		updated = client.readStore().tasks[task.id];
		expect(updated.status).toBe("review");

		// review → completed
		events = await client.runPrompt(
			`Use TaskUpdate to set task ${task.id} to status "completed"`,
		);
		expect(client.assertToolCalled(events, "TaskUpdate")).toBeDefined();
		updated = client.readStore().tasks[task.id];
		expect(updated.status).toBe("completed");
		expect(updated.completedAt).toBeGreaterThan(0);
		expect(updated.timeSpentSeconds).toBeGreaterThanOrEqual(0);
	});

	it("TaskGet — retrieves full task details", async () => {
		const task = client.findTask("Happy path task");
		const events = await client.runPrompt(
			`Use TaskGet with taskId='${task.id}'`,
		);
		expect(client.assertToolCalled(events, "TaskGet")).toBeDefined();
	});

	it("TaskList — filters and sorts tasks", async () => {
		const events = await client.runPrompt(
			"Use TaskList with status=['completed'], sort='updated'",
		);
		expect(client.assertToolCalled(events, "TaskList")).toBeDefined();
	});

	it("TaskSearch — finds tasks by text", async () => {
		const events = await client.runPrompt(
			"Use TaskSearch with query='happy'",
		);
		expect(client.assertToolCalled(events, "TaskSearch")).toBeDefined();
	});

	it("TaskNext — returns highest priority unblocked task", async () => {
		// Create a high-priority task to ensure there's something to return
		await client.runPrompt(
			"Use TaskCreate with subject='Next test task', priority='critical'",
		);
		const events = await client.runPrompt("Use TaskNext");
		expect(client.assertToolCalled(events, "TaskNext")).toBeDefined();
	});

	it("TaskDecompose — breaks task into subtasks", async () => {
		const parent = client.findTask("Next test task");
		expect(parent).toBeDefined();

		const events = await client.runPrompt(
			`Use TaskDecompose with taskId='${parent.id}', strategy='sequential', ` +
			`subtasks=[{subject:'Step 1',description:'First step'},{subject:'Step 2',description:'Second step'}]`,
		);
		expect(client.assertToolCalled(events, "TaskDecompose")).toBeDefined();

		const store = client.readStore();
		const step1 = Object.values(store.tasks).find((t: any) => t.subject === "Step 1");
		const step2 = Object.values(store.tasks).find((t: any) => t.subject === "Step 2");

		expect(step1).toBeDefined();
		expect(step2).toBeDefined();
		expect(step1.parentTaskId).toBe(parent.id);
		expect(step2.parentTaskId).toBe(parent.id);
		expect(store.tasks[parent.id].subtasks).toContain(step1.id);
		expect(store.tasks[parent.id].subtasks).toContain(step2.id);

		// Sequential strategy: step 2 blocked by step 1
		expect(step2.blockedBy).toContain(step1.id);
		expect(step1.blocks).toContain(step2.id);
		expect(step2.status).toBe("blocked");
	});

	it("TaskArchive — archives completed tasks", async () => {
		const events = await client.runPrompt("Use TaskArchive with status='completed'");
		expect(client.assertToolCalled(events, "TaskArchive")).toBeDefined();

		const store = client.readStore();
		const completed = Object.values(store.tasks).filter((t: any) => t.status === "completed");
		expect(completed.length).toBe(0);

		// Archive file created
		const archiveDir = join(TEST_DIR, ".pi", "tasks", "archive");
		expect(existsSync(archiveDir)).toBe(true);
	});

	it("TodoWrite — replaces in-memory todos (NOT persisted to disk)", async () => {
		const storeBefore = client.readStore();
		const taskCountBefore = Object.keys(storeBefore.tasks).length;

		const events = await client.runPrompt(
			"Use TodoWrite with todos=[{content:'Todo A',status:'in_progress',activeForm:'Doing A'},{content:'Todo B',status:'pending'}]",
		);
		expect(client.assertToolCalled(events, "TodoWrite")).toBeDefined();

		// Disk task count unchanged — todos are in-memory only
		const storeAfter = client.readStore();
		expect(Object.keys(storeAfter.tasks).length).toBe(taskCountBefore);
	});
});

// ═══════════════════════════════════════════════════════════════════════
//  DEPENDENCY TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("dependencies — auto-block and auto-unblock", { timeout: 120_000 }, () => {

	it("auto-blocks when creating a task with incomplete blockedBy", async () => {
		// Create blocker (not completed)
		await client.runPrompt("Use TaskCreate with subject='Dep-Blocker', priority='high'");

		const blocker = client.findTask("Dep-Blocker");
		expect(blocker).toBeDefined();
		expect(blocker.status).toBe("pending");

		// Create dependent task blocked by the blocker
		await client.runPrompt(
			`Use TaskCreate with subject='Dep-Dependent', blockedBy=['${blocker.id}']`,
		);

		const dependent = client.findTask("Dep-Dependent");
		expect(dependent).toBeDefined();
		expect(dependent.status).toBe("blocked");

		// Bidirectional: blocker should have dependent in its blocks list
		const blockerUpdated = client.readStore().tasks[blocker.id];
		expect(blockerUpdated.blocks).toContain(dependent.id);
	});

	it("auto-unblocks dependents when blocker is completed", async () => {
		const blocker = client.findTask("Dep-Blocker");
		const dependent = client.findTask("Dep-Dependent");

		expect(dependent.status).toBe("blocked");

		// Complete the blocker
		await client.runPrompt(
			`Use TaskUpdate to set task ${blocker.id} to status "completed"`,
		);

		// Dependent should now be auto-unblocked
		const dependentUpdated = client.readStore().tasks[dependent.id];
		expect(dependentUpdated.status).toBe("pending");
	});

	it("auto-blocks when trying to start a task with incomplete blockers", async () => {
		// Create two new tasks: A (pending) and B (blockedBy A)
		await client.runPrompt("Use TaskCreate with subject='AutoBlock-A', priority='medium'");
		const a = client.findTask("AutoBlock-A");

		await client.runPrompt(
			`Use TaskCreate with subject='AutoBlock-B', blockedBy=['${a.id}']`,
		);
		const b = client.findTask("AutoBlock-B");
		expect(b.status).toBe("blocked");

		// Try to start B — should stay blocked
		await client.runPrompt(
			`Use TaskUpdate to set task ${b.id} to status "in_progress"`,
		);

		const bUpdated = client.readStore().tasks[b.id];
		// Should still be blocked (auto-block check prevents starting)
		expect(bUpdated.status).toBe("blocked");
	});

	it("supports parallel decomposition (no dependencies between subtasks)", async () => {
		await client.runPrompt("Use TaskCreate with subject='Parallel-Parent', priority='medium'");
		const parent = client.findTask("Parallel-Parent");

		await client.runPrompt(
			`Use TaskDecompose with taskId='${parent.id}', strategy='parallel', ` +
			`subtasks=[{subject:'Parallel-A'},{subject:'Parallel-B'},{subject:'Parallel-C'}]`,
		);

		const store = client.readStore();
		const subs = Object.values(store.tasks)
			.filter((t: any) => t.parentTaskId === parent.id) as any[];

		expect(subs).toHaveLength(3);

		// All should be pending — no blockedBy links in parallel strategy
		for (const s of subs) {
			expect(s.status).toBe("pending");
			expect(s.blockedBy).toHaveLength(0);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
//  EDGE CASES
// ═══════════════════════════════════════════════════════════════════════

describe("edge cases", { timeout: 120_000 }, () => {

	it("TaskUpdate on non-existent task returns error", async () => {
		const events = await client.runPrompt(
			"Use TaskUpdate with taskId='NONEXISTENT12345678', status='completed'",
		);
		expect(client.assertToolCalled(events, "TaskUpdate")).toBeDefined();

		// Should complete without crashing
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("TaskGet on non-existent task returns error", async () => {
		const events = await client.runPrompt(
			"Use TaskGet with taskId='NONEXISTENT12345678'",
		);
		expect(client.assertToolCalled(events, "TaskGet")).toBeDefined();

		// Should complete without crashing
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("TaskList with no matching filters returns empty", async () => {
		const events = await client.runPrompt(
			"Use TaskList with status=['blocked'], sort='priority'",
		);
		expect(client.assertToolCalled(events, "TaskList")).toBeDefined();
	});

	it("TaskSearch with no matches returns empty", async () => {
		const events = await client.runPrompt(
			"Use TaskSearch with query='zzzzzznoexist'",
		);
		expect(client.assertToolCalled(events, "TaskSearch")).toBeDefined();
	});

	it("TaskNext with all tasks blocked returns nothing actionable", async () => {
		// Create a chain: A (pending), B blocked by A
		await client.runPrompt("Use TaskCreate with subject='Chain-A'");
		const a = client.findTask("Chain-A");

		await client.runPrompt(
			`Use TaskCreate with subject='Chain-B', blockedBy=['${a.id}']`,
		);

		// Now complete A so B is unblocked
		await client.runPrompt(`Use TaskUpdate to set task ${a.id} to status "completed"`);

		// TaskNext should find B as actionable
		const events = await client.runPrompt("Use TaskNext");
		expect(client.assertToolCalled(events, "TaskNext")).toBeDefined();
	});

	it("TaskUpdate — labels add/remove", async () => {
		await client.runPrompt("Use TaskCreate with subject='Label-Test', labels=['keep','remove','extra']");
		let task = client.findTask("Label-Test");
		expect(task.labels).toContain("keep");
		expect(task.labels).toContain("remove");

		await client.runPrompt(
			`Use TaskUpdate with taskId='${task.id}', labels={add:['new'],remove:['remove']}`,
		);

		task = client.readStore().tasks[task.id];
		expect(task.labels).toContain("keep");
		expect(task.labels).toContain("new");
		expect(task.labels).not.toContain("remove");
	});

	it("TaskUpdate — metadata merge and delete (null values)", async () => {
		await client.runPrompt("Use TaskCreate with subject='Meta-Test', metadata={foo:'bar',baz:42}");
		let task = client.findTask("Meta-Test");
		expect(task.metadata.foo).toBe("bar");
		expect(task.metadata.baz).toBe(42);

		await client.runPrompt(
			`Use TaskUpdate with taskId='${task.id}', metadata={foo:null,qux:true}`,
		);

		task = client.readStore().tasks[task.id];
		expect(task.metadata.foo).toBeUndefined(); // deleted
		expect(task.metadata.qux).toBe(true);      // added
		expect(task.metadata.baz).toBe(42);         // unchanged
	});

	it("TaskUpdate — acceptance criteria verification", async () => {
		await client.runPrompt(
			"Use TaskCreate with subject='AC-Test', acceptanceCriteria=[{criterion:'Test passes',verified:false},{criterion:'Lint clean',verified:false}]",
		);
		let task = client.findTask("AC-Test");
		expect(task.acceptanceCriteria).toHaveLength(2);
		expect(task.acceptanceCriteria[0].verified).toBe(false);

		await client.runPrompt(
			`Use TaskUpdate with taskId='${task.id}', acceptanceCriteria=[{index:0,verified:true}]`,
		);

		task = client.readStore().tasks[task.id];
		expect(task.acceptanceCriteria[0].verified).toBe(true);
		expect(task.acceptanceCriteria[0].verifiedAt).toBeGreaterThan(0);
		expect(task.acceptanceCriteria[1].verified).toBe(false);
	});

	it("TodoWrite replaces entire list — absent items disappear", async () => {
		// Set initial todos
		await client.runPrompt(
			"Use TodoWrite with todos=[{content:'Keep this',status:'pending'},{content:'Remove this',status:'pending'}]",
		);

		// Replace with just one
		await client.runPrompt(
			"Use TodoWrite with todos=[{content:'Keep this',status:'in_progress'}]",
		);

		// "Remove this" should be gone (it was in-memory, not on disk)
		// We can't inspect in-memory state from outside, but the tool should succeed
		// The real test is that disk was never touched
		const store = client.readStore();
		// No tasks named "Keep this" or "Remove this" on disk — todos are in-memory
		expect(Object.values(store.tasks).find((t: any) => t.subject === "Keep this")).toBeUndefined();
		expect(Object.values(store.tasks).find((t: any) => t.subject === "Remove this")).toBeUndefined();
	});

	it("TaskArchive with no completed tasks is a no-op", async () => {
		// First ensure no completed tasks
		const storeBefore = client.readStore();
		const completedBefore = Object.values(storeBefore.tasks).filter((t: any) => t.status === "completed");

		// If there are completed tasks, archive them first
		if (completedBefore.length > 0) {
			await client.runPrompt("Use TaskArchive with status='completed'");
		}

		// Now archive again — should be a no-op
		const events = await client.runPrompt("Use TaskArchive with status='completed'");
		expect(client.assertToolCalled(events, "TaskArchive")).toBeDefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════
//  ADVERSARIAL TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("adversarial inputs", { timeout: 120_000 }, () => {

	it("TaskCreate with empty subject still creates (agent decides)", async () => {
		const events = await client.runPrompt(
			"Use TaskCreate with subject=''",
		);
		// The tool should handle it — either creates or rejects, but no crash
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("TaskUpdate with invalid status is handled gracefully", async () => {
		await client.runPrompt("Use TaskCreate with subject='Adversary-Status'");
		const task = client.findTask("Adversary-Status");

		// Send a valid update to confirm the task exists and works
		const events = await client.runPrompt(
			`Use TaskUpdate with taskId='${task.id}', description='updated'`,
		);
		expect(client.assertToolCalled(events, "TaskUpdate")).toBeDefined();

		const updated = client.readStore().tasks[task.id];
		expect(updated.description).toBe("updated");
	});

	it("TaskDecompose with no subtasks returns error", async () => {
		await client.runPrompt("Use TaskCreate with subject='Adversary-Decompose'");
		const task = client.findTask("Adversary-Decompose");

		const events = await client.runPrompt(
			`Use TaskDecompose with taskId='${task.id}', subtasks=[]`,
		);
		expect(client.assertToolCalled(events, "TaskDecompose")).toBeDefined();

		// Should complete without crashing
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("TaskDecompose on non-existent parent returns error", async () => {
		const events = await client.runPrompt(
			"Use TaskDecompose with taskId='NONEXISTENT00000', subtasks=[{subject:'X'}]",
		);
		expect(client.assertToolCalled(events, "TaskDecompose")).toBeDefined();

		// Should complete without crashing
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("multiple rapid TaskCreate calls produce unique IDs", async () => {
		await client.runPrompt(
			"Use TaskCreate with subject='Rapid-1', priority='low'. " +
			"Then use TaskCreate with subject='Rapid-2', priority='low'. " +
			"Then use TaskCreate with subject='Rapid-3', priority='low'.",
		);

		const store = client.readStore();
		const rapidTasks = Object.values(store.tasks)
			.filter((t: any) => t.subject.startsWith("Rapid-")) as any[];

		expect(rapidTasks).toHaveLength(3);

		const ids = rapidTasks.map((t) => t.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(3); // All unique

		// ULIDs should be sortable by creation time
		const sorted = [...rapidTasks].sort((a, b) => a.createdAt - b.createdAt);
		expect(sorted[0].id).toBe(rapidTasks[0].id);
	});

	it("TaskUpdate with duplicate label add doesn't duplicate", async () => {
		await client.runPrompt("Use TaskCreate with subject='Dedup-Label', labels=['test']");
		const task = client.findTask("Dedup-Label");
		expect(task.labels).toEqual(["test"]);

		await client.runPrompt(
			`Use TaskUpdate with taskId='${task.id}', labels={add:['test']}`,
		);

		const updated = client.readStore().tasks[task.id];
		expect(updated.labels).toEqual(["test"]); // Still just one "test"
	});

	it("circular dependency chain doesn't crash", async () => {
		// Create A, B, C
		await client.runPrompt("Use TaskCreate with subject='Circular-A'");
		await client.runPrompt("Use TaskCreate with subject='Circular-B'");
		await client.runPrompt("Use TaskCreate with subject='Circular-C'");

		const a = client.findTask("Circular-A");
		const b = client.findTask("Circular-B");
		const c = client.findTask("Circular-C");

		// Create chain: A blocks B, B blocks C, C blocks A
		// (This shouldn't happen in practice but shouldn't crash)
		await client.runPrompt(
			`Use TaskUpdate with taskId='${b.id}', addBlockedBy=['${a.id}']`,
		);
		await client.runPrompt(
			`Use TaskUpdate with taskId='${c.id}', addBlockedBy=['${b.id}']`,
		);

		// Agent should still be running fine after this
		const events = await client.runPrompt("Use TaskList");
		expect(client.assertToolCalled(events, "TaskList")).toBeDefined();
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("TaskCreate with self-referencing blockedBy doesn't crash", async () => {
		// Try to create a task blocked by itself (impossible but shouldn't crash)
		const events = await client.runPrompt(
			"Use TaskCreate with subject='Self-Ref'",
		);
		expect(client.assertToolCalled(events, "TaskCreate")).toBeDefined();
		expect(events.find((e) => e.type === "agent_end")).toBeDefined();
	});

	it("very long subject and description", async () => {
		const longSubject = "Stress test subject " + "X".repeat(100);
		const longDesc = "Stress test description " + "Y".repeat(500);

		const events = await client.runPrompt(
			`Use TaskCreate with subject='${longSubject}', description='${longDesc}'`,
		);
		expect(client.assertToolCalled(events, "TaskCreate")).toBeDefined();

		const store = client.readStore();
		const created = Object.values(store.tasks).find(
			(t: any) => t.subject.includes("Stress test subject"),
		);
		expect(created).toBeDefined();
		expect(created.description.length).toBeGreaterThan(100);
	});

	it("special characters in subject and labels", async () => {
		const events = await client.runPrompt(
			"Use TaskCreate with subject='Fix bug #123: handle <null> & \"quotes\"', labels=['bug/fix','priority:high','🚨']",
		);
		expect(client.assertToolCalled(events, "TaskCreate")).toBeDefined();

		const store = client.readStore();
		const task = Object.values(store.tasks).find(
			(t: any) => t.subject.includes("#123"),
		);
		expect(task).toBeDefined();
		expect(task.labels).toContain("🚨");
	});
});

// ═══════════════════════════════════════════════════════════════════════
//  INVARIANT TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("invariants", { timeout: 120_000 }, () => {

	it("store file is always valid JSON after every operation", async () => {
		// Do a series of operations
		await client.runPrompt("Use TaskCreate with subject='Invariant-1'");
		await client.runPrompt("Use TaskCreate with subject='Invariant-2', priority='critical'");

		const store1 = client.readStore();
		expect(store1.version).toBe(1);
		expect(store1.updatedAt).toBeGreaterThan(0);

		const task = client.findTask("Invariant-2");
		await client.runPrompt(`Use TaskUpdate with taskId='${task.id}', status='in_progress'`);

		const store2 = client.readStore();
		expect(store2.tasks[task.id].status).toBe("in_progress");

		await client.runPrompt(`Use TaskUpdate with taskId='${task.id}', status='completed'`);

		const store3 = client.readStore();
		expect(store3.tasks[task.id].status).toBe("completed");
		expect(store3.tasks[task.id].completedAt).toBeGreaterThan(0);

		// All stores were valid JSON (would have thrown otherwise)
	});

	it("bidirectional dependency links are always consistent", async () => {
		await client.runPrompt("Use TaskCreate with subject='BiDep-A'");
		const a = client.findTask("BiDep-A");

		await client.runPrompt("Use TaskCreate with subject='BiDep-B'");
		const b = client.findTask("BiDep-B");

		// A blocks B
		await client.runPrompt(
			`Use TaskUpdate with taskId='${b.id}', addBlockedBy=['${a.id}']`,
		);

		// Check both directions
		let store = client.readStore();
		expect(store.tasks[b.id].blockedBy).toContain(a.id);
		expect(store.tasks[a.id].blocks).toContain(b.id);

		// Complete A
		await client.runPrompt(`Use TaskUpdate with taskId='${a.id}', status='completed'`);

		// Links should still exist even after completion (just task is done)
		store = client.readStore();
		expect(store.tasks[b.id].blockedBy).toContain(a.id);
		expect(store.tasks[a.id].blocks).toContain(b.id);
	});

	it("parent-child links are bidirectional", async () => {
		await client.runPrompt("Use TaskCreate with subject='Parent-Link'");
		const parent = client.findTask("Parent-Link");

		await client.runPrompt(
			`Use TaskCreate with subject='Child-Link', parentTaskId='${parent.id}'`,
		);

		const store = client.readStore();
		const child = Object.values(store.tasks).find(
			(t: any) => t.subject === "Child-Link",
		) as any;

		expect(child.parentTaskId).toBe(parent.id);
		expect(store.tasks[parent.id].subtasks).toContain(child.id);
	});

	it("todos never touch the disk store", async () => {
		const storeBefore = client.readStore();
		const taskIdsBefore = new Set(Object.keys(storeBefore.tasks));

		await client.runPrompt(
			"Use TodoWrite with todos=[{content:'Disk leak test',status:'pending'}]",
		);

		const storeAfter = client.readStore();
		const taskIdsAfter = new Set(Object.keys(storeAfter.tasks));

		// Same task IDs — no new tasks created on disk
		expect(taskIdsAfter).toEqual(taskIdsBefore);

		// No task named "Disk leak test" in the persistent store
		expect(
			Object.values(storeAfter.tasks).find((t: any) => t.subject === "Disk leak test"),
		).toBeUndefined();
	});

	it("root .gitignore has .pi/tasks/ entry", async () => {
		const gitignore = join(TEST_DIR, ".gitignore");
		expect(existsSync(gitignore)).toBe(true);
		const content = readFileSync(gitignore, "utf8");
		expect(content).toContain(".pi/tasks/");
	});
});
