/**
 * Worktree extension — git worktree management with headless agent orchestration.
 *
 * Provides:
 *   - `worktree` tool — agent can create/list/spawn/send/cleanup worktrees
 *   - /worktree command — user can inspect and manage worktrees
 *   - RPC agent pool — persistent pi subprocess per worktree for autonomous work
 *   - Main session coordinates all active worktree agents
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, StringEnum } from "@mariozechner/pi-ai";
import {
	createWorktree,
	removeWorktree,
	getManagedWorktrees,
	listWorktrees,
	spawnAgent,
	killAgent,
	killAllAgents,
	getAgent,
	getAllAgents,
	getRepoRoot,
} from "./worktree-manager.js";

export default function (pi: ExtensionAPI): void {

	// ── Inject tool docs into system prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## worktree extension

You have a \`worktree\` tool for git worktree management and agent orchestration.

Usage:
- \`worktree({ action: "list" })\` — show all worktrees
- \`worktree({ action: "create", branch: "feat/auth", purpose: "Add auth" })\` — create worktree
- \`worktree({ action: "spawn", branch: "feat/auth" })\` — start headless agent in worktree
- \`worktree({ action: "send", branch: "feat/auth", message: "Start on login" })\` — send task to agent
- \`worktree({ action: "status" })\` — check all agent statuses
- \`worktree({ action: "kill", branch: "feat/auth" })\` — stop agent
- \`worktree({ action: "cleanup", branch: "feat/auth" })\` — remove worktree and kill agent

Each worktree gets an isolated agent that works independently. Use this to parallelize work.

**Important:** When the user asks to "work in" or "move to" a worktree, after creating it,
use the returned path as the working directory for all subsequent file operations (read, write, edit, bash).
The worktree path is a full absolute path — pass it to bash commands as \`cd <path> && ...\` or use it
as the \`path\` argument in read/write/edit tools. You do NOT need to spawn an agent to work in a worktree
yourself — just use the path directly.
`;
	});

	// ── Tool: worktree ─────────────────────────────────────────────────

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Manage git worktrees and their agents. Actions: " +
			"list (show all worktrees), " +
			"create (new worktree for a branch), " +
			"spawn (start headless pi agent in a worktree), " +
			"send (message a worktree agent), " +
			"status (check worktree agent status), " +
			"kill (stop a worktree agent), " +
			"cleanup (remove worktree and kill agent). " +
			"Use this to parallelize work — each worktree gets an isolated agent.",
		parameters: Type.Object({
			action: StringEnum(["list", "create", "spawn", "send", "status", "kill", "cleanup"] as const, {
				description: "Action to perform",
			}),
			branch: Type.Optional(Type.String({
				description: "Branch name (required for create, spawn, send, kill, cleanup)",
			})),
			purpose: Type.Optional(Type.String({
				description: "Why this worktree exists (required for create)",
			})),
			message: Type.Optional(Type.String({
				description: "Message to send to worktree agent (required for send)",
			})),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { action } = params;

			try {
				switch (action) {
					case "list":
						return await handleList(ctx);

					case "create":
						return await handleCreate(params, ctx);

					case "spawn":
						return await handleSpawn(params, ctx, onUpdate);

					case "send":
						return await handleSend(params, ctx, onUpdate);

					case "status":
						return await handleStatus(params, ctx);

					case "kill":
						return await handleKill(params, ctx);

					case "cleanup":
						return await handleCleanup(params, ctx);

					default:
						return errorResult(`Unknown action: ${action}`);
				}
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	});

	// ── Command: /worktree ─────────────────────────────────────────────

	pi.registerCommand("worktree", {
		description: "Inspect worktrees and agents: /worktree [list|status]",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "status" || sub === "") {
				const report = buildFullReport(ctx);
				ctx.ui.notify(report, "info");
			} else {
				ctx.ui.notify("Usage: /worktree [list|status]", "info");
			}
		},
	});

	// ── Track active worktree for status bar ───────────────────────────────

	let activeWorktree: { branch: string; path: string } | null = null;

	function updateWorktreeStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (activeWorktree) {
			ctx.ui.setStatus("worktree", `🌳 ${activeWorktree.branch}  ${activeWorktree.path}`);
		} else {
			ctx.ui.setStatus("worktree", undefined);
		}
	}

	// ── Cleanup on shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		killAllAgents();
	});

	// ── Action handlers ────────────────────────────────────────────────

	async function handleList(ctx: ExtensionContext) {
		const worktrees = listWorktrees(ctx.cwd);
		const managed = getManagedWorktrees(ctx.cwd);
		const agents = getAllAgents();

		if (worktrees.length === 0) {
			return textResult("No git worktrees found.");
		}

		const lines = ["# Worktrees", ""];
		for (const wt of worktrees) {
			const agent = agents.get(wt.branch);
			const managedEntry = managed.find((m) => m.branch === wt.branch);
			const tags: string[] = [];
			if (wt.isCurrent) tags.push("current");
			if (wt.isMain) tags.push("main");
			if (managedEntry) tags.push("pi-owned");
			if (agent) tags.push(`agent:${agent.status.state}`);

			lines.push(`- ${wt.branch} ${tags.length ? `[${tags.join(", ")}]` : ""}`);
			lines.push(`  path: ${wt.path}`);
			if (managedEntry) {
				lines.push(`  purpose: ${managedEntry.purpose}`);
			}
			if (agent) {
				lines.push(`  agent: pid=${agent.pid} turns=${agent.status.turnCount} cost=$${agent.status.totalCost.toFixed(4)}`);
			}
		}

		return textResult(lines.join("\n"));
	}

	async function handleCreate(
		params: { branch?: string; purpose?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		const purpose = params.purpose?.trim();
		if (!branch) return errorResult("branch is required");
		if (!purpose) return errorResult("purpose is required (so we can track and clean up)");

		const result = createWorktree(ctx.cwd, branch, purpose);
		activeWorktree = { branch, path: result.path };
		updateWorktreeStatus(ctx);
		return textResult(
			`Created worktree for "${result.branch}" at ${result.path}\n` +
			`Branch was ${result.created ? "created" : "already existed"}.\n` +
			`Path: ${result.path}`,
		);
	}

	async function handleSpawn(
		params: { branch?: string; purpose?: string },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");

		onUpdate({
			content: [{ type: "text", text: `Spawning agent in worktree "${branch}"...` }],
			details: { branch, state: "spawning" },
		});

		const client = await spawnAgent(ctx.cwd, branch, params.purpose?.trim() ?? "general");

		return textResult(
			`Agent spawned in "${branch}" (pid ${client.pid})\n` +
			`Path: ${client.worktreePath}\n` +
			`Use action "send" with a message to give it tasks.`,
		);
	}

	async function handleSend(
		params: { branch?: string; message?: string },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const branch = params.branch?.trim();
		const message = params.message?.trim();
		if (!branch) return errorResult("branch is required");
		if (!message) return errorResult("message is required");

		// Find or spawn agent
		let client = getAgent(branch);
		if (!client) {
			// Auto-spawn if worktree exists but no agent
			const worktrees = listWorktrees(ctx.cwd);
			const wt = worktrees.find((w) => w.branch === branch);
			if (!wt) return errorResult(`No worktree for branch "${branch}". Use "create" first.`);



			onUpdate({
				content: [{ type: "text", text: `Spawning agent for "${branch}"...` }],
				details: { branch, state: "spawning" },
			});

			client = await spawnAgent(ctx.cwd, branch, "auto-spawned");
		}

		onUpdate({
			content: [{ type: "text", text: `Sending to "${branch}": ${message.slice(0, 80)}...` }],
			details: { branch, state: "sending" },
		});

		// Send prompt to worktree agent
		await client.prompt(message);

		// Wait a beat for agent_end, collect response
		const response = await collectResponse(client);

		return textResult(
			`# Response from "${branch}"\n\n${response}`,
		);
	}

	async function handleStatus(
		params: { branch?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		const agents = getAllAgents();

		if (branch) {
			const client = agents.get(branch);
			if (!client) return textResult(`No active agent for "${branch}".`);
			return textResult(formatAgentStatus(branch, client));
		}

		if (agents.size === 0) return textResult("No active worktree agents.");

		const lines = ["# Active Worktree Agents", ""];
		for (const [b, client] of agents) {
			lines.push(formatAgentStatus(b, client));
			lines.push("");
		}
		return textResult(lines.join("\n"));
	}

	async function handleKill(
		params: { branch?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");

		const client = getAgent(branch);
		if (!client) return textResult(`No active agent for "${branch}".`);

		killAgent(branch);
		return textResult(`Killed agent for "${branch}" (pid ${client.pid}).`);
	}

	async function handleCleanup(
		params: { branch?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");



		killAgent(branch);

		// Remove worktree
		removeWorktree(ctx.cwd, branch);
		if (activeWorktree?.branch === branch) {
			activeWorktree = null;
			updateWorktreeStatus(ctx);
		}
		return textResult(`Removed worktree "${branch}" and cleaned up.`);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

function formatAgentStatus(branch: string, client: NonNullable<ReturnType<typeof getAgent>>): string {
	const s = client.status;
	return [
		`## ${branch}`,
		`- State: ${s.state}`,
		`- PID: ${client.pid}`,
		`- Path: ${client.worktreePath}`,
		`- Purpose: ${client.purpose}`,
		`- Turns: ${s.turnCount}`,
		`- Cost: $${s.totalCost.toFixed(4)}`,
		s.error ? `- Error: ${s.error}` : null,
	].filter(Boolean).join("\n");
}

function buildFullReport(ctx: ExtensionContext): string {
	const worktrees = listWorktrees(ctx.cwd);
	const managed = getManagedWorktrees(ctx.cwd);
	const agents = getAllAgents();
	const repoRoot = getRepoRoot(ctx.cwd);

	const lines = [
		"# Worktree Status",
		`Repo: ${repoRoot ?? "unknown"}`,
		`Worktrees: ${worktrees.length} (${managed.length} pi-owned)`,
		`Active agents: ${agents.size}`,
		"",
	];

	for (const [branch, client] of agents) {
		lines.push(formatAgentStatus(branch, client), "");
	}

	return lines.join("\n");
}

async function collectResponse(client: NonNullable<ReturnType<typeof getAgent>>): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		let settled = false;

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				client.onEvent(() => {}); // no-op cleanup
				resolve(text || "(timed out waiting for response)");
			}
		}, 120_000); // 2 min timeout

		const unsub = client.onEvent((event) => {
			// Collect streaming text
			if (event.type === "message_update") {
				const delta = (event as any).assistantMessageEvent;
				if (delta?.type === "text_delta" && delta?.delta) {
					text += delta.delta;
				}
			}

			// Agent finished
			if (event.type === "agent_end") {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					unsub();
					// If we didn't collect streaming text, get it from the messages
					if (!text) {
						const msgs = (event as any).messages ?? [];
						const lastAssistant = msgs
							.filter((m: any) => m.role === "assistant")
							.pop();
						if (lastAssistant?.content) {
							text = lastAssistant.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
						}
					}
					resolve(text || "(empty response)");
				}
			}
		});
	});
}
