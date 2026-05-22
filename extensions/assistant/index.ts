/**
 * Interactive Assistant Extension
 *
 * Commands:
 *   /assistant           -- open modal (or ask to activate if not yet)
 *   /assistant activate  -- activate the assistant system
 *   /assistant deactivate -- deactivate
 *
 * Tools:
 *   activate_assistant    -- agent-initiated activation + modal open
 *   send_assistant_context -- agent sends context to the assistant
 *
 * "Are We There Yet" assistant:
 *   On agent_end, reads full conversation + files, evaluates if goal is met.
 *   If gaps found, auto-reprompts the main agent via pi.sendUserMessage().
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { truncateToWidth } from "../shared/text.js";
import type { AssistantState } from "./types.js";
import {
	createInitialState,
	getSelectedAssistant,
	addMessage,
	persistState,
	loadPersistedState,
} from "./state.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import {
	generateResponse,
	generateAgentReview,
	generateAreWeThereYet,
	resolveLLMConfig,
} from "./llm.js";
import { openAssistantModal } from "./modal.js";

// --- Shared state ---

let _ctx: ExtensionContext | null = null;
let _state: AssistantState | null = null;
let _modalRender: (() => void) | null = null;

function getState(): AssistantState {
	if (!_state) throw new Error("assistant: not initialized");
	return _state;
}

// --- File snapshot extraction ---

const MAX_FILE_BYTES = 50_000;

function tryParseJSON(str: string): any {
	try { return JSON.parse(str); } catch { return null; }
}

/** Detect actual working directory from tool call paths.
 *  When agent works in a worktree, ctx.cwd is still the original project.
 *  We infer the real cwd from the paths used in write/edit/bash tool calls. */
function detectEffectiveCwd(agentMessages: any[], fallbackCwd: string): string {
	let longestPrefix = "";
	for (const msg of agentMessages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c.type === "tool_use" && (c.name === "write" || c.name === "edit" || c.name === "bash") && c.input) {
					const p = c.input.path as string | undefined;
					if (p && p.startsWith("/")) {
						// Check if this path shares a common prefix with existing paths
						if (p.length > longestPrefix.length) {
							// Simple heuristic: extract directory part
							const lastSlash = p.lastIndexOf("/");
							if (lastSlash > 0) {
								const dir = p.slice(0, lastSlash);
								if (dir.length > longestPrefix.length) longestPrefix = dir;
							}
						}
					}
				}
			}
		}
	}
	// If we found paths outside fallbackCwd, use the deepest common ancestor
	if (longestPrefix && !longestPrefix.startsWith(fallbackCwd)) {
		return longestPrefix;
	}
	return fallbackCwd;
}

