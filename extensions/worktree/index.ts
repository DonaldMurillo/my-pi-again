/**
 * Worktree extension — git worktree management.
 *
 * Simple model: create a worktree, get back a path, work in it from this session.
 * No headless agents, no black boxes. The agent uses the worktree path directly
 * in read/write/edit/bash tools — same session, same conversation, full control.
 *
 * Tool: worktree
 *   - create: create a worktree, returns the absolute path
 *   - list:   show all worktrees with paths and status
 *   - cleanup: remove a worktree
 *
 * Command: /worktree [list]
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, StringEnum } from "@mariozechner/pi-ai";
import {
	createWorktree,
	removeWorktree,
	getManagedWorktrees,
	listWorktrees,
	getRepoRoot,
} from "./worktree-manager.js";

export default function (pi: ExtensionAPI): void {

	// ── System prompt guidance ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## worktree extension

You have a \`worktree\` tool for git worktree management.

Usage:
- \`worktree({ action: "list" })\` — show all worktrees with their paths
- \`worktree({ action: "create", branch: "feat/auth", purpose: "Add auth" })\` — create worktree
- \`worktree({ action: "cleanup", branch: "feat/auth" })\` — remove worktree

When the user asks to "work in" or "move to" a worktree, create it and then use the
returned path for ALL subsequent file operations. The path is absolute — use it as:
- The \`path\` argument in read/write/edit tools
- \`cd <path> && <command>\` in bash for builds, tests, git operations
- The base for any relative paths within the worktree

You work in the worktree directly from THIS session. No separate agent needed.
`;
	});

	// ── Tool: worktree ─────────────────────────────────────────────────

	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Manage git worktrees. Actions: " +
			"list (show all worktrees), " +
			"create (new worktree for a branch), " +
			"cleanup (remove worktree). " +
			"Create returns an absolute path — use it directly in read/write/edit/bash to work in the worktree.",
		parameters: Type.Object({
			action: StringEnum(["list", "create", "cleanup"] as const, {
				description: "Action to perform",
			}),
			branch: Type.Optional(Type.String({
				description: "Branch name (required for create and cleanup)",
			})),
			purpose: Type.Optional(Type.String({
				description: "Why this worktree exists (required for create)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				switch (params.action) {
					case "list":
						return handleList(ctx);
					case "create":
						return handleCreate(params, ctx);
					case "cleanup":
						return handleCleanup(params, ctx);
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
		description: "List worktrees: /worktree",
		handler: async (_args, ctx) => {
			const report = buildReport(ctx);
			ctx.ui.notify(report, "info");
		},
	});

	// ── Track active worktree for status bar ────────────────────────────

	let activeWorktree: { branch: string; path: string } | null = null;

	function updateWorktreeStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (activeWorktree) {
			ctx.ui.setStatus("worktree", `🌳 ${activeWorktree.branch}  ${activeWorktree.path}`);
		} else {
			ctx.ui.setStatus("worktree", undefined);
		}
	}

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
			const tags: string[] = [];
			if (wt.isCurrent) tags.push("current");
			if (wt.isMain) tags.push("main");
			if (managedEntry) tags.push("pi-owned");

			lines.push(`- ${wt.branch} ${tags.length ? `[${tags.join(", ")}]` : ""}`);
			lines.push(`  path: ${wt.path}`);
			if (managedEntry) {
				lines.push(`  purpose: ${managedEntry.purpose}`);
			}
		}

		return textResult(lines.join("\n"));
	}

	function handleCreate(
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
			`Created worktree for "${result.branch}" at:\n${result.path}\n\n` +
			`Branch was ${result.created ? "created" : "already existed"}.\n` +
			`Use this path for all file operations.`,
		);
	}

	function handleCleanup(
		params: { branch?: string },
		ctx: ExtensionContext,
	) {
		const branch = params.branch?.trim();
		if (!branch) return errorResult("branch is required");

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
			const active = activeWorktree?.branch === wt.branch ? " ← active" : "";
			lines.push(`  ${wt.branch}${active}`);
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
