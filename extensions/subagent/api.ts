/**
 * SubagentAPI — unified internal API surface.
 *
 * The tool, commands, event handlers, and external extensions
 * all go through this class.
 *
 * Automations:
 *   1. spawn(task=X) → auto-assigns task owner + sets in_progress
 *   2. agent_end → auto-marks task completed/blocked
 *   3. collect() → auto-kills the agent (no idle zombies)
 */

import { AgentPool, type AgentResult, type AgentStatusReport } from "./agent-pool.js";
import {
	loadProfiles,
	loadProfile,
	createProfile,
	createAdHoc,
	type AgentDefinition,
} from "./agent-profile.js";
import { loadConfig, getTierConfig } from "./model-tiers.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface SubagentEvents {
	emit(event: string, data: unknown): void;
	on(event: string, handler: (data: unknown) => void): () => void;
}

export interface ApiSpawnOptions {
	name: string;
	cwd: string;
	profile?: string;
	prompt?: string;
	task?: string;
	model?: string;
	tools?: string[] | null;
}

export interface ApiFanoutOptions {
	items: Array<{ prompt: string; task?: string }>;
	cwd: string;
	profile?: string;
	model?: string;
	tools?: string[] | null;
	concurrency?: number;
	failFast?: boolean;
}

/** What spawn() returns — agent is working, not yet done. */
export interface SpawnReceipt {
	agentName: string;
	taskId?: string;
	pid?: number;
	message: string;
}

/** Hook called when a task needs updating. */
export type TaskUpdateHook = (
	taskId: string,
	updates: {
		status?: string;
		owner?: string;
		activeForm?: string;
		metadata?: Record<string, unknown>;
	},
) => void;

// ─── API ─────────────────────────────────────────────────────────────

export class SubagentAPI {
	private pool: AgentPool;
	private events: SubagentEvents;
	private cwd: string;
	private adHocProfiles = new Map<string, AgentDefinition>();
	private taskUpdateHook?: TaskUpdateHook;

	/** Resolvers for agents we're waiting on (collect / fanout). */
	private waiting = new Map<string, Array<(result: AgentResult) => void>>();

	constructor(
		cwd: string,
		events: SubagentEvents,
		opts?: {
			maxConcurrency?: number;
			timeoutMs?: number;
			onTaskUpdate?: TaskUpdateHook;
		},
	) {
		this.cwd = cwd;
		this.events = events;
		this.taskUpdateHook = opts?.onTaskUpdate;
		this.pool = new AgentPool({
			maxConcurrency: opts?.maxConcurrency ?? loadConfig(cwd).defaults.maxConcurrency,
			timeoutMs: opts?.timeoutMs ?? loadConfig(cwd).defaults.timeoutSeconds * 1000,
		});
	}

	// ── Core lifecycle ──

	/**
	 * Spawn an agent. Returns immediately — the agent works in the background.
	 * Use collect() to wait for the result, or status() to check progress.
	 *
	 * If task is provided:
	 *   - Auto-assigns task owner to "agent:<name>"
	 *   - Auto-sets task status to "in_progress"
	 *   - On completion, auto-marks task "completed" or "blocked"
	 */
	async spawn(opts: ApiSpawnOptions): Promise<SpawnReceipt> {
		// Resolve profile
		let profile: AgentDefinition | undefined;
		if (opts.profile) {
			profile = this.adHocProfiles.get(opts.profile) ??
				loadProfile(opts.profile, this.cwd) ??
				undefined;
			if (!profile && !opts.prompt) {
				throw new Error(`Profile "${opts.profile}" not found and no prompt provided`);
			}
		}

		// Resolve model
		const tier = opts.model ?? profile?.model ?? "balanced";
		const config = loadConfig(this.cwd);
		const tierConfig = getTierConfig(config, tier);

		// Resolve tools
		const tools = opts.tools !== undefined
			? opts.tools
			: profile?.tools !== undefined
				? profile.tools
				: null;

		// Build prompt
		let prompt = opts.prompt ?? "";
		if (!prompt && profile?.prompt) prompt = profile.prompt;
		if (opts.task && profile) {
			prompt = `${profile.prompt}\n\nYou are working on task: ${opts.task}`;
		}

		const modelStr = tierConfig
			? `${tierConfig.provider}/${tierConfig.model}`
			: tier;

		// Spawn in pool (fire-and-forget prompt)
		const handle = await this.pool.spawn({
			name: opts.name,
			cwd: opts.cwd,
			model: modelStr,
			tools,
			prompt: prompt || undefined,
			profile: opts.profile,
			taskId: opts.task,
		});

		// ── Automation 1: auto-assign task ──
		if (opts.task && this.taskUpdateHook) {
			this.taskUpdateHook(opts.task, {
				owner: `agent:${opts.name}`,
				status: "in_progress",
				activeForm: `Agent ${opts.name} working`,
			});
		}

		// Emit spawned event
		this.events.emit("subagent:spawned", {
			name: opts.name,
			profile: opts.profile,
			model: modelStr,
			task: opts.task,
			pid: handle.client.pid,
		});

		// Track completion in background
		handle.client.onEvent((event) => {
			if (event.type === "turn_end") {
				this.events.emit("subagent:turn", {
					name: opts.name,
					turnCount: handle.client.status.turnCount,
					state: handle.client.status.state,
				});
			}

			if (event.type === "agent_end") {
				// Collect result from the agent and save to disk
				this.pool.collect(opts.name).then((result) => {
					this.events.emit("subagent:completed", {
						name: result.agentName,
						task: result.taskId,
						status: result.status,
						output: result.output,
						turns: result.turns,
						cost: result.cost,
						duration: result.duration,
						error: result.error,
						resultFile: result.resultFile,
					});

					// ── Automation 2: auto-complete task ──
					if (result.taskId && this.taskUpdateHook) {
						this.taskUpdateHook(result.taskId, {
							status: result.status === "done" ? "completed" : "blocked",
							activeForm: result.status === "done" ? undefined : `Agent failed: ${result.error}`,
							metadata: {
								subagentResult: result.resultFile,
								subagentCost: result.cost,
								subagentTurns: result.turns,
							},
						});
					}

					// Resolve anyone waiting via collect()
					const resolvers = this.waiting.get(opts.name);
					if (resolvers) {
						this.waiting.delete(opts.name);
						for (const resolve of resolvers) resolve(result);
					}
				}).catch(() => { /* best effort */ });
			}
		});

		return {
			agentName: opts.name,
			taskId: opts.task,
			pid: handle.client.pid,
			message: `Agent "${opts.name}" spawned and working.`,
		};
	}

