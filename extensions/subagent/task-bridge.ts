/**
 * Task bridge — connects subagent pool to the task system.
 *
 * Responsibilities:
 *   - Render agent sub-items in the task widget
 *   - Listen for subagent:completed → auto-update linked task
 *   - Read/save results to .pi/agents/results/
 */

import type { SubagentEvents } from "./api.js";
import type { AgentStatusReport } from "./agent-pool.js";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface TaskInfo {
	id: string;
	subject: string;
	status: string;
	priority: string;
	owner?: string;
}

export interface TaskStore {
	tasks: Record<string, TaskInfo & { [key: string]: unknown }>;
}

export interface TaskBridgeCallbacks {
	updateTask(taskId: string, updates: Record<string, unknown>): void;
	loadTask(taskId: string): (TaskInfo & { [key: string]: unknown }) | null;
}

// ─── Widget rendering ───────────────────────────────────────────────

/**
 * Render a sub-item line for a task that has an agent owner.
 * Returns null if the task is not owned by an agent.
 */
export function renderAgentSubItem(
	task: TaskInfo,
	agents: AgentStatusReport[],
	theme: Theme,
): string | null {
	if (!task.owner?.startsWith("agent:")) return null;

	const agentName = task.owner.replace("agent:", "");
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return theme.fg("dim", `  └── agent:${agentName} (offline)`);
	}

	const stateIcons: Record<string, string> = {
		starting: "⏳",
		idle: "○",
		working: "●",
		done: "✓",
		failed: "✗",
		killed: "✗",
	};

	const icon = stateIcons[agent.state] ?? "?";
	const model = agent.model.split("/").pop() ?? agent.model;
	const cost = agent.cost > 0 ? ` $${agent.cost.toFixed(4)}` : "";
	const turns = agent.turns > 0 ? ` turn ${agent.turns}` : "";
	const duration = agent.duration > 0
		? ` ${formatDuration(agent.duration)}`
		: "";
	const error = agent.error ? ` ${theme.fg("error", agent.error)}` : "";

	const stateColor = agent.state === "working"
		? "accent"
		: agent.state === "done"
			? "success"
			: agent.state === "failed"
				? "error"
				: "dim";

	return theme.fg(
		stateColor,
		`  └── agent:${agentName} ${icon} ${agent.state} (${model})${turns}${cost}${duration}`,
	) + error;
}

/**
 * Format milliseconds to human-readable duration.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

// ─── Auto-update ────────────────────────────────────────────────────

/**
 * Register event listener that auto-updates tasks when agents complete.
 * Returns an unsubscribe function.
 */
export function registerTaskAutoUpdate(
	events: SubagentEvents,
	callbacks: TaskBridgeCallbacks,
): () => void {
	return events.on("subagent:completed", (data: unknown) => {
		const event = data as {
			name: string;
			task?: string;
			status: string;
			output?: string;
			turns?: number;
			cost?: number;
			resultFile?: string;
			error?: string;
		};

		if (!event.task) return;

		const task = callbacks.loadTask(event.task);
		if (!task) return;

		// Only update if still owned by this agent
		if (task.owner !== `agent:${event.name}`) return;

		const updates: Record<string, unknown> = {
			status: event.status === "done" ? "completed" : "blocked",
			metadata: {
				...(task.metadata as Record<string, unknown> ?? {}),
				subagentResult: event.resultFile,
				subagentCost: event.cost,
				subagentTurns: event.turns,
			},
		};

		callbacks.updateTask(event.task, updates);
	});
}

// ─── Result reading ─────────────────────────────────────────────────

export interface AgentResultFile {
	agentName: string;
	taskId?: string;
	status: "done" | "failed" | "killed";
	output: string;
	turns: number;
	cost: number;
	duration: number;
	error?: string;
}

/**
 * Read a saved agent result from disk.
 */
export function readResult(cwd: string, agentName: string): AgentResultFile | null {
	const resultFile = join(cwd, ".pi", "agents", "results", `${agentName}.json`);
	if (!existsSync(resultFile)) return null;

	try {
		return JSON.parse(readFileSync(resultFile, "utf8"));
	} catch {
		return null;
	}
}
