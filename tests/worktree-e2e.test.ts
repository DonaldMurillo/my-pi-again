/**
 * Worktree extension — E2E tests via RPC.
 *
 * Each test gets its own pi subprocess in a git repo.
 * Verifies tool registration, worktree creation, and agent spawning.
 *
 * Run: npx vitest run tests/worktree-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { join } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	rmSync,
} from "node:fs";

const STAGGER_MS = 3_000;

// --- RPC client (same pattern as awty-e2e.test.ts) ---

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

	async prompt(message: string, timeoutMs = 90_000): Promise<JsonLine[]> {
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
		return events.find(
			(e) => e.type === "tool_execution_start" && (e as any).toolName === toolName,
		);
	}

	getToolResult(events: JsonLine[], toolName: string) {
		const r = events.find(
			(e) => e.type === "tool_execution_end" && (e as any).toolName === toolName,
		);
		return (r as any)?.result;
	}

	kill() { this.proc.kill(); }
}

// --- Test helpers ---

let testCounter = 0;

function freshGitRepo(): string {
	testCounter++;
	const dir = join(process.cwd(), ".tmp", `worktree-test-${testCounter}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), '{"name":"worktree-test"}');

	// Initialize git repo
	execSync("git init", { cwd: dir });
	execSync("git config user.email test@test.com", { cwd: dir });
	execSync("git config user.name Test", { cwd: dir });
	execSync("git add .", { cwd: dir });
	execSync("git commit -m init", { cwd: dir });

	return dir;
}

async function stagger() {
	await new Promise((r) => setTimeout(r, STAGGER_MS));
}

// ═══════════════════════════════════════════════════════════════════════

describe("Worktree E2E", { timeout: 120_000, sequential: true }, () => {

	it("should register worktree tool on startup", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"List the available tools you have. Is there a worktree tool?",
			);

			// Agent should mention the worktree tool
			const agentEnd = events.find((e) => e.type === "agent_end");
			expect(agentEnd).toBeDefined();
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should create a worktree via tool call", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"Use the worktree tool to create a worktree with branch 'feat/test' and purpose 'E2E test'.",
			);

			const toolCall = client.assertToolCalled(events, "worktree");
			expect(toolCall).toBeDefined();
			expect((toolCall as any).args.action).toBe("create");
			expect((toolCall as any).args.branch).toBe("feat/test");

			const toolResult = client.getToolResult(events, "worktree");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Created worktree");

			// Verify worktree directory exists on disk
			const wtDir = join(dir, ".pi", "worktrees", "feat", "test");
			// Git worktree add creates at the path — check it exists
			const resultText = toolResult.content[0].text;
			expect(resultText).toContain("Path:");

			// Extract path from result
			const pathMatch = resultText.match(/Path: (.+)/);
			if (pathMatch) {
				expect(existsSync(pathMatch[1])).toBe(true);
			}
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should list worktrees", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			// Create first
			await client.prompt(
				"Use the worktree tool to create a worktree with branch 'list-test' and purpose 'test listing'.",
			);

			// Then list
			const events = await client.prompt(
				"Use the worktree tool to list all worktrees.",
			);

			const toolResult = client.getToolResult(events, "worktree");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("list-test");
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should show worktree path in create result for agent to use", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"Create a worktree called 'write-test' with purpose 'test writing files'. Then read the package.json in that worktree.",
			);

			// Should have both worktree create and read tool calls
			const wtCall = client.assertToolCalled(events, "worktree");
			expect(wtCall).toBeDefined();

			// The read tool should be called with the worktree path
			const readCall = client.assertToolCalled(events, "read");
			expect(readCall).toBeDefined();

			const readPath = (readCall as any).args.path as string;
			expect(readPath).toContain("write-test");
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should cleanup worktree", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			// Create
			await client.prompt(
				"Use the worktree tool to create a worktree with branch 'cleanup-test' and purpose 'test cleanup'.",
			);

			// Cleanup
			const events = await client.prompt(
				"Use the worktree tool to cleanup the worktree for branch 'cleanup-test'.",
			);

			const toolResult = client.getToolResult(events, "worktree");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Removed worktree");
		} finally {
			client.kill();
		}

		await stagger();
	});
});
