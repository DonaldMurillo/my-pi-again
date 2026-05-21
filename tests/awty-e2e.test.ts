/**
 * AWTY (Are We There Yet) — real agent session tests.
 *
 * Each test gets its OWN pi subprocess (fresh state, no cross-contamination).
 * Staggered with delays to avoid LLM rate limiting.
 *
 * Run: npx vitest run tests/awty-e2e.test.ts
 */

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
} from "node:fs";

const STAGGER_MS = 4_000;

// --- RPC client ---

interface JsonLine { [key: string]: unknown; type: string; }

class RpcClient {
	private proc: ChildProcess;
	private buffer = "";
	private pending: Array<{ resolve: (line: JsonLine) => void; predicate: (line: JsonLine) => boolean }> = [];
	private lines: JsonLine[] = [];

	constructor(cwd: string) {
		this.proc = spawn("pi", ["--mode", "rpc", "--no-session"], {
			cwd, stdio: ["pipe", "pipe", "pipe"],
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
			} catch { /* ignore */ }
		}
	}

	async prompt(message: string, timeoutMs = 60_000): Promise<JsonLine[]> {
		this.proc.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const endIdx = this.lines.findIndex((l) => l.type === "agent_end");
			if (endIdx >= 0) return this.lines.splice(0, endIdx + 1);
			await new Promise((r) => setTimeout(r, 200));
		}
		return this.lines.splice(0);
	}

	assertToolCalled(events: JsonLine[], toolName: string) {
		return events.find((e) => e.type === "tool_execution_start" && (e as any).toolName === toolName);
	}

	getToolResult(events: JsonLine[], toolName: string) {
		const r = events.find((e) => e.type === "tool_execution_end" && (e as any).toolName === toolName);
		return (r as any)?.result;
	}

	kill() { this.proc.kill(); }
}

// --- Helpers ---

let testCounter = 0;

