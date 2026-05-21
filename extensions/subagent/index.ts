/**
 * Subagent extension — pi extension for spawning and managing sub-agents.
 *
 * Provides:
 *   - `subagent` tool — spawn, send, collect, kill, status, fanout, list-profiles
 *   - `/agent` command — create and list agent profiles
 *   - `/agents` command — show running agents
 *   - Event bus API for other extensions
 *   - Task integration (widget sub-items, auto-update)
 *   - Agent pool status widget
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { SubagentAPI } from "./api.js";
import { loadConfig } from "./model-tiers.js";
import { renderAgentSubItem, readResult } from "./task-bridge.js";

export default function (pi: ExtensionAPI): void {
	let api: SubagentAPI;

	// ── Inject tool docs into system prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## subagent extension

You have a \`subagent\` tool for spawning and managing sub-agents.

Usage:
- \`subagent({ action: "list-profiles" })\` — show available agent profiles
- \`subagent({ action: "spawn", name: "fixer", profile: "reviewer", prompt: "Fix the bug" })\` — spawn named agent
- \`subagent({ action: "spawn", name: "fixer", profile: "fast", task: "<task-id>" })\` — spawn and bind to task
- \`subagent({ action: "send", name: "fixer", prompt: "Also fix the test" })\` — send follow-up
- \`subagent({ action: "collect", name: "fixer" })\` — collect result
- \`subagent({ action: "status" })\` — check all agents
- \`subagent({ action: "kill", name: "fixer" })\` — kill agent
- \`subagent({ action: "fanout", items: [...], profile: "fast" })\` — parallel dispatch

Model tiers: fast (glm-4.5-air), balanced (glm-5-turbo), deep (glm-5.1)
`;
	});

	// ── Initialize API on session start ──

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		// Task update hook — writes directly to the tasks store
		const taskUpdateHook = (taskId: string, updates: Record<string, unknown>) => {
			try {
				const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
				const { join } = require("node:path");
				const dir = join(ctx.cwd, ".pi", "tasks");
				const path = join(dir, "tasks.json");
				if (!existsSync(path)) return;
				const store = JSON.parse(readFileSync(path, "utf8"));
				const task = store.tasks[taskId];
				if (!task) return;
				Object.assign(task, updates);
				if (updates.status === "completed") task.completedAt = Date.now();
				if (updates.status === "completed") task.updatedAt = Date.now();
				writeFileSync(path, JSON.stringify(store, null, "\t"));

				// Notify tasks extension to refresh its widget
				pi.events.emit("task:updated", { taskId, updates });
			} catch {
				// Tasks store may not exist — that's fine
			}
		};

		api = new SubagentAPI(ctx.cwd, pi.events, {
			maxConcurrency: config.defaults.maxConcurrency,
			timeoutMs: config.defaults.timeoutSeconds * 1000,
			onTaskUpdate: taskUpdateHook,
		});

		// Register event bus handlers for other extensions
		api.registerEventHandlers();
	});

	// ── Cleanup on shutdown ──

	pi.on("session_shutdown", async () => {
		if (api) api.killAll("shutdown");
	});

	// ── Tool: subagent ──────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Manage sub-agents for parallel work. Actions: " +
			"list-profiles (show available profiles), " +
			"spawn (start a named agent), " +
			"send (send prompt to running agent), " +
			"collect (get agent result), " +
			"kill (terminate agent), " +
			"status (check all agents), " +
			"fanout (parallel dispatch).",
		parameters: Type.Object({
			action: StringEnum([
				"spawn", "send", "collect", "kill", "status",
				"fanout", "list-profiles",
			] as const, {
				description: "Action to perform",
			}),

			// Spawn options
			name: Type.Optional(Type.String({
				description: "Agent name (required for spawn, send, collect, kill)",
			})),
			profile: Type.Optional(Type.String({
				description: "Profile name from .pi/agents/ or .claude/agents/",
			})),
			prompt: Type.Optional(Type.String({
				description: "Initial prompt or follow-up message",
			})),
			task: Type.Optional(Type.String({
				description: "Task ID to bind to agent",
			})),
			model: Type.Optional(Type.String({
				description: "Model tier: fast, balanced, deep",
			})),
			tools: Type.Optional(Type.Array(Type.String()), {
				description: "Tool whitelist for the agent",
			}),

			// Fanout options
			items: Type.Optional(Type.Array(Type.Object({
				prompt: Type.String(),
				task: Type.Optional(Type.String()),
			}))),
			concurrency: Type.Optional(Type.Number({
				description: "Max parallel agents for fanout (default 3)",
			})),
			failFast: Type.Optional(Type.Boolean({
				description: "Kill remaining agents on first error (default false)",
			})),

			// Send alias
			message: Type.Optional(Type.String({
				description: "Alias for prompt (used with send action)",
			})),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { action } = params;

			if (!api) {
				return errorResult("Subagent API not initialized. Session may not have started.");
			}

			try {
				switch (action) {
					case "list-profiles":
						return handleListProfiles(ctx);

					case "spawn":
						return await handleSpawn(params, ctx, onUpdate);

					case "send":
						return await handleSend(params, ctx);

					case "collect":
						return await handleCollect(params, ctx);

					case "kill":
						return handleKill(params);

					case "status":
						return handleStatus(ctx);

					case "fanout":
						return await handleFanout(params, ctx, onUpdate);

					default:
						return errorResult(`Unknown action: ${action}`);
				}
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	});

	// ── Command: /agent ──────────────────────────────────────────────

	pi.registerCommand("agent", {
		description: "Manage agent profiles: /agent [list|create <name>]",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (sub === "create" && parts[1]) {
				const name = parts[1];
				const def = api.createAgentProfile(name, { prompt: "# Agent prompt\n", model: "balanced" });
				ctx.ui.notify(`Created agent profile: ${name} at .pi/agents/${name}.md`, "info");
			} else if (sub === "list" || sub === "" || !sub) {
				if (!api) {
					ctx.ui.notify("Subagent API not initialized.", "warning");
					return;
				}
				const profiles = api.listProfiles();
				if (profiles.length === 0) {
					ctx.ui.notify("No agent profiles found. Create one with /agent create <name>", "info");
					return;
				}
				const lines = profiles.map((p) =>
					`  ${p.name} (${p.source}) — model: ${p.model}, tools: ${p.tools === null ? "inherit" : p.tools.length ? p.tools.join(",") : "none"}`,
				);
				ctx.ui.notify(`Agent profiles:\n${lines.join("\n")}`, "info");
			} else {
				ctx.ui.notify("Usage: /agent [list|create <name>]", "info");
			}
		},
	});

	// ── Command: /agents ─────────────────────────────────────────────

	pi.registerCommand("agents", {
		description: "Show running sub-agents",
		async handler(_args, ctx) {
			if (!api) {
				ctx.ui.notify("No agents running.", "info");
				return;
			}

			const reports = api.status();
			if (reports.length === 0) {
				ctx.ui.notify("No agents running.", "info");
				return;
			}

			const lines = reports.map((r) => {
				const icon = r.state === "working" ? "●" : r.state === "idle" ? "○" : "✗";
				const model = r.model.split("/").pop() ?? r.model;
				return `${icon} ${r.name} — ${r.state} (${model}) turns:${r.turns} cost:$${r.cost.toFixed(4)}`;
			});
			ctx.ui.notify(`Running agents:\n${lines.join("\n")}`, "info");
		},
	});

	// ── Widget: agent pool status ────────────────────────────────────

	let lastCtx: ExtensionContext | undefined;

	// Refresh widget on tool results
	pi.on("tool_result", async (event, ctx) => {
		lastCtx = ctx;
		if (event.toolName === "subagent") {
			refreshWidget(ctx);
		}
	});

	// Refresh widget on session start
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		refreshWidget(ctx);
	});

	// Refresh widget on any subagent event (real-time updates)
	pi.events.on("subagent:turn", () => {
		if (lastCtx) refreshWidget(lastCtx);
	});

	pi.events.on("subagent:completed", () => {
		if (lastCtx) refreshWidget(lastCtx);
	});

	pi.events.on("subagent:killed", () => {
		if (lastCtx) refreshWidget(lastCtx);
	});

	pi.events.on("subagent:spawned", () => {
		if (lastCtx) refreshWidget(lastCtx);
	});

	function refreshWidget(ctx: ExtensionContext): void {
		if (!api) {
			ctx.ui.setWidget("subagents", undefined);
			return;
		}

		// Check current state — if empty, remove widget
		if (api.status().length === 0) {
			ctx.ui.setWidget("subagents", undefined);
			return;
		}

		// Always re-read status inside render() so it's never stale
		ctx.ui.setWidget("subagents", (_tui: any, theme: any) => {
			const reports = api!.status();
			if (reports.length === 0) return { render: () => [], invalidate() {} };

			const lines: string[] = [];
			const active = reports.filter((r) => r.state === "working" || r.state === "idle");
			lines.push(theme.fg("accent", theme.bold(`agents (${active.length} active)`)));

			for (const r of reports.slice(0, 5)) {
				const icon = r.state === "working" ? "●" : r.state === "idle" ? "○" : "✗";
				const model = r.model.split("/").pop() ?? r.model;
				let line = `${icon} ${r.name} (${model})`;
				if (r.turns > 0) line += ` turn:${r.turns}`;
				if (r.cost > 0) line += ` $${r.cost.toFixed(4)}`;
				if (r.taskId) line += ` [task:${r.taskId.slice(0, 8)}]`;

				if (r.state === "working") lines.push(theme.fg("accent", line));
				else if (r.state === "failed") lines.push(theme.fg("error", line));
				else lines.push(theme.fg("dim", line));
			}

				const truncateToWidth = (line: string, maxW: number): string => {
					let vis = 0, cutPos = line.length, idx = 0;
					while (idx < line.length) {
						if (line[idx] === '\x1b') {
							const end = line.indexOf('m', idx);
							if (end >= 0) { idx = end + 1; continue; }
						}
						if (line[idx] === ']' && line[idx + 1] === '8' && line[idx + 2] === ';' && line[idx + 3] === ';') {
							const end = line.indexOf('\x07', idx);
							if (end >= 0) { idx = end + 1; continue; }
						}
						vis++;
						if (vis > maxW - 1) { cutPos = idx; break; }
						idx++;
					}
					return vis <= maxW - 1 ? line : line.slice(0, cutPos) + "\u2026";
				};
				return {
					render(width: number): string[] { return lines.map((l) => truncateToWidth(l, width)); },
					invalidate() {},
				};
		});
	}

	// ── Action handlers ──────────────────────────────────────────────

	function handleListProfiles(ctx: ExtensionContext) {
		const profiles = api.listProfiles();
		if (profiles.length === 0) {
			return textResult("No agent profiles found. Create .pi/agents/*.md or .claude/agents/*.md files.");
		}

		const lines = profiles.map((p) => {
			const tools = p.tools === null ? "inherit" : p.tools.length ? p.tools.join(", ") : "none";
			return `- ${p.name} (${p.source}) — model: ${p.model}, tools: ${tools}`;
		});
		return textResult(`Available agent profiles:\n${lines.join("\n")}`);
	}

	async function handleSpawn(
		params: { name?: string; profile?: string; prompt?: string; task?: string; model?: string; tools?: string[] },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const name = params.name?.trim();
		if (!name) return errorResult("name is required for spawn");

		onUpdate({
			content: [{ type: "text", text: `Agent "${name}" spawned and working...` }],
			details: { name, state: "spawned" },
		});

		await api.spawn({
			name,
			cwd: ctx.cwd,
			profile: params.profile,
			prompt: params.prompt,
			task: params.task,
			model: params.model,
			tools: params.tools,
		});

		return textResult(
			`Agent "${name}" spawned. Use \`subagent({ action: "collect", name: "${name}" })\` to get results when done.`,
		);
	}

	async function handleSend(
		params: { name?: string; prompt?: string; message?: string },
		_ctx: ExtensionContext,
	) {
		const name = params.name?.trim();
		const prompt = params.prompt ?? params.message;
		if (!name) return errorResult("name is required");
		if (!prompt?.trim()) return errorResult("prompt (or message) is required");

		await api.send(name, prompt.trim());
		return textResult(`Sent prompt to "${name}".`);
	}

	async function handleCollect(
		params: { name?: string },
		_ctx: ExtensionContext,
	) {
		const name = params.name?.trim();
		if (!name) return errorResult("name is required");

		const result = await api.collect(name);

		return textResult(
			`Agent "${name}" result:\n` +
			`Status: ${result.status}\n` +
			`Turns: ${result.turns}\n` +
			`Cost: $${result.cost.toFixed(4)}\n` +
			`Duration: ${(result.duration / 1000).toFixed(1)}s\n\n` +
			`${result.output.slice(0, 4000)}`,
		);
	}

	function handleKill(params: { name?: string }) {
		const name = params.name?.trim();
		if (!name) return errorResult("name is required");

		api.kill(name);
		return textResult(`Killed agent "${name}".`);
	}

	function handleStatus(ctx: ExtensionContext) {
		const reports = api.status();

		if (reports.length === 0) {
			return textResult("No active subagents.");
		}

		const lines = reports.map((r) => {
			const icon = r.state === "working" ? "●" : r.state === "idle" ? "○" : "✗";
			const model = r.model.split("/").pop() ?? r.model;
			let line = `${icon} ${r.name} — ${r.state} (${model})`;
			if (r.turns > 0) line += ` turns:${r.turns}`;
			if (r.cost > 0) line += ` $${r.cost.toFixed(4)}`;
			if (r.taskId) line += ` task:${r.taskId}`;
			if (r.error) line += ` error:${r.error}`;
			return line;
		});

		return textResult(`Active subagents (${reports.length}):\n${lines.join("\n")}`);
	}

	async function handleFanout(
		params: {
			items?: Array<{ prompt: string; task?: string }>;
			profile?: string;
			model?: string;
			tools?: string[];
			concurrency?: number;
			failFast?: boolean;
		},
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		if (!params.items?.length) {
			return errorResult("items array is required for fanout");
		}

		const count = params.items.length;
		const concurrency = params.concurrency ?? 3;

		onUpdate({
			content: [{ type: "text", text: `Fanning out ${count} tasks (concurrency: ${concurrency})...` }],
			details: { count, concurrency },
		});

		const results = await api.fanout({
			items: params.items,
			cwd: ctx.cwd,
			profile: params.profile,
			model: params.model,
			tools: params.tools,
			concurrency,
			failFast: params.failFast,
		});

		const successCount = results.filter((r) => r.status === "done").length;
		const failCount = results.length - successCount;
		const totalCost = results.reduce((sum, r) => sum + r.cost, 0);

		const summaryLines = results.map((r, i) => {
			const icon = r.status === "done" ? "✓" : "✗";
			return `${icon} [${i}] ${r.agentName} — ${r.status} (${r.turns} turns, $${r.cost.toFixed(4)})`;
		});

		return textResult(
			`Fanout complete: ${successCount}/${count} succeeded, ${failCount} failed. Cost: $${totalCost.toFixed(4)}\n\n` +
			summaryLines.join("\n"),
		);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}
