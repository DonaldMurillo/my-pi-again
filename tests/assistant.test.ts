/**
 * Assistant extension — comprehensive live agent session tests.
 *
 * Tests the FULL pipeline: prompt → agent → tool call → extension hook → filesystem.
 *
 * Run: npx vitest run tests/assistant.test.ts
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

const TEST_DIR = join(process.cwd(), ".tmp", "assistant-test-workspace");

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
			} catch { /* ignore */ }
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

	assertToolCalled(events: JsonLine[], toolName: string): JsonLine | undefined {
		return events.find(
			(e) => e.type === "tool_execution_start" && (e as any).toolName === toolName,
		);
	}

	getToolResult(events: JsonLine[], toolName: string): any {
		const result = events.find(
			(e) => e.type === "tool_execution_end" && (e as any).toolName === toolName,
		);
		return (result as any)?.result;
	}

	kill() { this.proc.kill(); }
}

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

function readState(): any {
	const f = join(TEST_DIR, ".pi", "assistant", "state.json");
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

// ═══════════════════════════════════════════════════════════════════════

describe("Assistant Extension - E2E", () => {

	describe("activate_assistant tool", () => {
		it("should activate debugger assistant via tool call", async () => {
			const events = await client.runPrompt(
				"Use the activate_assistant tool to activate the debugger assistant.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();
			expect((toolCall as any).args.name).toBe("debugger");

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Debug Assistant");

			await waitForFile(join(TEST_DIR, ".pi", "assistant", "state.json"));
			const state = readState();
			expect(state).toBeTruthy();
			expect(state.activated).toBe(true);
			expect(state.config.selectedAssistantId).toBe("debugger");
		});

		it("should return error for nonexistent assistant", async () => {
			const events = await client.runPrompt(
				"Use the activate_assistant tool to activate an assistant called 'nonexistent'.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBe(true);
			expect(toolResult.content[0].text).toContain("not found");
		});

		it("should activate coder assistant", async () => {
			const events = await client.runPrompt(
				"Use the activate_assistant tool to activate the coder assistant.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();
			expect((toolCall as any).args.name).toBe("coder");

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Code Assistant");
		});

		it("should activate reviewer assistant", async () => {
			const events = await client.runPrompt(
				"Use the activate_assistant tool to activate the reviewer assistant.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Review Assistant");
		});
	});

	describe("State persistence", () => {
		it("should persist state to .pi/assistant/state.json", async () => {
			await client.runPrompt("Activate the debugger assistant using the tool.");

			await waitForFile(join(TEST_DIR, ".pi", "assistant", "state.json"));

			const state = readState();
			expect(state).toBeTruthy();
			expect(state.activated).toBe(true);
			expect(state.config).toBeDefined();
			expect(state.config.maxHistoryLength).toBe(100);
		});

		it("should persist selected assistant across activations", async () => {
			await client.runPrompt("Activate the coder assistant.");
			await waitForFile(join(TEST_DIR, ".pi", "assistant", "state.json"));

			let state = readState();
			expect(state.config.selectedAssistantId).toBe("coder");

			await client.runPrompt("Activate the reviewer assistant.");
			state = readState();
			expect(state.config.selectedAssistantId).toBe("reviewer");
		});
	});

	describe("Filesystem", () => {
		it("should create .pi/assistant/ directory structure", async () => {
			await client.runPrompt("Activate the debugger assistant.");

			const dir = join(TEST_DIR, ".pi", "assistant");
			expect(existsSync(dir)).toBe(true);
			expect(existsSync(join(dir, "state.json"))).toBe(true);
		});
	});

	describe("agent_end integration", () => {
		it("should fire agent_end after activation completes", async () => {
			const events = await client.runPrompt(
				"Activate the debugger assistant and tell me it's done.",
			);

			const agentEnd = events.find((e) => e.type === "agent_end");
			expect(agentEnd).toBeDefined();

			const messages = (agentEnd as any).messages ?? [];
			const toolResults = messages.filter((m: any) => m.role === "toolResult");
			expect(toolResults.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("Error handling", () => {
		it("should handle corrupted state file gracefully", async () => {
			const stateDir = join(TEST_DIR, ".pi", "assistant");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "state.json"), "not valid json {{{");

			const events = await client.runPrompt(
				"Activate the debugger assistant.",
			);

			const toolCall = client.assertToolCalled(events, "activate_assistant");
			expect(toolCall).toBeDefined();

			const toolResult = client.getToolResult(events, "activate_assistant");
			expect(toolResult.isError).toBeFalsy();
		});
	});
});