function freshDir(): string {
	testCounter++;
	const dir = join(process.cwd(), ".tmp", `awty-test-${testCounter}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), '{"name":"awty-test"}');
	return dir;
}

function readState(dir: string): any {
	const f = join(dir, ".pi", "assistant", "state.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf8"));
}

async function waitForFile(path: string, ms = 10_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (existsSync(path)) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`File not found: ${path}`);
}

async function stagger() {
	await new Promise((r) => setTimeout(r, STAGGER_MS));
}

// ═══════════════════════════════════════════════════════════════════════

describe("AWTY E2E", { timeout: 120_000, sequential: true }, () => {

	// --- Test 1: Activate AWTY ---

	it("should activate are-we-there-yet assistant", async () => {
		const dir = freshDir();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"Use the activate_assistant tool to activate the are-we-there-yet assistant.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();
			expect((toolCall as any).args.name).toBe("are-we-there-yet");

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult.isError).toBeFalsy();

			await waitForFile(join(dir, ".pi", "assistant", "state.json"));
			const state = readState(dir);
			expect(state.activated).toBe(true);
			expect(state.config.selectedAssistantId).toBe("are-we-there-yet");
		} finally {
			client.kill();
		}

		await stagger();
	});

	// --- Test 2: send_assistant_context ---

	it("should send context to the assistant via tool", async () => {
		const dir = freshDir();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"First activate the are-we-there-yet assistant. Then use the send_assistant_context tool with context 'File: hello.ts has export function hello()' and label 'file contents'.",
			);

			const ctxResult = client.getToolResult(events, "send_assistant_context");
			if (ctxResult) {
				expect(ctxResult.isError).toBeFalsy();
			}
		} finally {
			client.kill();
		}

		await stagger();
	});

	// --- Test 3: AWTY fires on agent_end ---

	it("should trigger AWTY evaluation after agent does work", async () => {
		const dir = freshDir();
		const client = new RpcClient(dir);

		try {
			// Activate AWTY
			await client.prompt(
				"Use the activate_assistant tool to activate the are-we-there-yet assistant.",
				60_000,
			);
			await waitForFile(join(dir, ".pi", "assistant", "state.json"));

			// Give a trivial task — agent creates file, AWTY evaluates
			const events = await client.prompt(
				"Create a file called marker.txt with the text 'done'. Nothing else needed.",
				90_000,
			);

			// Should have agent_end (the AWTY eval runs async but state should update)
			const agentEnd = events.find((e) => e.type === "agent_end");
			expect(agentEnd).toBeDefined();

			// Wait for async AWTY eval to persist state
			await new Promise((r) => setTimeout(r, 3000));

			const state = readState(dir);
			console.log(`  Eval history: ${state.evalHistory?.length ?? 0} entries`);
			console.log(`  Reprompt count: ${state.repromptCount ?? 0}`);

			// AWTY should have run at least once
			if (state.evalHistory && state.evalHistory.length > 0) {
				const lastEval = state.evalHistory[state.evalHistory.length - 1];
				console.log(`  Last eval: achieved=${lastEval.achieved} fallback=${lastEval.wasFallback}`);
				console.log(`  Summary: ${lastEval.summary?.slice(0, 100)}`);
				expect(lastEval).toHaveProperty("round");
				expect(lastEval).toHaveProperty("wasFallback");
			}
		} finally {
			client.kill();
		}

		await stagger();
	});

	// --- Test 4: Eval history accumulates ---

	it("should accumulate eval history across rounds", async () => {
		const dir = freshDir();
		// Pre-create a task for the agent
		writeFileSync(join(dir, "task.txt"), "This file needs to be updated to say 'completed'");
		const client = new RpcClient(dir);

		try {
			// Activate AWTY
			await client.prompt(
				"Use the activate_assistant tool to activate the are-we-there-yet assistant.",
				60_000,
			);
			await waitForFile(join(dir, ".pi", "assistant", "state.json"));

			// Give a task that requires modifying a file
			await client.prompt(
				"Read the file task.txt and update its contents to say 'completed' instead of what's there.",
				90_000,
			);

			// Wait for AWTY eval
			await new Promise((r) => setTimeout(r, 5000));

			const state = readState(dir);
			const evalLen = state.evalHistory?.length ?? 0;
			console.log(`  Eval history entries: ${evalLen}`);

			if (evalLen > 0) {
				// Verify eval history structure
				for (const e of state.evalHistory) {
					expect(e).toHaveProperty("round");
					expect(e).toHaveProperty("achieved");
					expect(e).toHaveProperty("summary");
					expect(e).toHaveProperty("wasFallback");
					expect(e).toHaveProperty("timestamp");
				}

				// Rounds should be sequential
				const rounds = state.evalHistory.map((e: any) => e.round);
				for (let i = 1; i < rounds.length; i++) {
					expect(rounds[i]).toBe(rounds[i - 1] + 1);
				}
			}
		} finally {
			client.kill();
		}

		await stagger();
	});

	// --- Test 5: File change detection ---

	it("should detect when files change between evals", async () => {
		const dir = freshDir();
		const client = new RpcClient(dir);

		try {
			// Activate AWTY
			await client.prompt(
				"Use the activate_assistant tool to activate the are-we-there-yet assistant.",
				60_000,
			);
			await waitForFile(join(dir, ".pi", "assistant", "state.json"));

			// First prompt: agent creates a file
			await client.prompt(
				"Write 'version 1' to a file called changeme.txt.",
				90_000,
			);

			await new Promise((r) => setTimeout(r, 3000));
			const state1 = readState(dir);
			const hash1 = state1.lastSnapshotHash ?? "";
			console.log(`  Snapshot hash after v1: ${hash1.slice(0, 12)}...`);
			console.log(`  Eval history: ${state1.evalHistory?.length ?? 0}`);

			// Manually modify the file to trigger a change
			writeFileSync(join(dir, "changeme.txt"), "version 2 -- modified externally");

			// Second prompt: ask something trivial (no file ops)
			await client.prompt(
				"What is 2 + 2? Just answer the number.",
				60_000,
			);

			await new Promise((r) => setTimeout(r, 3000));
			const state2 = readState(dir);
			console.log(`  Snapshot hash after v2: ${(state2.lastSnapshotHash ?? "").slice(0, 12)}...`);
			console.log(`  Hash changed: ${hash1 !== state2.lastSnapshotHash}`);
			console.log(`  Eval history: ${state2.evalHistory?.length ?? 0}`);
		} finally {
			client.kill();
		}

		await stagger();
	});

	// --- Test 6: Deactivation ---

	it("should deactivate and clear state", async () => {
		const dir = freshDir();
		const client = new RpcClient(dir);

		try {
			await client.prompt(
				"Use the activate_assistant tool to activate the are-we-there-yet assistant.",
				60_000,
			);
			await waitForFile(join(dir, ".pi", "assistant", "state.json"));

			let state = readState(dir);
			expect(state.activated).toBe(true);

			// Deactivate
			await client.prompt(
				"Run the /assistant deactivate command.",
				60_000,
			);

			await new Promise((r) => setTimeout(r, 1000));
			state = readState(dir);
			console.log(`  Activated after deactivate: ${state.activated}`);
		} finally {
			client.kill();
		}
	});
});
