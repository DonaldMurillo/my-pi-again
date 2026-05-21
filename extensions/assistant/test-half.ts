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
		const truncateToWidth = (line: string, maxW: number): string => {
			let vis = 0, cutPos = line.length, idx = 0;
			while (idx < line.length) {
				if (line[idx] === '\x1b') {
					const end = line.indexOf('m', idx);
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
				.map((h) => `${h.role}: ${h.text}`)
				.join("\n\n");

			const fileSnapshot = extractFileSnapshot(agentMessages, ctx.cwd);

			evalInProgress = true;
			state.activity = "thinking";
			updateStatusLine(state, ctx);
			generateAreWeThereYet(profile, fullConversation, fileSnapshot, ctx, llmConfig)
				.then((result) => {
					evalInProgress = false;
					state.activity = "idle";
					updateStatusLine(state, ctx);
					addMessage(state, "assistant",
						`[Evaluation] ${result.summary}` +
						(result.gaps.length > 0 ? `\n\nGaps:\n${result.gaps.map((g) => `- ${g}`).join("\n")}` : "") +
						(result.achieved ? "\n\nGoal achieved." : ""),
					);
					persistState(state, ctx.cwd);
					refreshModal();

					if (result.achieved) {
						state.repromptCount = 0;
						ctx.ui.notify(`Goal achieved. ${result.summary}`, "success");
					} else {
						state.repromptCount++;
						if (state.repromptCount >= (state.config.maxReprompts ?? 3)) {
							ctx.ui.notify(`Max reprompts reached (${state.repromptCount}). Stopping.`, "warning");
							state.repromptCount = 0;
							return;
						}
						const fixPrompt = result.fixes.length > 0
							? result.fixes.map((f: string, i: number) => `${i + 1}. ${f}`).join("\n")
							: result.gaps.map((g: string, i: number) => `${i + 1}. ${g}`).join("\n");

						ctx.ui.notify(`Not done yet. ${result.gaps.length} gaps found -- reprompting (${state.repromptCount}/${state.config.maxReprompts ?? 3})...`, "warning");

						pi.sendUserMessage(
							`Are We There Yet evaluation found these gaps:\n${fixPrompt}\n\nFix all of the above. Be specific and thorough.`,
							{ deliverAs: "nextTurn" },
						);
					}
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
