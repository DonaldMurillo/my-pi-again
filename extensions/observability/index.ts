/**
 * Observability extension.
 *
 * Provides:
 *   - Agent lifecycle detection (agent_start → agent_end → "idle")
 *   - Shared event bus for cross-extension communication (bus.ts)
 *   - State persistence to disk with pruning
 *   - Error tracking (rate limits, 500s, parse errors)
 *   - /observe command to inspect live state + event log
 *   - /observe log to see recent events
 *   - /observe reset to clear state
 *
 * Other extensions use the bus:
 *   import { bus } from "../observability/bus.js";
 *   bus.emit("isolation:blocked", { ... });
 *   bus.on("agent:idle", () => { ... });
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { bus, type HistoryEntry } from "./bus.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

type ColorKey = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted" | "border";

// ─── Persistence ─────────────────────────────────────────────────────

const STATE_FILE = join(homedir(), ".pi", "agent", "observability-state.json");
const MAX_PERSISTED_ERRORS = 50;
const MAX_PERSISTED_HISTORY = 100;
const SAVE_INTERVAL = 10_000; // save to disk every 10s max

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

interface PersistedState {
	version: number;
	agent: {
		promptCount: number;
		totalTurns: number;
		totalErrors: number;
		errors: Array<{ type: string; message: string; at: number }>;
	};
	isolation: {
		totalBlocked: number;
		totalAllowed: number;
	};
	updatedAt: number;
}

function loadState(): PersistedState | null {
	try {
		if (!existsSync(STATE_FILE)) return null;
		const raw = readFileSync(STATE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return parsed.version === 1 ? parsed : null;
	} catch {
		return null;
	}
}

function saveState(): void {
	const s = bus.state;
	const persisted: PersistedState = {
		version: 1,
		agent: {
			promptCount: s.agent.promptCount,
			totalTurns: s.agent.turnCount,
			totalErrors: s.agent.errors.length,
			errors: s.agent.errors.slice(-MAX_PERSISTED_ERRORS),
		},
		isolation: {
			totalBlocked: s.isolation.judgeStats.blocked,
			totalAllowed: s.isolation.judgeStats.allowed,
		},
		updatedAt: Date.now(),
	};
	try {
		mkdirSync(join(STATE_FILE, ".."), { recursive: true });
		writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
		dirty = false;
	} catch { /* ignore */ }
}

function scheduleSave(): void {
	if (dirty) return;
	dirty = true;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveState();
		saveTimer = null;
	}, SAVE_INTERVAL);
}

function pruneState(): void {
	// Keep errors trimmed
	if (bus.state.agent.errors.length > MAX_PERSISTED_ERRORS) {
		bus.state.agent.errors = bus.state.agent.errors.slice(-MAX_PERSISTED_ERRORS);
	}
}

// ─── Git helper ──────────────────────────────────────────────────────

function getGitInfo(cwd: string): { branch: string | null; dirty: number } {
	try {
		const branch = execSync("git branch --show-current 2>/dev/null", { cwd, encoding: "utf8", timeout: 3000 }).trim() || null;
		const status = execSync("git status --porcelain 2>/dev/null", { cwd, encoding: "utf8", timeout: 3000 }).trim();
		const dirty = status ? status.split("\n").filter(Boolean).length : 0;
		return { branch, dirty };
	} catch {
		return { branch: null, dirty: 0 };
	}
}

// ─── Modal ───────────────────────────────────────────────────────────

class ObserveModal {
	private theme: Theme;
	private onClose: () => void;
	private scrollOffset = 0;
	private totalLines = 0;
	private tab: "state" | "log" | "errors" = "state";