function extractFileSnapshot(agentMessages: any[], cwd: string): string {
	const filePaths = new Set<string>();

	// Pass 1: extract from tool calls and results in messages
	for (const msg of agentMessages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const args = typeof block.arguments === "string"
						? tryParseJSON(block.arguments)
						: block.arguments;
					if (args && typeof args === "object") {
						extractPathsFromArgs(args, filePaths);
					}
				}
				if (block.type === "text" && typeof block.text === "string") {
					for (const m of block.text.matchAll(/(?:^|\n)(\S+\.\w{1,10})(?::|\s)/gm)) {
						if (m[1] && !m[1].startsWith("http")) filePaths.add(m[1]);
					}
				}
			}
		}
		if (msg.role === "toolResult") {
			if (msg.details?.path) filePaths.add(String(msg.details.path));
			if (msg.details?.displayPath) filePaths.add(String(msg.details.displayPath));
			if (Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c.type === "text" && typeof c.text === "string") {
						for (const m of c.text.matchAll(/([\w./_-]+\/[^\s:]+\.[a-z]{1,10})/gi)) {
							const p = m[1];
							if (p && !p.startsWith("http")) filePaths.add(p);
						}
					}
				}
			}
		}
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c.type === "text" && typeof c.text === "string") {
					for (const m of c.text.matchAll(/([\w./_-]+\/[^\s:]+\.[a-z]{1,10})/gi)) {
						const p = m[1];
						if (p && !p.startsWith("http")) filePaths.add(p);
					}
				}
			}
		}
	}

	// Pass 2: ALWAYS also include git-changed files
	try {
		const { execSync } = require("node:child_process");
		const changed = execSync(
			"git diff --name-only HEAD~1 2>/dev/null; git diff --name-only 2>/dev/null; git diff --name-only --cached 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null",
			{ cwd, encoding: "utf8", timeout: 5000 },
		).trim().split("\n").filter(Boolean);
		for (const f of changed) {
			if (f.trim()) filePaths.add(f.trim());
		}
	} catch { /* not a git repo */ }

	let totalBytes = 0;
	const parts: string[] = [];
	const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".map", ".lock"];

	// Git diff summary
	try {
		const { execSync } = require("node:child_process");
		const diff = execSync("git diff --stat HEAD~1 2>/dev/null; git diff --stat 2>/dev/null", {
			cwd, encoding: "utf8", timeout: 5000,
		}).trim();
		if (diff) {
			parts.push(`=== Recent changes (git diff --stat) ===\n${diff}`);
			totalBytes += diff.length;
		}
	} catch { /* no git */ }

	for (const rawPath of filePaths) {
		if (totalBytes >= MAX_FILE_BYTES) break;
		try {
			const resolved = rawPath.startsWith("/") ? rawPath : join(cwd, rawPath);
			if (!existsSync(resolved)) { parts.push(`--- ${rawPath} (FILE NOT FOUND) ---`); continue; }
			if (statSync(resolved).isDirectory()) continue;
			if (binaryExts.includes(extname(resolved).toLowerCase())) continue;
			const content = readFileSync(resolved, "utf8");
			const truncated = content.length > 5000 ? content.slice(0, 5000) + "\n... (truncated)" : content;
			parts.push(`--- ${resolved} ---\n${truncated}`);
			totalBytes += truncated.length;
		} catch { /* skip */ }
	}

	// Project directory listing so evaluator knows the layout
	try {
		const { execSync } = require("node:child_process");
		const listing = execSync(
			"find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.tmp/*' -not -name '*.lock' | head -100",
			{ cwd, encoding: "utf8", timeout: 5000 },
		).trim();
		if (listing) {
			parts.unshift(`=== Project structure (${cwd}) ===\n${listing}`);
		}
	} catch { /* no listing available */ }

	return parts.length > 0 ? parts.join("\n\n") : "(no files could be read)";
}

function extractPathsFromArgs(args: Record<string, any>, paths: Set<string>): void {
	const pathKeys = ["path", "file_path", "filePath", "filename", "dest", "destination"];
	for (const key of pathKeys) {
		if (typeof args[key] === "string" && args[key].length > 0) {
			paths.add(args[key]);
		}
	}
	for (const val of Object.values(args)) {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			extractPathsFromArgs(val as Record<string, any>, paths);
		}
	}
}

// --- Widget + status ---

function updateStatusLine(state: AssistantState, ctx: ExtensionContext): void {
	if (!state.activated) {
		ctx.ui.setWidget("assistant", undefined);
		return;
	}
	const profile = getSelectedAssistant(state);
	if (!profile) {
		ctx.ui.setWidget("assistant", undefined);
		return;
	}

	const activityLabel: Record<string, string> = {
		idle: "idle",
		thinking: "thinking...",
		reading: "reading...",
	};
	const activity = activityLabel[state.activity] ?? "idle";
	const name = profile.name;

	ctx.ui.setWidget("assistant", (_tui: any, theme: any) => {
		const lines: string[] = [];
		lines.push(theme.fg("accent", theme.bold(`assistant: ${name}`)));
		lines.push(theme.fg("muted", `  ${activity}`));
			return {
			render(width: number): string[] { return lines.map((l) => truncateToWidth(l, width)); },
			invalidate() {},
		};
	}, { placement: "belowEditor" });
}

function clearStatusLine(ctx: ExtensionContext): void {
	ctx.ui.setWidget("assistant", undefined);
}

// --- Modal helper ---

function openModal(ctx: ExtensionContext, state: AssistantState): void {
	const handle = openAssistantModal(ctx, state, {
		onUserMessage(text) {
			const profile = getSelectedAssistant(state);
			if (!profile) return;
			addMessage(state, "user", text);
			state.activity = "thinking";
			updateStatusLine(state, ctx);
			const llmConfig = resolveLLMConfig(state.config, ctx);
			generateResponse(profile, state.messages, text, ctx, llmConfig)
				.then((response) => {
					addMessage(state, "assistant", response);
					state.activity = "idle";
					updateStatusLine(state, ctx);
					persistState(state, ctx.cwd);
					handle.requestRender();
				})
				.catch((err) => {
					addMessage(state, "assistant", `(Error: ${err.message})`);
					state.activity = "idle";
					updateStatusLine(state, ctx);
					persistState(state, ctx.cwd);
					handle.requestRender();
				});
		},
		onSelectAssistant(id) {
			state.config.selectedAssistantId = id;
			persistState(state, ctx.cwd);
		},
		onClose() {
			_modalRender = null;
			persistState(state, ctx.cwd);
		},
	});
	_modalRender = handle.requestRender;
}

