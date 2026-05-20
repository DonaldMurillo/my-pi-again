import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";

type ColorKey = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted" | "border";

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function estimateTokens(text: string): number {
	return Math.round(text.length / 4);
}

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c: any) => {
				if (typeof c === "string") return c;
				if (c?.type === "text") return c.text ?? "";
				if (c?.type === "thinking") return c.thinking ?? "";
				if (c?.type === "tool_use") return JSON.stringify(c.input ?? {});
				if (c?.type === "image") return "[image]";
				return JSON.stringify(c);
			})
			.join("\n");
	}
	return JSON.stringify(content ?? "");
}

interface BreakdownItem {
	label: string;
	tokens: number;
	color: ColorKey;
}

function buildContextBreakdown(ctx: ExtensionContext): BreakdownItem[] {
	const items: BreakdownItem[] = [];

	// System prompt breakdown
	const prompt = ctx.getSystemPrompt();
	const promptTokens = estimateTokens(prompt);

	// Parse system prompt sub-sections
	let remaining = prompt;

	const contextBlock = remaining.match(/# Project Context\n\n[\s\S]*?(?=\n# |\n<skills>|Current date:)/);
	let contextFileTokens = 0;
	if (contextBlock) {
		contextFileTokens = estimateTokens(contextBlock[0]);
		remaining = remaining.replace(contextBlock[0], "");
	}

	let skillsTokens = 0;
	const skillsMatch = remaining.match(/<skills>[\s\S]*?<\/skills>/i);
	if (skillsMatch) {
		skillsTokens = estimateTokens(skillsMatch[0]);
		remaining = remaining.replace(skillsMatch[0], "");
	}

	let reminderTokens = 0;
	const reminderMatches = remaining.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g);
	if (reminderMatches) {
		for (const r of reminderMatches) {
			reminderTokens += estimateTokens(r);
			remaining = remaining.replace(r, "");
		}
	}

	const basePromptTokens = estimateTokens(remaining.trim());

	items.push({ label: "System prompt", tokens: basePromptTokens, color: "dim" });
	if (contextFileTokens > 0) items.push({ label: "  CLAUDE.md / context", tokens: contextFileTokens, color: "accent" });
	if (skillsTokens > 0) items.push({ label: "  Skills", tokens: skillsTokens, color: "warning" });
	if (reminderTokens > 0) items.push({ label: "  System reminders", tokens: reminderTokens, color: "muted" });

	// Conversation breakdown
	const entries = ctx.sessionManager.getEntries();
	let userTokens = 0;
	let assistantTokens = 0;
	let toolResultTokens = 0;
	let thinkingTokens = 0;
	let compactionTokens = 0;
	let otherTokens = 0;

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = (entry as any).message;
			if (!msg) continue;
			const text = contentToString(msg.content);
			const tokens = estimateTokens(text);

			if (msg.role === "user") {
				userTokens += tokens;
			} else if (msg.role === "assistant") {
				// Separate thinking from output
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block?.type === "thinking") {
							thinkingTokens += estimateTokens(block.thinking ?? "");
						} else {
							assistantTokens += estimateTokens(contentToString(block));
						}
					}
				} else {
					assistantTokens += tokens;
				}
			} else if (msg.role === "toolResult") {
				toolResultTokens += tokens;
			} else {
				otherTokens += tokens;
			}
		} else if (entry.type === "compaction") {
			const comp = entry as any;
			compactionTokens += estimateTokens(comp.summary ?? "");
		}
	}

	items.push({ label: "User messages", tokens: userTokens, color: "accent" });
	items.push({ label: "Assistant output", tokens: assistantTokens, color: "success" });
	if (thinkingTokens > 0) items.push({ label: "Thinking", tokens: thinkingTokens, color: "warning" });
	items.push({ label: "Tool results", tokens: toolResultTokens, color: "muted" });
	if (compactionTokens > 0) items.push({ label: "Compaction summaries", tokens: compactionTokens, color: "dim" });
	if (otherTokens > 0) items.push({ label: "Other", tokens: otherTokens, color: "dim" });

	return items;
}

