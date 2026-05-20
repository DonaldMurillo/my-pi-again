/**
 * /custom-pi — A unified info modal for the pi agent session.
 *
 * Shows: git branch, isolation status, loaded skills, context usage,
 * model info, judge stats — all explorable in one overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

type ColorKey = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted" | "border";

// ─── Helpers ────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function runGit(cmd: string, cwd: string): string | null {
	try {
		return execSync(cmd, { cwd, encoding: "utf8", timeout: 3000 }).trim();
	} catch {
		return null;
	}
}

// ─── Info gathering ─────────────────────────────────────────────────

interface Section {
	title: string;
	rows: Array<{ key: string; value: string; color?: ColorKey }>;
}

function gatherSections(ctx: ExtensionContext): Section[] {
	const sections: Section[] = [];
	const cwd = ctx.cwd;

	// ── Git ──
	const gitRoot = runGit("git rev-parse --show-toplevel 2>/dev/null", cwd);
	if (gitRoot) {
		const branch = runGit("git branch --show-current", cwd) ?? "detached";
		const status = runGit("git status --porcelain", cwd);
		const dirty = status ? status.split("\n").filter(Boolean).length : 0;
		const lastCommit = runGit("git log -1 --oneline", cwd) ?? "none";

		sections.push({
			title: "Git",
			rows: [
				{ key: "Branch", value: branch, color: "accent" },
				{ key: "Root", value: gitRoot, color: "muted" },
				{ key: "Dirty files", value: String(dirty), color: dirty > 0 ? "warning" : "success" },
				{ key: "Last commit", value: lastCommit, color: "dim" },
			],
		});
	}

	// ── Model ──
	const model = ctx.model;
	if (model) {
		sections.push({
			title: "Model",
			rows: [
				{ key: "Name", value: model.name, color: "accent" },
				{ key: "Provider", value: model.provider, color: "muted" },
				{ key: "API", value: model.api, color: "dim" },
			],
		});
	}

	// ── Context ──
	const usage = ctx.getContextUsage();
	if (usage) {
		const pct = usage.percent ?? 0;
		const pctColor: ColorKey = pct > 90 ? "error" : pct > 70 ? "warning" : "success";
		const rows: Section["rows"] = [];

		if (usage.tokens != null) {
			rows.push({ key: "Tokens used", value: fmtTokens(usage.tokens), color: "text" });
		}
		if (usage.contextWindow) {
			rows.push({ key: "Context window", value: fmtTokens(usage.contextWindow), color: "text" });
		}
		if (usage.percent != null) {
			rows.push({ key: "Usage", value: `${pct.toFixed(1)}%`, color: pctColor });
		}
		if (usage.tokens != null && usage.contextWindow) {
			rows.push({ key: "Remaining", value: fmtTokens(usage.contextWindow - usage.tokens), color: "dim" });
		}

		sections.push({ title: "Context", rows });
	}

	// ── Isolation ──
	const isoConfigPath = join(cwd, ".pi", "isolation.json");
	if (existsSync(isoConfigPath)) {
		try {
			const raw = readFileSync(isoConfigPath, "utf8");
			const cfg = JSON.parse(raw) as Record<string, unknown>;
			sections.push({
				title: "Isolation",
				rows: [
					{ key: "Enabled", value: cfg.enabled ? "yes" : "no", color: cfg.enabled ? "success" : "error" },
					{ key: "Auto-mode", value: cfg.autoMode ? "on" : "off", color: cfg.autoMode ? "accent" : "dim" },
					...(cfg.judgeProvider ? [{ key: "Judge provider", value: String(cfg.judgeProvider), color: "muted" }] : []),
					...(cfg.judgeModel ? [{ key: "Judge model", value: String(cfg.judgeModel), color: "muted" }] : []),
					...(cfg.allowPaths ? [{ key: "Escape hatches", value: (cfg.allowPaths as string[]).join(", "), color: "dim" }] : []),
				],
			});
		} catch { /* ignore */ }
	}

	// ── Skills ──
	const skillSources = [
		{ label: "pi skills", path: join(homedir(), ".agents", "skills") },
		{ label: "pi agent", path: join(homedir(), ".pi", "agent", "skills") },
		{ label: "claude", path: join(homedir(), ".claude", "skills") },
		{ label: "claude plugins", path: join(homedir(), ".claude", "plugin-skills") },
		{ label: "project", path: join(cwd, ".pi", "skills") },
	];

	const skillRows: Section["rows"] = [];
	let totalSkills = 0;
	for (const src of skillSources) {
		if (existsSync(src.path)) {
			try {
				const dirs = readdirSync(src.path).filter((d) => {
					const p = join(src.path, d);
					return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
				});
				if (dirs.length > 0) {
					skillRows.push({ key: src.label, value: `${dirs.length} skills`, color: "muted" });
					totalSkills += dirs.length;
				}
			} catch { /* ignore */ }
		}
	}
	if (totalSkills > 0) {
		skillRows.unshift({ key: "Total", value: String(totalSkills), color: "accent" });
		sections.push({ title: "Skills", rows: skillRows });
	}

	return sections;
}