	constructor(theme: Theme, onClose: () => void) {
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "1")) { this.tab = "state"; this.scrollOffset = 0; this.invalidate(); return; }
		if (matchesKey(data, "2")) { this.tab = "log"; this.scrollOffset = 0; this.invalidate(); return; }
		if (matchesKey(data, "3")) { this.tab = "errors"; this.scrollOffset = 0; this.invalidate(); return; }
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.scrollOffset > 0) this.scrollOffset--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.scrollOffset < Math.max(0, this.totalLines - 24)) this.scrollOffset++;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.min(width - 4, 52);
		const lines: string[] = [];

		const b = {
			tl: th.fg("border", "╔"), tr: th.fg("border", "╗"),
			bl: th.fg("border", "╚"), br: th.fg("border", "╝"),
			h: th.fg("border", "═"), v: th.fg("border", "║"),
			hl: th.fg("border", "╟"), hr: th.fg("border", "╢"),
		};

		const row = (content: string) => {
			const pad = Math.max(0, inner - visibleWidth(content));
			return b.v + " " + content + " ".repeat(pad) + " " + b.v;
		};
		const emptyRow = () => row(" ".repeat(inner));
		const divider = () => b.hl + th.fg("borderMuted", "─".repeat(inner + 2)) + b.hr;

		const kv = (key: string, value: string, vc: ColorKey = "text"): string => {
			const kt = th.fg("muted", key);
			const vt = th.fg(vc, value);
			const gap = Math.max(1, inner - visibleWidth(kt) - visibleWidth(vt));
			return kt + th.fg("borderMuted", " " + "·".repeat(Math.max(0, gap - 2)) + " ") + vt;
		};

		// Title + tabs
		const tabs = [
			this.tab === "state" ? th.fg("accent", th.bold("1:State")) : th.fg("dim", "1:State"),
			this.tab === "log" ? th.fg("accent", th.bold("2:Log")) : th.fg("dim", "2:Log"),
			this.tab === "errors" ? th.fg("accent", th.bold("3:Errors")) : th.fg("dim", "3:Errors"),
		].join(th.fg("borderMuted", " │ "));

		const title = " Observability ";
		const titleLen = visibleWidth(title);
		const hLeft = Math.max(1, Math.floor((inner + 2 - titleLen) / 2));
		const hRight = Math.max(1, inner + 2 - titleLen - hLeft);
		lines.push(b.tl + b.h.repeat(hLeft) + th.bold(th.fg("accent", title)) + b.h.repeat(hRight) + b.tr);
		lines.push(row(tabs));
		lines.push(divider());

		const s = bus.state;

		if (this.tab === "state") {
			lines.push(emptyRow());
			lines.push(row(th.fg("accent", "Agent")));
			lines.push(row(kv("Status", s.agent.status, s.agent.status === "idle" ? "success" : "warning")));
			lines.push(row(kv("Turns", String(s.agent.turnCount))));
			lines.push(row(kv("Prompts", String(s.agent.promptCount))));
			lines.push(row(kv("Errors", String(s.agent.errors.length), s.agent.errors.length > 0 ? "error" : "dim")));
			lines.push(emptyRow());

			lines.push(row(th.fg("accent", "Isolation")));
			lines.push(row(kv("Enabled", s.isolation.enabled ? "yes" : "no", s.isolation.enabled ? "success" : "error")));
			lines.push(row(kv("Bypass", s.isolation.bypass ? "on" : "off", s.isolation.bypass ? "warning" : "dim")));
			lines.push(row(kv("Auto-mode", s.isolation.autoMode ? "on" : "off")));
			lines.push(row(kv("Judge allowed", String(s.isolation.judgeStats.allowed), "success")));
			lines.push(row(kv("Judge blocked", String(s.isolation.judgeStats.blocked), "error")));
			lines.push(row(kv("Judge errors", String(s.isolation.judgeStats.errors), s.isolation.judgeStats.errors > 0 ? "error" : "dim")));
			lines.push(emptyRow());

			lines.push(row(th.fg("accent", "Skills")));
			lines.push(row(kv("Total", String(s.skills.total))));
			for (const src of s.skills.sources) {
				lines.push(row(kv(`  ${src.label}`, `${src.count} skills`, "muted")));
			}
			lines.push(emptyRow());

			lines.push(row(th.fg("accent", "Git")));
			lines.push(row(kv("Branch", s.git.branch ?? "none", s.git.branch ? "accent" : "dim")));
			lines.push(row(kv("Dirty files", String(s.git.dirtyFiles), s.git.dirtyFiles > 0 ? "warning" : "success")));
		}

		if (this.tab === "log") {
			const history = bus.history;
			lines.push(row(th.fg("dim", `${history.length} events (showing last ${Math.min(history.length, 50)})`)));
			lines.push(emptyRow());
			const recent = history.slice(-50).reverse();
			for (const entry of recent) {
				const ago = ((Date.now() - entry.timestamp) / 1000).toFixed(0);
				const event = entry.event.length > 24 ? entry.event.slice(0, 23) + "…" : entry.event;
				lines.push(row(kv(`${ago}s ago`, event, eventColor(entry.event))));
			}
			if (recent.length === 0) {
				lines.push(row(th.fg("dim", "No events yet")));
			}
		}

		if (this.tab === "errors") {
			const errors = s.agent.errors;
			lines.push(row(th.fg("dim", `${errors.length} errors`)));
			lines.push(emptyRow());
			const recent = errors.slice(-20).reverse();
			for (const err of recent) {
				const ago = ((Date.now() - err.at) / 1000).toFixed(0);
				lines.push(row(kv(`${ago}s`, `${err.type}: ${err.message.slice(0, 40)}`, "error")));
			}
			if (recent.length === 0) {
				lines.push(row(th.fg("success", "No errors!")));
			}
		}

		// Footer
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(row(th.fg("dim", "1/2/3 tabs") + th.fg("borderMuted", " · ") + th.fg("dim", "↑↓ scroll") + th.fg("borderMuted", " · ") + th.fg("dim", "esc close")));
		lines.push(b.bl + b.h.repeat(inner + 2) + b.br);

		this.totalLines = lines.length;
		const maxVis = 26;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - maxVis));
		return lines.length > maxVis
			? lines.slice(this.scrollOffset, this.scrollOffset + maxVis)
			: lines;
	}

	invalidate(): void { /* re-render */ }
}

