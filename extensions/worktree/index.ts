/**
 * Worktree extension — git worktree management with transparent RPC proxy.
 *
 * When the user creates a worktree, we spawn a headless `pi --mode rpc`
 * subprocess in the worktree directory. The main session proxies prompts
 * through it, so all file operations, builds, tests, and git commands
 * run with the correct working directory automatically.
 *
 * The user keeps full control — they see output in the main TUI, can
 * send follow-up messages, and the worktree agent is just a transparent
 * execution context with the right cwd.
 *
 * Tool: worktree
 *   - create:  create worktree + spawn RPC agent → returns ready
 *   - list:    show all worktrees
 *   - cleanup: remove worktree + kill agent
 *
 * The system prompt is injected so the main agent knows to proxy through
 * the worktree agent for all operations.
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

	// ── System prompt ──

	pi.on("before_agent_start", async (event) => {
		const wtNote = activeWorktree
			? `\n\n**ACTIVE WORKTREE: ${activeWorktree.branch}**\n` +
			  `A worktree RPC agent is running at ${activeWorktree.path}.\n` +
			  `For ALL file operations (read, write, edit, bash), use the worktree tool:\n` +
			  `  worktree({ action: "run", command: "<your bash command>" })\n` +
			  `  worktree({ action: "run", command: "go build ./..." })\n` +
			  `  worktree({ action: "run", command: "git status" })\n` +
			  `This runs the command in the worktree with the correct working directory.\n` +
			  `For read/write/edit tools, use the absolute path: ${activeWorktree.path}/<file>`
			: "";

		event.systemPrompt += `

## worktree extension

You have a \`worktree\` tool for git worktree management.

Usage:
- \`worktree({ action: "list" })\` — show all worktrees
- \`worktree({ action: "create", branch: "feat/auth", purpose: "Add auth" })\` — create worktree + start agent
- \`worktree({ action: "run", command: "go build ./..." })\` — run a command in the active worktree
- \`worktree({ action: "cleanup", branch: "feat/auth" })\` — remove worktree + kill agent

When working in a worktree:
- Use \`worktree({ action: "run", command: "..." })\` for bash commands (builds, tests, git)
- Use the worktree path for read/write/edit tools
- The worktree agent has the correct cwd — relative paths work
${wtNote}
`;
	});

	// ── Tool: worktree ─────────────────────────────────────────────────

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Manage git worktrees and run commands in them. Actions: " +
			"list, create (new worktree + spawn RPC agent), " +
			"run (execute a bash command in the active worktree), " +
			"cleanup (remove worktree + kill agent).",
		parameters: Type.Object({
			action: StringEnum(["list", "create", "run", "cleanup"] as const, {
				description: "Action to perform",
			}),
			branch: Type.Optional(Type.String({
				description: "Branch name (required for create and cleanup)",
			})),
			purpose: Type.Optional(Type.String({
				description: "Why this worktree exists (required for create)",
			})),
			command: Type.Optional(Type.String({
				description: "Bash command to run in the worktree (required for run)",
			})),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			try {
				switch (params.action) {
					case "list":
						return handleList(ctx);
					case "create":
						return await handleCreate(params, ctx, onUpdate);
					case "run":
						return await handleRun(params, ctx, onUpdate);
					case "cleanup":
						return await handleCleanup(params, ctx);
					default:
						return errorResult(`Unknown action: ${params.action}`);
				}
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	});

	// ── Command: /worktree ─────────────────────────────────────────────

	pi.registerCommand("worktree", {
		description: "Show worktree status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildReport(ctx), "info");
		},
	});

	// ── Track active worktree ──────────────────────────────────────────

	let activeWorktree: { branch: string; path: string } | null = null;

	function updateWorktreeStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (activeWorktree) {
			ctx.ui.setWidget("worktree", [
				`📂 Worktree: ${activeWorktree.branch}`,
				`   ${activeWorktree.path}`,
			], { placement: "aboveEditor" });
		} else {
			ctx.ui.setWidget("worktree", undefined);
		}
	}

	// ── Cleanup on shutdown ────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		killAllAgents();
	});

	// ── Action handlers ────────────────────────────────────────────────

	function handleList(ctx: ExtensionContext) {
		const worktrees = listWorktrees(ctx.cwd);
		const managed = getManagedWorktrees(ctx.cwd);

		if (worktrees.length === 0) {
			return textResult("No git worktrees found.");
		}

		const lines = ["# Worktrees", ""];
		for (const wt of worktrees) {
			const managedEntry = managed.find((m) => m.branch === wt.branch);
			const isActive = activeWorktree?.branch === wt.branch;
			const tags: string[] = [];
			if (wt.isCurrent) tags.push("current");
			if (wt.isMain) tags.push("main");
			if (managedEntry) tags.push("pi-owned");
			if (isActive) tags.push("active");

			lines.push(`- ${wt.branch} ${tags.length ? `[${tags.join(", ")}]` : ""}`);
			lines.push(`  path: ${wt.path}`);
			if (managedEntry) {
				lines.push(`  purpose: ${managedEntry.purpose}`);
			}
		}

		return textResult(lines.join("\n"));
	}

	async function handleCreate(
		params: { branch?: string; purpose?: string },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const branch = params.branch?.trim();
		const purpose = params.purpose?.trim();
		if (!branch) return errorResult("branch is required");
		if (!purpose) return errorResult("purpose is required");

		// Create the git worktree
		const result = createWorktree(ctx.cwd, branch, purpose);

		onUpdate({
			content: [{ type: "text", text: `Starting agent in worktree "${branch}"...` }],
			details: { branch, state: "spawning" },
		});

		// Spawn RPC agent in the worktree
		await spawnAgent(ctx.cwd, branch, purpose);
		const client = getAgent(branch);

		activeWorktree = { branch, path: result.path };
		updateWorktreeStatus(ctx);

		const pidNote = client ? ` (pid ${client.pid})` : "";
		return textResult(
			`Worktree "${result.branch}" ready${pidNote}.\n` +
			`Path: ${result.path}\n\n` +
			`RPC agent running in worktree. Use:\n` +
			`  worktree({ action: "run", command: "go build ./..." })\n` +
			`to run any command with the correct working directory.`,
		);
	}

	async function handleRun(
		params: { command?: string },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const command = params.command?.trim();
		if (!command) return errorResult("command is required");
		if (!activeWorktree) return errorResult("No active worktree. Use create first.");

		const branch = activeWorktree.branch;
		let client = getAgent(branch);

		if (!client) {
			return errorResult(`Worktree agent for "${branch}" is not running. Create the worktree first.`);
		}

		onUpdate({
			content: [{ type: "text", text: `$ ${command}` }],
			details: { branch, state: "running", command },
		});

		// Send command as a prompt to the worktree agent
		// The agent will use bash tool to execute it
		const prompt = `Run this bash command and show the output: ${command}`;

		await client.prompt(prompt);

		// Collect the response
		const response = await collectResponse(client);

		return textResult(
			`# ${command}\n\n${response}`,
		);
	}

	async function handleCleanup(
		params: { branch?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");

		killAgent(branch);
		removeWorktree(ctx.cwd, branch);

		if (activeWorktree?.branch === branch) {
			activeWorktree = null;
			updateWorktreeStatus(ctx);
		}

		return textResult(`Removed worktree "${branch}".`);
	}

	// ── Helpers ────────────────────────────────────────────────────────

	function buildReport(ctx: ExtensionContext): string {
		const worktrees = listWorktrees(ctx.cwd);
		const managed = getManagedWorktrees(ctx.cwd);
		const agents = getAllAgents();
		const repoRoot = getRepoRoot(ctx.cwd);

		if (worktrees.length === 0) {
			return `No worktrees. Repo: ${repoRoot ?? "unknown"}`;
		}

		const lines = [
			`Worktrees (${worktrees.length}, ${managed.length} pi-owned)`,
			`Repo: ${repoRoot ?? "unknown"}`,
			"",
		];

		for (const wt of worktrees) {
			const managedEntry = managed.find((m) => m.branch === wt.branch);
			const agent = agents.get(wt.branch);
			const isActive = activeWorktree?.branch === wt.branch;
			const tags: string[] = [];
			if (isActive) tags.push("active");
			if (managedEntry) tags.push("pi-owned");
			if (agent) tags.push(`agent:${agent.status.state}`);

			lines.push(`  ${wt.branch}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
			lines.push(`    ${wt.path}`);
			if (managedEntry) lines.push(`    purpose: ${managedEntry.purpose}`);
		}

		return lines.join("\n");
	}
}

// ─── Shared helpers ────────────────────────────────────────────────────

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

async function collectResponse(client: NonNullable<ReturnType<typeof getAgent>>): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		let settled = false;

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				client.onEvent(() => {});
				resolve(text || "(timed out)");
			}
		}, 120_000);

		const unsub = client.onEvent((event) => {
			if (event.type === "message_update") {
				const delta = (event as any).assistantMessageEvent;
				if (delta?.type === "text_delta" && delta?.delta) {
					text += delta.delta;
				}
			}

			if (event.type === "agent_end") {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					unsub();
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