	/**
	 * Send a follow-up prompt to a running agent.
	 */
	async send(name: string, prompt: string): Promise<void> {
		await this.pool.send(name, prompt);
		this.events.emit("subagent:turn", {
			name,
			prompt,
			turnCount: this.pool.get(name)?.client.status.turnCount ?? 0,
		});
	}

	/**
	 * Wait for an agent to finish and return its result.
	 * After returning, the agent is killed (removed from pool).
	 * If the agent already completed, reads from disk.
	 */
	async collect(name: string): Promise<AgentResult> {
		// Check if already done and in pool
		const handle = this.pool.get(name);
		if (handle) {
			const state = handle.client.status.state;
			if (state === "idle" || state === "dead") {
				// Agent already finished — collect, then cleanup
				const result = await this.pool.collect(name);
				this.pool.kill(name, "collected");
				this.events.emit("subagent:killed", { name, reason: "collected" });
				return result;
			}

			// Agent still working — wait for completion
			const result = await new Promise<AgentResult>((resolve) => {
				if (!this.waiting.has(name)) this.waiting.set(name, []);
				this.waiting.get(name)!.push(resolve);
			});

			// ── Automation 3: auto-cleanup after collect ──
			this.pool.kill(name, "collected");
			this.events.emit("subagent:killed", { name, reason: "collected" });
			return result;
		}

		// Not in pool — try reading from disk
		return this.pool.collectFromDisk(name, this.cwd);
	}

	kill(name: string, reason: string = "user"): void {
		this.pool.kill(name, reason);
		this.events.emit("subagent:killed", { name, reason });
		// Reject anyone waiting
		this.waiting.delete(name);
	}

	killAll(reason: string = "shutdown"): void {
		for (const [name] of this.pool.getAll()) {
			this.kill(name, reason);
		}
	}

	status(): AgentStatusReport[] {
		return this.pool.status();
	}

	// ── Fan-out ──

	async fanout(opts: ApiFanoutOptions): Promise<AgentResult[]> {
		const concurrency = opts.concurrency ?? 3;
		const total = opts.items.length;
		const agentNames: string[] = [];

		// Phase 1: Spawn all agents (returns immediately)
		for (let i = 0; i < total; i += concurrency) {
			const batch = opts.items.slice(i, i + concurrency);
			const spawnPromises = batch.map(async (item, batchIdx) => {
				const agentName = `fanout-${i + batchIdx}`;
				agentNames.push(agentName);
				try {
					await this.spawn({
						name: agentName,
						cwd: opts.cwd,
						profile: opts.profile,
						prompt: item.prompt,
						task: item.task,
						model: opts.model,
						tools: opts.tools,
					});
				} catch (err) {
					if (opts.failFast) {
						this.killAll("failfast");
						throw err;
					}
				}
			});
			await Promise.all(spawnPromises);
		}

		// Phase 2: Wait for all to complete via collect()
		const results = await Promise.all(
			agentNames.map((name) => this.collect(name)),
		);

		return results;
	}

	// ── Profiles ──

	listProfiles(): AgentDefinition[] {
		const repoProfiles = loadProfiles(this.cwd);
		const all = new Map<string, AgentDefinition>();
		for (const [name, def] of repoProfiles) all.set(name, def);
		for (const [name, def] of this.adHocProfiles) all.set(name, def);
		return Array.from(all.values());
	}

	createAgentProfile(name: string, opts: { prompt?: string; model?: string; tools?: string[] | null }): AgentDefinition {
		return createProfile(name, this.cwd, opts);
	}

	createAdHocProfile(name: string, opts: { prompt: string; model?: string; tools?: string[] | null }): AgentDefinition {
		const def = createAdHoc(name, opts);
		this.adHocProfiles.set(name, def);
		return def;
	}

	// ── Event bus registration ──

	registerEventHandlers(): void {
		this.events.on("subagent:spawn", (data: unknown) => {
			const opts = data as ApiSpawnOptions & { cwd?: string };
			this.spawn({
				name: opts.name,
				cwd: opts.cwd ?? this.cwd,
				profile: opts.profile,
				prompt: opts.prompt,
				task: opts.task,
				model: opts.model,
				tools: opts.tools,
			}).catch((err) => {
				this.events.emit("subagent:completed", {
					name: opts.name,
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
				});
			});
		});

		this.events.on("subagent:send", (data: unknown) => {
			const opts = data as { name: string; prompt: string };
			this.send(opts.name, opts.prompt).catch(() => {});
		});

		this.events.on("subagent:kill", (data: unknown) => {
			const opts = data as { name: string; reason?: string };
			this.kill(opts.name, opts.reason);
		});
	}

	getPool(): AgentPool {
		return this.pool;
	}
}
