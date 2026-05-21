/**
 * Sessions Extension for Pi
 *
 * Makes sessions discoverable:
 *   - Shows `pi --session <id>` above the editor
 *   - Auto-generates a synopsis on agent_end via fast LLM
 *   - `/sessions` opens a scrollable overlay to browse and switch sessions
 *
 * Pi already has: --session <id>, /resume, /name, /fork, /session.
 * This adds: visibility, descriptions, and quick switching.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { complete } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

import { matchesKey } from "@mariozechner/pi-tui";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
	AgentEndEvent,
} from "@mariozechner/pi-coding-agent";

// ─── Config ────────────────────────────────────────────────────────────

const SYNOPSIS_PROVIDER = "zai";
const SYNOPSIS_MODEL = "glm-5-turbo";
const SYNOPSIS_TIMEOUT = 8000;
const SYNOPSIS_MAX_MESSAGES = 20; // only feed last N user messages to keep it cheap

// ─── Helpers ──────────────────────────────────────────────────────────

function shortId(id: string): string {
	return id.slice(-8);
}

function fmtDate(d: Date): string {
	const diffMs = Date.now() - d.getTime();
	const diffMin = Math.floor(diffMs / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 7) return `${diffDay}d ago`;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Session file parsing ─────────────────────────────────────────────

interface SessionHeader {
	id: string;
	cwd: string;
	timestamp: string;
}

interface SessionScan {
	messageCount: number;
	firstMessage: string;
	name?: string;
	synopsis?: string;
}

async function readSessionHeader(filePath: string): Promise<SessionHeader | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const firstLine = content.split("\n")[0];
		if (!firstLine) return null;
		const header = JSON.parse(firstLine);
		if (header.type !== "session") return null;
		return { id: header.id, cwd: header.cwd, timestamp: header.timestamp };
	} catch {
		return null;
	}
}

async function scanSessionFile(filePath: string): Promise<SessionScan> {
	try {
		const content = await readFile(filePath, "utf8");
		const lines = content.trim().split("\n");
		let messageCount = 0;
		let firstMessage = "";
		let name: string | undefined;
		let synopsis: string | undefined;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);

				if (entry.type === "message" && entry.message?.role === "user") {
					messageCount++;
					if (!firstMessage && entry.message?.content) {
						const textParts = entry.message.content
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text);
						firstMessage = textParts.join(" ").slice(0, 80);
					}
				}

				if (entry.type === "session_info" && entry.name) {
					name = entry.name;
				}

				// Read persisted synopsis from custom entry
				if (entry.type === "custom" && entry.customType === "session_synopsis" && entry.data?.synopsis) {
					synopsis = entry.data.synopsis as string;
				}
			} catch {
				// skip malformed lines
			}
		}

		return { messageCount, firstMessage, name, synopsis };
	} catch {
		return { messageCount: 0, firstMessage: "" };
	}
}

// ─── Session discovery ─────────────────────────────────────────────────

async function findSessionDirs(): Promise<string[]> {
	const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
	if (!existsSync(sessionsRoot)) return [];
	const entries = await readdir(sessionsRoot, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => join(sessionsRoot, e.name));
}

interface SessionListItem {
	id: string;
	shortId: string;
	name?: string;
	synopsis?: string;
	created: Date;
	project: string;
	messageCount: number;
	firstMessage: string;
	filePath: string;
}

async function listSessions(opts: {
	projectDir?: string;
	all?: boolean;
	filter?: string;
}): Promise<SessionListItem[]> {
	const dirs = opts.all
		? await findSessionDirs()
		: opts.projectDir
			? [opts.projectDir]
			: [];

	const results: SessionListItem[] = [];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const files = await readdir(dir);
		const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

		for (const file of jsonlFiles) {
			const filePath = join(dir, file);
			const header = await readSessionHeader(filePath);
			if (!header) continue;

			const created = new Date(header.timestamp);
			if (isNaN(created.getTime())) continue;

			const scan = await scanSessionFile(filePath);
			const project = header.cwd || basename(dir);

			const item: SessionListItem = {
				id: header.id,
				shortId: shortId(header.id),
				name: scan.name,
				synopsis: scan.synopsis,
				created,
				project,
				messageCount: scan.messageCount,
				firstMessage: scan.firstMessage,
				filePath,
			};

			if (opts.filter) {
				const q = opts.filter.toLowerCase();
				const matches =
					item.id.includes(q) ||
					item.shortId.includes(q) ||
					item.name?.toLowerCase().includes(q) ||
					item.project.toLowerCase().includes(q) ||
					item.firstMessage.toLowerCase().includes(q) ||
					item.synopsis?.toLowerCase().includes(q);
				if (!matches) continue;
			}

			results.push(item);
		}
	}

	results.sort((a, b) => b.created.getTime() - a.created.getTime());
	return results;
}

// ─── Synopsis generation ──────────────────────────────────────────────

const SYNOPSIS_SYSTEM = `You summarize coding agent sessions in one short line (max 60 chars).
Describe WHAT was done, not that an agent did it. No verbs like "working on".
Examples:
- Add auth middleware with JWT validation
- Fix race condition in task scheduler
- Refactor database connection pooling
- Implement file upload with progress tracking`;

async function generateSynopsis(
	messages: Array<{ role: string; content?: any[] }>,
	ctx: ExtensionContext,
): Promise<string | null> {
	// Collect last N user messages
	const userTexts = messages
		.filter((m) => m.role === "user" && m.content)
		.slice(-SYNOPSIS_MAX_MESSAGES)
		.map((m) => m.content!
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join(" "))
		.filter(Boolean);

	if (userTexts.length === 0) return null;

	const prompt = userTexts.join("\n---\n");

	try {
		const model = ctx.modelRegistry.find(SYNOPSIS_PROVIDER, SYNOPSIS_MODEL) as Model<Api> | undefined;
		if (!model) return null;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return null;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), SYNOPSIS_TIMEOUT);

		const response = await complete(
			model,
			{
				systemPrompt: SYNOPSIS_SYSTEM,
				messages: [
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
			},
		);

		clearTimeout(timeout);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.replace(/^["']|["']$/g, ""); // strip wrapping quotes

		return text || null;
	} catch {
		return null;
	}
}

// ─── Overlay renderer ──────────────────────────────────────────────────

interface OverlayState {
	sessions: SessionListItem[];
	selectedIdx: number;
	scrollOffset: number;
	currentId: string;
	showAll: boolean;
}

function renderOverlay(theme: any, state: OverlayState, width: number, height: number): string[] {
	const lines: string[] = [];
	const header = state.showAll ? "Sessions (all projects)" : "Sessions";
	lines.push(theme.fg("accent", ` ${header} (${state.sessions.length})`));
	lines.push(theme.fg("dim", " ↑↓ scroll  Enter switch  Escape close"));
	lines.push("");

	const visibleHeight = height - 4; // header + help + blank + bottom padding
	const start = state.scrollOffset;
	const end = Math.min(start + visibleHeight, state.sessions.length);

	for (let i = start; i < end; i++) {
		const s = state.sessions[i];
		const selected = i === state.selectedIdx;
		const isCurrent = s.id === state.currentId;

		const marker = isCurrent ? " ←" : "";
		const age = fmtDate(s.created);
		const msgs = `${s.messageCount}m`;
		const label = s.synopsis || s.name || s.firstMessage.slice(0, 50) || "(empty)";

		let line = ` ${shortId(s.id)}  ${age.padEnd(8)} ${msgs.padEnd(4)} ${label}${marker}`;
		// Truncate to width
		if (line.length > width - 2) line = line.slice(0, width - 5) + "...";

		if (selected) {
			line = theme.bg("selectedBg", theme.fg("text", line));
		} else if (isCurrent) {
			line = theme.fg("accent", line);
		}

		lines.push(line);
	}

	// Pad remaining space
	while (lines.length < height - 1) lines.push("");

	return lines;
}

// ─── Extension ─────────────────────────────────────────────────────────

export default function registerSessions(pi: ExtensionAPI): void {

	// Show `pi --session <id>` above the editor
	// This fires on startup, reload, new, resume, fork
	pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
		if (!ctx.hasUI) return;
		const sid = ctx.sessionManager.getSessionId();
		ctx.ui.setWidget("session-id", [`pi --session ${sid}`], { placement: "aboveEditor" });
	});

	// Generate synopsis when agent finishes a turn
	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		const synopsis = await generateSynopsis(event.messages, ctx);
		if (synopsis) {
			pi.appendEntry("session_synopsis", { synopsis });
		}
	});

	// ── Command: /sessions ─────────────────────────────────────────────

	pi.registerCommand("sessions", {
		description: "Browse and switch sessions. --all for all projects, or pass text to filter.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const showAll = trimmed.includes("--all");
			const filter = trimmed.replace(/--all\b/, "").trim() || undefined;

			if (!ctx.hasUI) {
				// Non-interactive fallback: just print
				const sessions = await listSessions({
					projectDir: showAll ? undefined : ctx.sessionManager.getSessionDir(),
					all: showAll,
					filter,
				});
				const lines = sessions.map((s) =>
					`${shortId(s.id)}  ${fmtDate(s.created)}  ${s.messageCount}m  ${s.synopsis || s.firstMessage.slice(0, 60)}`
				);
				ctx.ui.notify(lines.join("\n") || "No sessions found.", "info");
				return;
			}

			const sessions = await listSessions({
				projectDir: showAll ? undefined : ctx.sessionManager.getSessionDir(),
				all: showAll,
				filter,
			});

			if (sessions.length === 0) {
				ctx.ui.notify(
					showAll ? "No sessions found." : "No sessions for this project. Try /sessions --all.",
					"info",
				);
				return;
			}

			const currentId = ctx.sessionManager.getSessionId();
			const state: OverlayState = {
				sessions,
				selectedIdx: sessions.findIndex((s) => s.id === currentId),
				scrollOffset: 0,
				currentId,
				showAll,
			};
			if (state.selectedIdx < 0) state.selectedIdx = 0;

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const overlayWidth = 70;
				const overlayHeight = 20;

				return {
					render(w: number): string[] {
						return renderOverlay(theme, state, overlayWidth, overlayHeight);
					},
					handleInput(data: string) {
						if (matchesKey(data, "up") || data === "k") {
							if (state.selectedIdx > 0) {
								state.selectedIdx--;
								const visibleHeight = overlayHeight - 4;
								if (state.selectedIdx < state.scrollOffset) {
									state.scrollOffset = state.selectedIdx;
								}
							}
							tui.requestRender();
						} else if (matchesKey(data, "down") || data === "j") {
							if (state.selectedIdx < state.sessions.length - 1) {
								state.selectedIdx++;
								const visibleHeight = overlayHeight - 4;
								if (state.selectedIdx >= state.scrollOffset + visibleHeight) {
									state.scrollOffset = state.selectedIdx - visibleHeight + 1;
								}
							}
							tui.requestRender();
						} else if (data === "\r" || data === "Enter" || data === "\n") {
							const session = state.sessions[state.selectedIdx];
							done(session?.filePath ?? null);
						} else if (matchesKey(data, "escape") || data === "q") {
							done(null);
						}
					},
					dispose() {},
				};
			}, {
				overlay: true,
				overlayOptions: { anchor: "center", width: 70, maxHeight: 20 },
			});

			// Switch to selected session
			if (result) {
				await ctx.switchSession(result, {
					withSession(newCtx) {
						if (newCtx.hasUI) {
							const sid = newCtx.sessionManager.getSessionId();
							newCtx.ui.setWidget("session-id", [`pi --session ${sid}`], { placement: "aboveEditor" });
						}
					},
				});
			}
		},
	});
}