function eventColor(event: string): ColorKey {
	if (event.startsWith("agent:idle")) return "success";
	if (event.startsWith("agent:error")) return "error";
	if (event.startsWith("isolation:blocked")) return "error";
	if (event.startsWith("judge:")) return "warning";
	return "muted";
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// ── Load persisted state ──
	const saved = loadState();
	if (saved) {
		bus.state.agent.promptCount = saved.agent.promptCount;
		bus.state.agent.errors = saved.agent.errors;
	}

	// ── Session ──
	pi.on("session_start", async (_e, ctx) => {
		bus.setState("session", { startedAt: Date.now(), cwd: ctx.cwd });
		bus.emit("session:start", { cwd: ctx.cwd });

		// Update git info
		const git = getGitInfo(ctx.cwd);
		bus.setState("git", git);

		// Schedule periodic saves
		const saveLoop = setInterval(() => { if (dirty) saveState(); }, 30_000);
		pi.on("session_shutdown", async () => {
			clearInterval(saveLoop);
			saveState();
			bus.emit("session:end", {});
		});
	});

	// ── Agent lifecycle ──
	pi.on("agent_start", async (_e, ctx) => {
		bus.setState("agent", {
			status: "working",
			lastPromptAt: Date.now(),
			promptCount: bus.state.agent.promptCount + 1,
			turnCount: 0,
		});
		bus.emit("agent:working", { turnIndex: 0 });

		// Refresh git
		const git = getGitInfo(ctx.cwd);
		bus.setState("git", git);
	});

	pi.on("turn_start", async (_e, _ctx) => {
		bus.setState("agent", {
			turnCount: bus.state.agent.turnCount + 1,
		});
	});

	pi.on("agent_end", async (_e, ctx) => {
		const startedAt = bus.state.agent.lastPromptAt ?? Date.now();
		bus.setState("agent", {
			status: "idle",
			lastIdleAt: Date.now(),
		});
		bus.emit("agent:idle", {
			turnCount: bus.state.agent.turnCount,
			durationMs: Date.now() - startedAt,
		});

		// Refresh git after agent may have changed files
		const git = getGitInfo(ctx.cwd);
		bus.setState("git", git);
		if (git.branch !== bus.state.git.branch || git.dirtyFiles !== bus.state.git.dirtyFiles) {
			bus.emit("git:changed", git);
		}

		pruneState();
		scheduleSave();
	});

	// ── Error tracking ──
	// Hook into after_provider_response to catch HTTP errors
	pi.on("after_provider_response", async (e, _ctx) => {
		const status = e.status;
		if (status >= 400 || status === 429) {
			const type = status === 429 ? "rate_limit" : status >= 500 ? "server_error" : "unknown";
			const error = { type, message: `HTTP ${status}`, at: Date.now() };
			bus.state.agent.errors.push(error);
			bus.emit("agent:error", {
				type,
				status,
				message: `HTTP ${status}`,
			});
			scheduleSave();
		}
	});

	// ── Commands ──
	pi.registerCommand("observe", {
		description: "Observe agent state, event log, and errors",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "reset") {
				bus.resetState();
				bus.clearHistory();
				ctx.ui.notify("Observability state reset", "info");
				return;
			}

			if (sub === "log") {
				const recent = bus.history.slice(-20).reverse();
				const lines = recent.map((e: HistoryEntry) => {
					const ago = ((Date.now() - e.timestamp) / 1000).toFixed(1);
					return `${ago}s  ${e.event}  ${JSON.stringify(e.data).slice(0, 60)}`;
				});
				ctx.ui.notify(lines.join("\n") || "No events", "info");
				return;
			}

			if (sub === "save") {
				saveState();
				ctx.ui.notify("State saved to disk", "info");
				return;
			}

			// Default: show modal
			if (!ctx.hasUI) {
				ctx.ui.notify("/observe requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => new ObserveModal(theme, () => done()),
				{ overlay: true, overlayOptions: { anchor: "center", width: 58, maxHeight: 30 } },
			);
		},
	});
}