class ContextUsageDialog {
	private theme: Theme;
	private onClose: () => void;
	private ctx: ExtensionContext;
	private scrollOffset = 0;
	private totalRenderedLines = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(ctx: ExtensionContext, theme: Theme, onClose: () => void) {
		this.ctx = ctx;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.scrollOffset > 0) {
				this.scrollOffset--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.scrollOffset < Math.max(0, this.totalRenderedLines - 20)) {
				this.scrollOffset++;
				this.invalidate();
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const allLines: string[] = [];
		const inner = Math.min(width - 2, 48);

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

		// ── Title ──
		const title = " Context Usage ";
		const titleLen = visibleWidth(title);
		const hLeft = Math.max(1, Math.floor((inner + 2 - titleLen) / 2));
		const hRight = Math.max(1, inner + 2 - titleLen - hLeft);
		allLines.push(b.tl + b.h.repeat(hLeft) + th.bold(th.fg("accent", title)) + b.h.repeat(hRight) + b.tr);

		// ── Usage summary ──
		allLines.push(emptyRow());

		const usage = this.ctx.getContextUsage();
		const model = this.ctx.model;

		if (!usage) {
			allLines.push(row(th.fg("dim", "No context data available.")));
		} else if (usage.tokens == null) {
			allLines.push(row(this.kv(th, "Tokens", "unknown", inner, "dim")));
			allLines.push(row(this.kv(th, "Window", fmtTokens(usage.contextWindow), inner)));
		} else {
			const pct = usage.percent ?? 0;
			const pctColor: ColorKey = pct > 90 ? "error" : pct > 70 ? "warning" : "success";

			allLines.push(row(this.kv(th, "Tokens", fmtTokens(usage.tokens), inner)));
			allLines.push(row(this.kv(th, "Window", fmtTokens(usage.contextWindow), inner)));
			allLines.push(row(this.kv(th, "Used", `${pct.toFixed(1)}%`, inner, pctColor)));

			allLines.push(emptyRow());

			const barWidth = Math.min(30, inner - 12);
			const filledCount = Math.round((pct / 100) * barWidth);
			const emptyCount = barWidth - filledCount;
			const bar =
				th.fg(pctColor, "█".repeat(filledCount)) +
				th.fg("borderMuted", "░".repeat(emptyCount));
			allLines.push(row("  " + bar + " " + th.fg(pctColor, `${pct.toFixed(1)}%`)));

			allLines.push(emptyRow());

			const remaining = usage.contextWindow - usage.tokens;
			allLines.push(row(this.kv(th, "Remaining", fmtTokens(remaining), inner, "dim")));
		}

		// ── Context breakdown ──
		const breakdown = buildContextBreakdown(this.ctx);
		if (breakdown.length > 0) {
			allLines.push(divider());
			allLines.push(sectionHeader(" Context Breakdown "));
			allLines.push(emptyRow());

			const totalEstimated = breakdown.reduce((s, i) => s + i.tokens, 0);

			for (const item of breakdown) {
				const pct = totalEstimated > 0 ? (item.tokens / totalEstimated) * 100 : 0;
				const label = item.label.length > 24 ? item.label.slice(0, 23) + "…" : item.label;
				const val = `${fmtTokens(item.tokens)} (${pct.toFixed(0)}%)`;
				allLines.push(row(this.kv(th, label, val, inner, item.color)));
			}

			allLines.push(emptyRow());
			allLines.push(row(this.kv(th, "Estimated total", `~${fmtTokens(totalEstimated)}`, inner, "accent")));
		}

		// ── Model ──
		if (model) {
			allLines.push(divider());
			allLines.push(row(this.kv(th, "Model", model.name, inner, "accent")));
		}

		// ── Footer ──
		allLines.push(divider());
		const scrollHint = this.totalRenderedLines > 22;
		const hint = scrollHint
			? th.fg("dim", "↑↓ scroll") + th.fg("borderMuted", " · ") + th.fg("dim", "esc close")
			: th.fg("dim", "esc") + th.fg("borderMuted", " · ") + th.fg("dim", "close");
		allLines.push(row(hint));
		allLines.push(b.bl + b.h.repeat(inner + 2) + b.br);

		this.totalRenderedLines = allLines.length;
		const maxVisible = 24;
		const maxScroll = Math.max(0, allLines.length - maxVisible);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

		const visible = allLines.length > maxVisible
			? allLines.slice(this.scrollOffset, this.scrollOffset + maxVisible)
			: allLines;

		this.cachedWidth = width;
		this.cachedLines = visible;
		return visible;
	}

	private kv(th: Theme, key: string, value: string, innerWidth: number, valueColor: ColorKey = "text"): string {
		const keyText = th.fg("muted", key);
		const valText = th.fg(valueColor, value);
		const gap = Math.max(1, innerWidth - visibleWidth(keyText) - visibleWidth(valText));
		const dots = th.fg("borderMuted", " " + "·".repeat(Math.max(0, gap - 2)) + " ");
		return keyText + dots + valText;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function showDialog(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/context requires interactive mode", "error");
		return Promise.resolve();
	}

	return ctx.ui.custom<void>(
		(_tui, theme, _kb, done) => {
			return new ContextUsageDialog(ctx, theme, () => done());
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 54,
				maxHeight: 26,
			},
		},
	);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show current context token usage and breakdown",
		handler: async (_args, ctx) => showDialog(ctx),
	});
}