// ─── Modal ───────────────────────────────────────────────────────────

class InfoModal {
	private theme: Theme;
	private onClose: () => void;
	private ctx: ExtensionContext;
	private sections: Section[];
	private scrollOffset = 0;
	private totalLines = 0;

	constructor(ctx: ExtensionContext, theme: Theme, onClose: () => void) {
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
		this.sections = gatherSections(ctx);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.scrollOffset > 0) this.scrollOffset--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.scrollOffset < Math.max(0, this.totalLines - 26)) this.scrollOffset++;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.min(width - 4, 52);
		const allLines: string[] = [];

		const b = {
			tl: th.fg("border", "╔"),
			tr: th.fg("border", "╗"),
			bl: th.fg("border", "╚"),
			br: th.fg("border", "╝"),
			h: th.fg("border", "═"),
			v: th.fg("border", "║"),
			hl: th.fg("border", "╟"),
			hr: th.fg("border", "╢"),
		};

		const row = (content: string) => {
			const pad = Math.max(0, inner - visibleWidth(content));
			return b.v + " " + content + " ".repeat(pad) + " " + b.v;
		};
		const emptyRow = () => row(" ".repeat(inner));
		const divider = () => b.hl + th.fg("borderMuted", "─".repeat(inner + 2)) + b.hr;
		const sectionTitle = (text: string) => {
			const len = visibleWidth(text);
			const sL = Math.max(1, Math.floor((inner - len) / 2));
			const sR = Math.max(1, inner - len - sL);
			return row(
				th.fg("borderMuted", "·".repeat(sL)) +
				th.fg("accent", text) +
				th.fg("borderMuted", "·".repeat(sR)),
			);
		};

		// Title bar
		const title = " ✦ pi ";
		const titleLen = visibleWidth(title);
		const hLeft = Math.max(1, Math.floor((inner + 2 - titleLen) / 2));
		const hRight = Math.max(1, inner + 2 - titleLen - hLeft);
		allLines.push(b.tl + b.h.repeat(hLeft) + th.bold(th.fg("accent", title)) + b.h.repeat(hRight) + b.tr);

		allLines.push(emptyRow());

		// Sections
		for (const section of this.sections) {
			allLines.push(sectionTitle(section.title));
			allLines.push(emptyRow());
			for (const r of section.rows) {
				allLines.push(this.kv(th, r.key, r.value, inner, r.color ?? "text"));
			}
			allLines.push(emptyRow());
		}

		// Footer
		allLines.push(divider());
		const canScroll = this.totalLines > 26;
		const hint = canScroll
			? th.fg("dim", "↑↓ scroll") + th.fg("borderMuted", " · ") + th.fg("dim", "esc close")
			: th.fg("dim", "esc close");
		allLines.push(row(hint));
		allLines.push(b.bl + b.h.repeat(inner + 2) + b.br);

		this.totalLines = allLines.length;
		const maxVisible = 28;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, allLines.length - maxVisible));

		return allLines.length > maxVisible
			? allLines.slice(this.scrollOffset, this.scrollOffset + maxVisible)
			: allLines;
	}

	private kv(th: Theme, key: string, value: string, innerWidth: number, valueColor: ColorKey = "text"): string {
		const keyText = th.fg("muted", key);
		const valText = th.fg(valueColor, value);
		const gap = Math.max(1, innerWidth - visibleWidth(keyText) - visibleWidth(valText));
		const dots = th.fg("borderMuted", " " + "·".repeat(Math.max(0, gap - 2)) + " ");
		return keyText + dots + valText;
	}

	invalidate(): void { /* trigger re-render */ }
}

function showModal(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/custom-pi requires interactive mode", "error");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => new InfoModal(ctx, theme, () => done()),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 58,
				maxHeight: 30,
			},
		},
	);
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("custom-pi", {
		description: "Show pi session info: git branch, isolation, context usage, skills, model",
		handler: async (_args, ctx) => showModal(ctx),
	});
}