function refreshModal(): void {
	_modalRender?.();
}

// --- Utility ---

function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return hash.toString(36);
}

function findPersistentGaps(history: Array<{ gaps: string[]; wasFallback: boolean }>): string[] {
	if (history.length < 2) return [];
	const recent = history.slice(-5);
	const gapCounts = new Map<string, number>();
	for (const eval_ of recent) {
		if (eval_.wasFallback) continue;
		for (const gap of eval_.gaps) {
			const normalized = gap.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
			if (normalized.length < 5) continue;
			// Check for keyword overlap with existing gaps
			const words = new Set(normalized.split(" ").filter(w => w.length > 3));
			let matched = false;
			for (const [existing] of gapCounts) {
				const existingWords = new Set(existing.split(" ").filter(w => w.length > 3));
				const overlap = [...words].filter(w => existingWords.has(w)).length;
				if (overlap >= 2) {
					matched = true;
					gapCounts.set(existing, (gapCounts.get(existing) ?? 0) + 1);
					break;
				}
			}
			if (!matched) {
				gapCounts.set(normalized, 1);
			}
		}
	}
	return [...gapCounts.entries()]
		.filter(([, count]) => count >= 2)
		.map(([gap]) => gap);
}

// --- Extension ---

export default function (pi: ExtensionAPI) {

	pi.on("session_start", async (_e, ctx) => {
		_ctx = ctx;
		_state = createInitialState(ctx.cwd);
		loadPersistedState(_state, ctx.cwd);
		updateStatusLine(_state, ctx);
	});

	pi.on("session_shutdown", async () => {
		if (_state && _ctx) {
			_state.activated = false;
			_state.evalHistory = [];
			_state.lastSnapshotHash = "";
			_state.repromptCount = 0;
			persistState(_state, _ctx.cwd);
			clearStatusLine(_ctx);
		}
	});

	// --- Accumulate ALL agent turns into session history ---

	pi.on("agent_end", async (event, _ctx) => {
		const state = _state;
		if (!state) return;
		const msgs = event.messages ?? [];
		for (const m of msgs) {
			if (m.role === "user" || m.role === "assistant") {
				const text = (m.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n").trim();
				if (text) {
					state.sessionHistory.push({ role: m.role, text });
				}
			}
		}
		if (state.sessionHistory.length > 200) {
			state.sessionHistory = state.sessionHistory.slice(-200);
		}
	});

	// --- agent_end: assistant evaluates and optionally reprompts ---

	let evalInProgress = false;

	pi.on("agent_end", async (event, ctx) => {
		const state = _state;
		if (!state?.activated) return;
		const profile = getSelectedAssistant(state);
		if (!profile) return;

		// Guard: skip if already evaluating or this is our own reprompt
		const agentMessages = event.messages ?? [];
		const userMsg = agentMessages.find((m: any) => m.role === "user");
		const userText = (userMsg?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
		if (evalInProgress || userText.includes("Are We There Yet evaluation found")) return;

		const lastAssistant = agentMessages
			.filter((m: any) => m.role === "assistant")
			.pop() as any;
		if (!lastAssistant) return;

		const agentText = lastAssistant.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? "";
		if (!agentText.trim()) return;

		const llmConfig = resolveLLMConfig(state.config, ctx);

		// --- "Are We There Yet?" ---
		if (profile.id === "are-we-there-yet") {
			const fullConversation = state.sessionHistory
				.filter((h) => !h.text.includes("Are We There Yet evaluation found"))
				.map((h) => `${h.role}: ${h.text}`)
				.join("\n\n");

			const effectiveCwd = detectEffectiveCwd(agentMessages, ctx.cwd);
			const fileSnapshot = extractFileSnapshot(agentMessages, effectiveCwd);

			// --- Feature: detect no change since last eval ---
			const snapshotHash = hashString(fileSnapshot);
			if (snapshotHash === state.lastSnapshotHash && state.evalHistory.length > 0) {
				return; // nothing changed, skip eval
			}
			state.lastSnapshotHash = snapshotHash;

			evalInProgress = true;
			state.activity = "thinking";
			updateStatusLine(state, ctx);
			generateAreWeThereYet(profile, fullConversation, fileSnapshot, ctx, llmConfig, state.evalHistory)
				.then((result) => {
					evalInProgress = false;
					state.activity = "idle";
					updateStatusLine(state, ctx);

					// --- Feature: store eval memory ---
					state.evalHistory.push({
						round: state.evalHistory.length + 1,
						achieved: result.achieved,
						summary: result.summary,
						gaps: result.gaps,
						wasFallback: result.wasFallback,
						timestamp: Date.now(),
					});
					// Keep last 20 evals
					if (state.evalHistory.length > 20) {
						state.evalHistory = state.evalHistory.slice(-20);
					}

					addMessage(state, "assistant",
						`[Evaluation round ${state.evalHistory.length}] ${result.summary}` +
						(result.gaps.length > 0 ? `\n\nGaps:\n${result.gaps.map((g) => `- ${g}`).join("\n")}` : "") +
						(result.achieved ? "\n\nGoal achieved." : ""),
					);
					persistState(state, ctx.cwd);
					refreshModal();

					if (result.achieved) {
						state.repromptCount = 0;
						state.evalHistory = []; // reset for next task
						ctx.ui.notify(`Goal achieved. ${result.summary}`, "success");
						return;
					}

					// --- Feature: evaluator failure detection ---
					if (result.wasFallback) {
						const recentFallbacks = state.evalHistory.slice(-3).filter((e) => e.wasFallback).length;
						if (recentFallbacks >= 2) {
							// Evaluator LLM is returning garbage — don't reprompt the agent
							ctx.ui.notify(`Evaluator is getting unparseable responses from the LLM. Not reprompting.`, "warning");
							return;
						}
					}

					state.repromptCount++;

					// --- Feature: smarter reprompts based on round ---
					const round = state.repromptCount;
					const fixPrompt = result.fixes.length > 0
						? result.fixes.map((f: string, i: number) => `${i + 1}. ${f}`).join("\n")
						: result.gaps.map((g: string, i: number) => `${i + 1}. ${g}`).join("\n");

					let steerText: string;
					if (round <= 2) {
						steerText = `Are We There Yet evaluation found these gaps:\n${fixPrompt}\n\nFix all of the above. Be specific and thorough.`;
					} else if (round <= 5) {
						steerText = `Are We There Yet evaluation (round ${round}) found these gaps:\n${fixPrompt}\n\nFocus on the MOST IMPACTFUL fix first. Don't try to fix everything at once.`;
					} else if (round <= 10) {
						// Check for persistent gaps
						const persistentGaps = findPersistentGaps(state.evalHistory);
						const persistNote = persistentGaps.length > 0
							? `\n\nWARNING: These gaps have persisted across multiple rounds: ${persistentGaps.join(", ")}. Try a COMPLETELY DIFFERENT approach. Do not repeat what you already tried.`
							: "";
						steerText = `Are We There Yet evaluation (round ${round}) found these gaps:\n${fixPrompt}${persistNote}`;
					} else {
						steerText = `Are We There Yet evaluation (round ${round}). The task is taking many iterations.\nRemaining gaps:\n${fixPrompt}\n\nBreak this into the smallest possible independent pieces. Fix ONE thing at a time. Verify each fix before moving on.`;
					}

					ctx.ui.notify(`Not done yet (round ${round}). ${result.gaps.length} gaps found.`, "warning");
					pi.sendUserMessage(steerText, { deliverAs: "nextTurn" });
				})
				.catch((err) => {
					evalInProgress = false;
					state.activity = "idle";
					updateStatusLine(state, ctx);
					ctx.ui.notify(`Evaluation failed: ${err.message}`, "error");
				});
			return;
		}

		// --- All other assistants: simple review ---
		generateAgentReview(profile, agentText, ctx, llmConfig)
			.then((review) => {
				addMessage(state, "assistant", `[Agent Review]\n${review}`);
				persistState(state, ctx.cwd);
				refreshModal();
				ctx.ui.notify(
					`${profile.name}: ${review.slice(0, 120)}${review.length > 120 ? "..." : ""}`,
					"info",
				);
			})
			.catch(() => { /* best effort */ });
	});

	// --- Tool: activate_assistant ---

	pi.registerTool({
		name: "activate_assistant",
		label: "Activate Assistant",
		description:
			"Activate an interactive assistant for the user. Opens a modal overlay where " +
			"the user can chat with a personality-driven assistant. " +
			"Available: debugger, coder, reviewer, are-we-there-yet (+ custom in .pi/assistants/).",
		parameters: Type.Object({
			name: Type.String({
				description: "Assistant to select (e.g. 'debugger', 'coder', 'reviewer', 'are-we-there-yet')",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = getState();
			const profile = state.assistants.get(params.name);
			if (!profile) {
				return {
					content: [{ type: "text" as const, text: `Assistant not found: ${params.name}. Available: ${Array.from(state.assistants.keys()).join(", ")}` }],
					isError: true as const,
				};
			}

			state.activated = true;
			state.config.selectedAssistantId = params.name;
			state.activity = "idle";
			persistState(state, ctx.cwd);
			updateStatusLine(state, ctx);

			if (ctx.hasUI) openModal(ctx, state);

			return {
				content: [{ type: "text" as const, text: `Activated ${profile.name}.${ctx.hasUI ? " Modal opened." : ""}` }],
				details: { assistantName: profile.name, assistantId: profile.id },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("activate_assistant ")) +
				theme.fg("muted", args.name),
				0, 0,
			);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { assistantName: string } | undefined;
			if (!details) return new Text(theme.fg("success", "Assistant activated"), 0, 0);
			return new Text(theme.fg("success", `${details.assistantName} activated`), 0, 0);
		},
	});

	// --- Tool: send_assistant_context ---

	pi.registerTool({
		name: "send_assistant_context",
		label: "Send Context to Assistant",
		description:
			"Send extra context or information to the active assistant. " +
			"Use this to provide the assistant with relevant information it wouldn't otherwise have, " +
			"such as file contents, error output, or background about the current task. " +
			"The assistant will receive this as a system-context message and can use it in its next response.",
		parameters: Type.Object({
			context: Type.String({
				description: "The context or information to send to the assistant",
			}),
			label: Type.Optional(Type.String({
				description: "Optional label for the context (e.g. file-contents, error-output)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = getState();
			if (!state.activated) {
				return {
					content: [{ type: "text" as const, text: "No assistant is active. Activate one first with activate_assistant." }],
					isError: true as const,
				};
			}
			const profile = getSelectedAssistant(state);
			if (!profile) {
				return {
					content: [{ type: "text" as const, text: "No assistant profile selected." }],
					isError: true as const,
				};
			}

			const label = params.label ?? "context";
			addMessage(state, "assistant", `[${label}] ${params.context}`);
			persistState(state, ctx.cwd);
			refreshModal();

			return {
				content: [{ type: "text" as const, text: `Context sent to ${profile.name}.` }],
			};
		},
		renderCall(args, theme) {
			const label = args.label ?? args.context.slice(0, 40);
			return new Text(
				theme.fg("toolTitle", theme.bold("send_assistant_context ")) +
				theme.fg("muted", label),
				0, 0,
			);
		},
		renderResult(result, _opts, theme) {
			return new Text(theme.fg("success", "Context delivered to assistant"), 0, 0);
		},
	});

	// --- Command: /assistant ---

	pi.registerCommand("assistant", {
		description: "/assistant (open modal) | /assistant activate | /assistant deactivate",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			const state = getState();

			if (sub === "activate") {
				if (state.activated) {
					ctx.ui.notify("Assistant already active. Use /assistant to open.", "info");
					return;
				}
				state.activated = true;
				persistState(state, ctx.cwd);
				updateStatusLine(state, ctx);
				ctx.ui.notify(`${getSelectedAssistant(state)?.name ?? "Assistant"} activated. Use /assistant to open.`, "success");
				return;
			}

			if (sub === "deactivate") {
				state.activated = false;
				persistState(state, ctx.cwd);
				clearStatusLine(ctx);
				ctx.ui.notify("Assistant deactivated.", "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/assistant requires interactive mode", "error");
				return;
			}

			if (!state.activated) {
				const confirmed = await ctx.ui.confirm(
					"Activate assistant?",
					"No assistant is active. Would you like to activate one?",
				);
				if (!confirmed) return;
				state.activated = true;
				persistState(state, ctx.cwd);
				updateStatusLine(state, ctx);
			}

			openModal(ctx, state);
		},
	});
}
