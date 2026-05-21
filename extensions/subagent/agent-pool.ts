/**
 * Agent pool — manages named RPC subprocess agents.
 *
 * Each agent is a `pi --mode rpc` subprocess running in the same cwd.
 * Strict lifecycle: starting → idle → working → done/failed/killed.
 * No persistence — kill all on session shutdown.
 */

import { RpcClient } from "../shared/rpc-client.js";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export type AgentState = "starting" | "idle" | "working" | "done" | "failed" | "killed";

export interface AgentHandle {
	name: string;
	client: RpcClient;
	profile?: string;
	model: string;
	tools: string[] | null;
	taskId?: string;
	startedAt: number;
	completedAt?: number;
}

export interface AgentResult {
	agentName: string;
	taskId?: string;
	status: "done" | "failed" | "killed";
	output: string;
	turns: number;
	cost: number;
	duration: number;
	error?: string;
	resultFile?: string;
}

export interface SpawnOptions {
	name: string;
	cwd: string;
	model?: string;         // resolved model id or tier name
	tools?: string[] | null;
	prompt?: string;         // initial prompt to send
	profile?: string;        // profile name for tracking
	taskId?: string;         // bind to a task
	maxConcurrency?: number;
	timeoutMs?: number;
}

// ─── Pool ────────────────────────────────────────────────────────────

export class AgentPool {
	private agents = new Map<string, AgentHandle>();
	private maxConcurrency: number;
	private defaultTimeoutMs: number;

	constructor(opts?: { maxConcurrency?: number; timeoutMs?: number }) {
		this.maxConcurrency = opts?.maxConcurrency ?? 5;
		this.defaultTimeoutMs = opts?.timeoutMs ?? 300_000; // 5 min
	}

	// ── Core lifecycle ──

	async spawn(opts: SpawnOptions): Promise<AgentHandle> {
		const { name, cwd } = opts;

		// Kill existing agent with same name
		if (this.agents.has(name)) {
			this.kill(name, "replaced");
		}

		// Check concurrency
		const activeCount = this.getActiveCount();
		if (activeCount >= this.maxConcurrency) {
			throw new Error(
				`Concurrency limit reached (${this.maxConcurrency} active agents). ` +
				`Kill an agent before spawning a new one.`,
			);
		}

		// Create session dir
		const sessionDir = join(homedir(), ".pi", "subagent-sessions");
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

		// Spawn RPC client
		const client = new RpcClient(
			resolve(cwd),
			name,
			opts.profile ?? "ad-hoc",
		);

		const handle: AgentHandle = {
			name,
			client,
			profile: opts.profile,
			model: opts.model ?? "balanced",
			tools: opts.tools !== undefined ? opts.tools : null,
			taskId: opts.taskId,
			startedAt: Date.now(),
		};

		this.agents.set(name, handle);

		try {
			await client.start();
			await client.sendCommand("set_session_name", { name: `subagent:${name}` });

			// Set model if specified (format: "provider/modelId" or just tier name)
			if (opts.model) {
				const parts = opts.model.split("/");
				if (parts.length === 2) {
					await client.sendCommand("set_model", { provider: parts[0], modelId: parts[1] });
				}
				// If just a tier name, pi uses its default — no action needed
			}

			// Auto-respond to UI requests (no interactive prompts in subagents)
			client.setUIRequestHandler(async (req) => {
				if (req.method === "confirm") return { confirmed: true };
				if (req.method === "select") {
					const opts = (req as { options?: Array<{ value: string }> }).options;
					return opts?.length ? { value: opts[0].value } : { cancelled: true };
				}
				if (req.method === "input") return { value: "" };
				if (req.method === "editor") return { cancelled: true };
				return { cancelled: true };
			});

			// Set up timeout
			const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
			const timeoutId = setTimeout(() => {
				if (this.agents.has(name)) {
					this.kill(name, "timeout");
				}
			}, timeoutMs);

			// Clear timeout on completion
			client.onEvent((event) => {
				if (event.type === "agent_end" || event.type === "error") {
					clearTimeout(timeoutId);
				}
			});

			// Send initial prompt if provided — fire and don't wait for completion
			// The caller decides when to collect the result
			if (opts.prompt) {
				client.prompt(opts.prompt).catch(() => { /* error handled by status tracking */ });
			}
		} catch (err) {
			// Clean up on spawn failure
			this.agents.delete(name);
			try { client.kill(); } catch { /* ignore */ }
			throw err;
		}

		return handle;
	}

