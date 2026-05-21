/**
 * Worktree extension — E2E tests via RPC.
 *
 * Verifies the tool works: create a worktree, get a path back,
 * agent can work in it directly (read/write files at the worktree path),
 * then cleanup.
 *
 * Each test gets its own pi subprocess in a fresh git repo.
 *
 * Run: npx vitest run tests/worktree-e2e.test.ts
 */

import { describe, it, expect } from "vitest";
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

interface JsonLine { [key: string]: unknown; type: string; }

class RpcClient {
	private proc: ChildProcess;
	private buffer = "";
	private pending: Array<{ resolve: (line: JsonLine) => void; predicate: (line: JsonLine) => boolean }> = [];
	private lines: JsonLine[] = [];

	constructor(cwd: string, model?: string) {
		const args = ["--mode", "rpc", "--no-session"];
		if (model) args.push("--model", model);
		this.proc = spawn("pi", args, {
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

let testCounter = 0;

function freshGitRepo(): string {
	testCounter++;
	const dir = join(process.cwd(), ".tmp", `worktree-test-${testCounter}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), '{"name":"worktree-test"}');
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

	it("should create a worktree and return a usable path", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"Use the worktree tool to create a worktree with branch 'feat/test' and purpose 'E2E test'.",
			);

			const toolResult = client.getToolResult(events, "worktree");
			expect(toolResult).toBeDefined();
			expect(toolResult.isError).toBeFalsy();
			expect(toolResult.content[0].text).toContain("Created worktree");

			// Verify worktree directory exists on disk
			const resultText = toolResult.content[0].text;
			// Path is on its own line after "at:"
			const pathMatch = resultText.match(/at:\n(.+)/);
			if (pathMatch) {
				const wtPath = pathMatch[1].trim();
				expect(existsSync(wtPath)).toBe(true);
			}
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should list worktrees after creation", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			await client.prompt(
				"Use the worktree tool to create a worktree with branch 'list-test' and purpose 'test listing'.",
			);

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

	it("should write a file inside the worktree after creating it", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			const events = await client.prompt(
				"Create a worktree called 'write-test' with purpose 'test writing'. " +
				"Then use the write tool to create a file called marker.txt at the worktree path with content 'hello from worktree'.",
			);

			// Should have both worktree create and write tool calls
			const wtResult = client.getToolResult(events, "worktree");
			expect(wtResult).toBeDefined();
			expect(wtResult.isError).toBeFalsy();

			const writeResult = client.getToolResult(events, "write");
			expect(writeResult).toBeDefined();

			// The write path should contain the worktree branch name
			const writeCall = client.assertToolCalled(events, "write");
			const writePath = (writeCall as any).args.path as string;
			expect(writePath).toContain("write-test");

			// File should exist on disk at the worktree path
			expect(existsSync(writePath)).toBe(true);
			expect(readFileSync(writePath, "utf8")).toContain("hello from worktree");
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should read a file from the worktree", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			// Create worktree and write a file in one go
			await client.prompt(
				"Create a worktree called 'read-test' with purpose 'test reading'. " +
				"Then write 'secret content' to a file called data.txt in the worktree.",
			);

			// Now read it back
			const events = await client.prompt(
				"Read the data.txt file from the read-test worktree. Use the same path you wrote to.",
			);

			const readResult = client.getToolResult(events, "read");
			expect(readResult).toBeDefined();
			expect(readResult.isError).toBeFalsy();
		} finally {
			client.kill();
		}

		await stagger();
	});

	it("should cleanup a worktree", async () => {
		const dir = freshGitRepo();
		const client = new RpcClient(dir);

		try {
			await client.prompt(
				"Use the worktree tool to create a worktree with branch 'cleanup-test' and purpose 'test cleanup'.",
			);

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
