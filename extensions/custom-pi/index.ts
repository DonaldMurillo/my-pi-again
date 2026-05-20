/**
 * /custom-pi — Unified session info modal.
 *
 * Git branch, isolation status, skills, model — all in one scrollable overlay.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type ColorKey = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted" | "border";

// ─── Data gathering ─────────────────────────────────────────────────

interface KV { key: string; value: string; color?: ColorKey }
interface Section { title: string; rows: KV[] }

function gatherSections(ctx: ExtensionContext): Section[] {
	const sections: Section[] = [];
	const cwd = ctx.cwd;

	// ── Git ──
	const gitRoot = git("git rev-parse --show-toplevel 2>/dev/null", cwd);
	if (gitRoot) {
		const branch = git("git branch --show-current", cwd) ?? "detached";
		const dirty = (git("git status --porcelain", cwd) ?? "").split("\n").filter(Boolean).length;
		const lastCommit = git("git log -1 --oneline", cwd) ?? "none";
		sections.push({
			title: "Git",
			rows: [
				{ key: "Branch", value: branch, color: "accent" },
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

	// ── Isolation ──
	const isoPath = join(cwd, ".pi", "isolation.json");
	if (existsSync(isoPath)) {
		try {
			const cfg = JSON.parse(readFileSync(isoPath, "utf8")) as Record<string, unknown>;
			const rows: KV[] = [
				{ key: "Enabled", value: cfg.enabled ? "yes" : "no", color: cfg.enabled ? "success" : "error" },
				{ key: "Auto-mode", value: cfg.autoMode ? "on" : "off", color: cfg.autoMode ? "accent" : "dim" },
			];
			if (cfg.judgeProvider) rows.push({ key: "Judge provider", value: String(cfg.judgeProvider), color: "muted" });
			if (cfg.judgeModel) rows.push({ key: "Judge model", value: String(cfg.judgeModel), color: "muted" });
			if (cfg.allowPaths) rows.push({ key: "Escape hatches", value: (cfg.allowPaths as string[]).join(", "), color: "dim" });
			sections.push({ title: "Isolation", rows });
		} catch { /* skip */ }
	}

	// ── Skills ──
	const sources = [
		{ label: "pi skills", path: join(homedir(), ".agents", "skills") },
		{ label: "pi agent", path: join(homedir(), ".pi", "agent", "skills") },
		{ label: "claude", path: join(homedir(), ".claude", "skills") },
		{ label: "claude plugins", path: join(homedir(), ".claude", "plugin-skills") },
		{ label: "project", path: join(cwd, ".pi", "skills") },
	];
	const skillRows: KV[] = [];
	let total = 0;
	for (const src of sources) {
		if (!existsSync(src.path)) continue;
		try {
			const count = readdirSync(src.path).filter((d) => {
				const p = join(src.path, d);
				return statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"));
			}).length;
			if (count > 0) {
				skillRows.push({ key: src.label, value: `${count} skills`, color: "muted" });
				total += count;
			}
		} catch { /* skip */ }
	}
	if (total > 0) {
		skillRows.unshift({ key: "Total", value: String(total), color: "accent" });
		sections.push({ title: "Skills", rows: skillRows });
	}

	return sections;
}

function git(cmd: string, cwd: string): string | null {
	try { return execSync(cmd, { cwd, encoding: "utf8", timeout: 3000 }).trim(); }
	catch { return null; }
}

// ─── Modal ───────────────────────────────────────────────────────────

class InfoModal {
	private theme: Theme;
	private onClose: () => void;
	private sections: Section[];
	private scrollOffset = 0;
	private totalLines = 0;

	constructor(ctx: ExtensionContext, theme: Theme, onClose: () => void) {
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
			if (this.scrollOffset < Math.max(0, this.totalLines - 24)) this.scrollOffset++;
			this.invalidate();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.min(width - 4, 48);
		const lines: string[] = [];

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
		const sectionHeader = (text: string) => {
			const len = visibleWidth(text);
			const sL = Math.max(1, Math.floor((inner - len) / 2));
			const sR = Math.max(1, inner - len - sL);
			return row(
				th.fg("borderMuted", "·".repeat(sL)) +
				th.fg("accent", text) +
				th.fg("borderMuted", "·".repeat(sR)),
			);
		};

		// Title
		const title = " ✦ pi ";
		const titleLen = visibleWidth(title);
		const hLeft = Math.max(1, Math.floor((inner + 2 - titleLen) / 2));
		const hRight = Math.max(1, inner + 2 - titleLen - hLeft);
		lines.push(b.tl + b.h.repeat(hLeft) + th.bold(th.fg("accent", title)) + b.h.repeat(hRight) + b.tr);
		lines.push(emptyRow());

		// Sections
		for (let i = 0; i < this.sections.length; i++) {
			if (i > 0) lines.push(emptyRow());
			lines.push(sectionHeader(this.sections[i].title));
			lines.push(emptyRow());
			for (const r of this.sections[i].rows) {
				lines.push(row(kv(th, r.key, r.value, inner, r.color ?? "text")));
			}
		}

		// Footer
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(row(th.fg("dim", "esc close")));
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

function kv(th: Theme, key: string, value: string, innerWidth: number, valueColor: ColorKey = "text"): string {
	const keyText = th.fg("muted", key);
	const valText = th.fg(valueColor, value);
	const gap = Math.max(1, innerWidth - visibleWidth(keyText) - visibleWidth(valText));
	const dots = th.fg("borderMuted", " " + "·".repeat(Math.max(0, gap - 2)) + " ");
	return keyText + dots + valText;
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
			overlayOptions: { anchor: "center", width: 54, maxHeight: 28 },
		},
	);
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("custom-pi", {
		description: "Show pi session info: git, model, isolation, skills",
		handler: async (_args, ctx) => showModal(ctx),
	});
}