	async send(name: string, prompt: string): Promise<void> {
		const handle = this.get(name);
		if (!handle) throw new Error(`No agent named "${name}"`);

		const state = handle.client.status.state;
		if (state === "dead" || state === "error") {
			throw new Error(`Agent "${name}" is ${state} and cannot receive messages`);
		}

		await handle.client.prompt(prompt);
	}

	async collect(name: string): Promise<AgentResult> {
		const handle = this.agents.get(name);

		// If agent is still in pool, collect from it
		if (handle) {
			const status = handle.client.status;
			const output = await handle.client.getLastAssistantText();

			const result: AgentResult = {
				agentName: name,
				taskId: handle.taskId,
				status: status.state === "dead" || status.state === "error" ? "failed" : "done",
				output: output ?? "",
				turns: status.turnCount,
				cost: status.totalCost,
				duration: Date.now() - handle.startedAt,
				error: status.error ?? undefined,
			};

			result.resultFile = this.saveResult(name, result, handle);
			return result;
		}

		throw new Error(`No agent named "${name}"`);
	}

	/**
	 * Read a previously-saved result from disk (for agents already cleaned up).
	 */
	async collectFromDisk(name: string, cwd: string): Promise<AgentResult> {
		const { readResult } = await import("./task-bridge.js");
		const diskResult = readResult(cwd, name);
		if (diskResult) {
			return {
				agentName: diskResult.agentName,
				taskId: diskResult.taskId,
				status: diskResult.status,
				output: diskResult.output,
				turns: diskResult.turns,
				cost: diskResult.cost,
				duration: diskResult.duration,
				error: diskResult.error,
			};
		}

		throw new Error(`No result found for agent "${name}". It may still be running or never existed.`);
	}

	kill(name: string, reason: string = "user"): void {
		const handle = this.agents.get(name);
		if (!handle) return;

		handle.client.kill();
		handle.completedAt = Date.now();
		this.agents.delete(name);
	}

	killAll(reason: string = "shutdown"): void {
		for (const [name] of this.agents) {
			this.kill(name, reason);
		}
	}

	// ── Query ──

	get(name: string): AgentHandle | undefined {
		return this.agents.get(name);
	}

	getAll(): ReadonlyMap<string, AgentHandle> {
		return this.agents;
	}

	getActiveCount(): number {
		let count = 0;
		for (const handle of this.agents.values()) {
			const state = handle.client.status.state;
			if (state === "starting" || state === "idle" || state === "working") {
				count++;
			}
		}
		return count;
	}

	status(): AgentStatusReport[] {
		const reports: AgentStatusReport[] = [];
		for (const [name, handle] of this.agents) {
			const s = handle.client.status;
			reports.push({
				name,
				profile: handle.profile,
				model: handle.model,
				state: s.state as AgentState,
				pid: handle.client.pid,
				taskId: handle.taskId,
				turns: s.turnCount,
				cost: s.totalCost,
				duration: Date.now() - handle.startedAt,
				error: s.error,
			});
		}
		return reports;
	}

	// ── Result persistence ──

	public saveResult(name: string, result: AgentResult, handle: AgentHandle): string {
		const resultsDir = join(handle.client.worktreePath, ".pi", "agents", "results");
		if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });

		const resultFile = join(resultsDir, `${name}.json`);
		writeFileSync(resultFile, JSON.stringify(result, null, "\t") + "\n");

		return resultFile;
	}
}

export interface AgentStatusReport {
	name: string;
	profile?: string;
	model: string;
	state: AgentState;
	pid?: number;
	taskId?: string;
	turns: number;
	cost: number;
	duration: number;
	error?: string | null;
}
