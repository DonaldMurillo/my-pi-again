/**
 * Worktree extension — git worktree management with headless agent orchestration.
 *
 * Provides:
 *   - `worktree` tool — agent can create/list/spawn/send/cleanup worktrees
 *   - /worktree command — user can inspect and manage worktrees
 *   - RPC agent pool — persistent pi subprocess per worktree for autonomous work
 *   - Main session coordinates all active worktree agents
 *
 * Safety: Creating worktrees and spawning agents require user confirmation
 * since they consume disk space and API tokens.
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

		// Ask permission — worktrees cost disk space
		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Create worktree?",
				`Create git worktree for branch "${branch}"?\nPurpose: ${purpose}`,
			);
			if (!confirmed) return textResult("User declined worktree creation.");
		}

		const result = createWorktree(ctx.cwd, branch, purpose);
		return textResult(
			`Created worktree for "${result.branch}" at ${result.path}\n` +
			`Branch was ${result.created ? "created" : "already existed"}.\n` +
			`Use action "spawn" to start an agent, or "send" to send tasks.`,
		);
	}

	async function handleSpawn(
		params: { branch?: string; purpose?: string },
		ctx: ExtensionContext,
		onUpdate: (update: { content: Array<{ type: string; text: string }>; details: unknown }) => void,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");

		// Ask permission — agents cost API tokens
		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Spawn worktree agent?",
				`Start a headless pi agent in worktree "${branch}"?\nThis will consume API tokens for all work the agent does.`,
			);
			if (!confirmed) return textResult("User declined agent spawn.");
		}

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

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Auto-spawn agent?",
					`No agent running for "${branch}". Spawn one?`,
				);
				if (!confirmed) return textResult("User declined auto-spawn.");
			}

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

		if (ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Remove worktree?",
				`Remove worktree "${branch}" and kill its agent? Uncommitted changes may be lost.`,
			);
			if (!confirmed) return textResult("User declined cleanup.");
		}

		// Kill agent first
		killAgent(branch);

		// Remove worktree
		removeWorktree(ctx.cwd, branch);
		return textResult(`Removed worktree "${branch}" and cleaned up.`);
	}

	// ── Test harness: /test-worktree ─────────────────────────────────────

	const TEST_BRANCH = "test-worktree-e2e";

	async function testCleanup(ctx2: ExtensionContext, results: Array<{ step: string; pass: boolean; detail: string; ms: number }>) {
		const t0 = Date.now();
		try {
			killAgent(TEST_BRANCH);
			removeWorktree(ctx2.cwd, TEST_BRANCH);
			results.push({ step: "cleanup", pass: true, detail: "Worktree removed", ms: Date.now() - t0 });
		} catch (err) {
			results.push({ step: "cleanup", pass: false, detail: String(err), ms: Date.now() - t0 });
		}
	}

	function testCollect(client2: NonNullable<ReturnType<typeof getAgent>>, timeoutMs: number): Promise<string> {
		return new Promise((resolve) => {
			let text = "";
			let done = false;
			const timer = setTimeout(() => { if (!done) { done = true; resolve(text || "(timed out)"); } }, timeoutMs);
			const unsub = client2.onEvent((event) => {
				if (event.type === "message_update") {
					const d = (event as any).assistantMessageEvent;
					if (d?.type === "text_delta" && d?.delta) text += d.delta;
				}
				if (event.type === "agent_end") {
					if (!done) {
						done = true; clearTimeout(timer); unsub();
						if (!text) {
							const msgs = (event as any).messages ?? [];
							const last = msgs.filter((m: any) => m.role === "assistant").pop();
							if (last?.content) text = last.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
						}
						resolve(text || "(empty)");
					}
				}
			});
		});
	}

	pi.registerCommand("test-worktree", {
		description: "E2E test: /test-worktree [quick|spawn|full]",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase() || "full";
			const results: Array<{ step: string; pass: boolean; detail: string; ms: number }> = [];
			const totalStart = Date.now();

			const log = (step: string, pass: boolean, detail: string) => {
				results.push({ step, pass, detail, ms: 0 });
				ctx.ui.notify(`${pass ? "✅" : "❌"} ${step} — ${detail}`, pass ? "info" : "error");
			};

			// Preflight
			const root = getRepoRoot(ctx.cwd);
			if (!root) { log("preflight", false, "Not in git repo"); return; }
			log("preflight", true, `Repo: ${root}`);

			// Cleanup leftover
			try { killAgent(TEST_BRANCH); } catch {}
			try { const m = getManagedWorktrees(ctx.cwd); if (m.find((w) => w.branch === TEST_BRANCH)) removeWorktree(ctx.cwd, TEST_BRANCH); } catch {}
			log("clean-slate", true, "Ready");

			// Create
			try {
				const r = createWorktree(ctx.cwd, TEST_BRANCH, "E2E test");
				log("create", true, `${r.path} (new=${r.created})`);
			} catch (err) { log("create", false, String(err)); return; }

			// List
			const wts = listWorktrees(ctx.cwd);
			const found = wts.find((w) => w.branch === TEST_BRANCH);
			log("list", !!found, `${wts.length} worktrees, test=${found?.path ?? "not found"}`);

			if (mode === "quick") {
				await testCleanup(ctx, results);
				ctx.ui.notify(`\n${"═".repeat(40)}\n${results.map((r) => `${r.pass ? "✅" : "❌"} ${r.step}`).join("\n")}\n${"═".repeat(40)}`, "info");
				return;
			}

			// Spawn
			try {
				ctx.ui.notify("Spawning headless agent...", "info");
				const client = await spawnAgent(ctx.cwd, TEST_BRANCH, "E2E test");
				log("spawn", !!client.pid, `PID=${client.pid} state=${client.status.state}`);
			} catch (err) { log("spawn", false, String(err)); await testCleanup(ctx, results); return; }

			if (mode === "spawn") {
				ctx.ui.notify(`Agent alive for "${TEST_BRANCH}". Run /test-worktree to full test or cleanup manually.`, "info");
				return;
			}

			// Send task
			try {
				const client = getAgent(TEST_BRANCH)!;
				ctx.ui.notify("Sending test task...", "info");
				const resp = await client.prompt("Respond with exactly: WORKTREE_TEST_OK");
				log("send", resp.success, `success=${resp.success}`);
			} catch (err) { log("send", false, String(err)); await testCleanup(ctx, results); return; }

			// Collect response
			try {
				const client = getAgent(TEST_BRANCH)!;
				ctx.ui.notify("Waiting for agent response...", "info");
				const text = await testCollect(client, 60_000);
				const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
				log("collect", text.length > 0, `"${preview}"`);
			} catch (err) { log("collect", false, String(err)); }

			// Status
			const client = getAgent(TEST_BRANCH);
			if (client) {
				const s = client.status;
				log("status", s.state === "idle", `state=${s.state} turns=${s.turnCount} cost=$${s.totalCost.toFixed(4)}`);
			}

			// Cleanup
			await testCleanup(ctx, results);

			const passed = results.filter((r) => r.pass).length;
			const failed = results.filter((r) => !r.pass).length;
			ctx.ui.notify(
				`\n${"═".repeat(40)}\n` +
				`Worktree E2E: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""} (${Date.now() - totalStart}ms)\n` +
				`${"─".repeat(40)}\n` +
				results.map((r) => `${r.pass ? "✅" : "❌"} ${r.step} — ${r.detail}`).join("\n") +
				`\n${"═".repeat(40)}`,
				failed > 0 ? "warning" : "info",
			);
		},
	});
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
