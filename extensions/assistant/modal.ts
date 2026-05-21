/**
 * Assistant modal — two-pane TUI overlay with chat + settings.
 * Tab switches between chat and settings panes.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { AssistantState, PersonalityProfile } from "./types.js";

// ─── Mouse helpers ───────────────────────────────────────────────────

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
const BTN_MASK = 0b11;

interface MouseEvent {
	isScrollUp: boolean;
	isScrollDown: boolean;
	isLeftClick: boolean;
	row: number;
	col: number;
}

function parseMouseEvent(data: string): MouseEvent | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	const raw = parseInt(match[1], 10);
	return {
		isLeftClick: (raw & BTN_MASK) === 0 && match[4] === "M",
		isScrollUp: raw === 64,
		isScrollDown: raw === 65,
		row: parseInt(match[3], 10),
		col: parseInt(match[2], 10),
	};
}

function pad(s: string, w: number): string {
	return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
}

type Pane = "chat" | "settings";

export interface ModalCallbacks {
	onUserMessage: (text: string) => void;
	onSelectAssistant: (id: string) => void;
	onClose: () => void;
}

export interface ModalHandle {
	requestRender: () => void;
}

export function openAssistantModal(
	ctx: ExtensionContext,
	state: AssistantState,
	callbacks: ModalCallbacks,
): ModalHandle {
	let tuiRef: { requestRender: () => void } | null = null;

	ctx.ui.custom<void>((tui, theme, _kb, done) => {
		process.stdout.write(MOUSE_ENABLE);
		tuiRef = tui;

		const ui = {
			pane: "chat" as Pane,
			inputText: "",
			scrollOffset: 0,
			settingsCursor: 0,
			isGenerating: false,
			cursorPos: 0,
			// Explicitly track which profile is selected — updated on every render + selection
			selectedId: state.config.selectedAssistantId,
		};

		function currentProfile(): PersonalityProfile | undefined {
			return state.assistants.get(ui.selectedId);
		}

		const component = {
			handleInput(data: string) {
				if (data === "\t") {
					ui.pane = ui.pane === "chat" ? "settings" : "chat";
					ui.scrollOffset = 0;
					tui.requestRender();
					return;
				}

				const mouse = parseMouseEvent(data);
				if (mouse) {
					if (mouse.isScrollUp) {
						ui.scrollOffset = Math.max(0, ui.scrollOffset - 3);
						tui.requestRender(); return;
					}
					if (mouse.isScrollDown) {
						if (ui.pane === "chat") {
							ui.scrollOffset += 3;
						} else {
							ui.settingsCursor = Math.min(state.assistants.size - 1, ui.settingsCursor + 1);
						}
						tui.requestRender(); return;
					}
					if (mouse.isLeftClick && ui.pane === "settings") {
						const clickedIdx = mouse.row - 5;
						if (clickedIdx >= 0 && clickedIdx < state.assistants.size) {
							selectAssistant(clickedIdx);
						}
					}
					return;
				}

				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					process.stdout.write(MOUSE_DISABLE);
					tuiRef = null;
					callbacks.onClose();
					done();
					return;
				}

				// Tab or Ctrl+T switches panes
				if (data === "\t" || matchesKey(data, "tab") || matchesKey(data, "ctrl+t")) {
					ui.pane = ui.pane === "chat" ? "settings" : "chat";
					tui.requestRender();
					return;
				}

				if (ui.pane === "settings") {
					handleSettingsKey(data);
				} else {
					handleChatKey(data);
				}
				tui.requestRender();
			},

			render(width: number): string[] {
				// Sync selectedId from state on every render
				ui.selectedId = state.config.selectedAssistantId;
				return ui.pane === "chat"
					? renderChat(width, theme, state, ui, currentProfile())
					: renderSettings(width, theme, state, ui, currentProfile());
			},

			invalidate(): void {},
			dispose(): void {
				process.stdout.write(MOUSE_DISABLE);
				tuiRef = null;
			},
		};

		function selectAssistant(index: number): void {
			const ids = Array.from(state.assistants.keys());
			if (index < 0 || index >= ids.length) return;
			const id = ids[index]!;
			ui.selectedId = id;
			ui.settingsCursor = index;
			state.config.selectedAssistantId = id;
			callbacks.onSelectAssistant(id);
			tui.requestRender();
		}

		function handleSettingsKey(data: string): void {
			const count = state.assistants.size;
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				ui.settingsCursor = Math.max(0, ui.settingsCursor - 1);
			} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
				ui.settingsCursor = Math.min(count - 1, ui.settingsCursor + 1);
			} else if (matchesKey(data, "enter") || matchesKey(data, " ")) {
				selectAssistant(ui.settingsCursor);
			}
		}

		function handleChatKey(data: string): void {
			if (matchesKey(data, "enter")) {
				if (ui.inputText.trim() && !ui.isGenerating) {
					const text = ui.inputText.trim();
					ui.inputText = "";
					ui.cursorPos = 0;
					ui.isGenerating = true;
					callbacks.onUserMessage(text);
				}
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (ui.cursorPos > 0) {
					ui.inputText = ui.inputText.slice(0, ui.cursorPos - 1) + ui.inputText.slice(ui.cursorPos);
					ui.cursorPos--;
				}
				return;
			}
			if (matchesKey(data, "left")) {
				ui.cursorPos = Math.max(0, ui.cursorPos - 1);
				return;
			}
			if (matchesKey(data, "right")) {
				ui.cursorPos = Math.min(ui.inputText.length, ui.cursorPos + 1);
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				ui.inputText = ui.inputText.slice(0, ui.cursorPos) + data + ui.inputText.slice(ui.cursorPos);
				ui.cursorPos++;
			}
		}

		return component;
	}, {
		overlay: true,
		overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
	}).then(() => {
		process.stdout.write(MOUSE_DISABLE);
	});

	return {
		requestRender: () => tuiRef?.requestRender(),
	};
}

// ─── Chat pane ───────────────────────────────────────────────────────

function renderChat(
	width: number,
	theme: Theme,
	state: AssistantState,
	ui: { inputText: string; scrollOffset: number; isGenerating: boolean; cursorPos: number },
	profile: PersonalityProfile | undefined,
): string[] {
	const lines: string[] = [];
	const innerW = width - 2;
	const termRows = process.stdout.rows || 24;
	const headerLines = 4;
	const footerLines = 4;
	const contentLines = Math.max(5, Math.floor(termRows * 0.6) - headerLines - footerLines);

	// Header
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╯`));
	const title = profile
		? ` ${profile.icon} ${theme.fg(profile.color, theme.bold(profile.name))}`
		: " Assistant";
	lines.push(theme.fg("border", "│") + pad(title, innerW) + theme.fg("border", "│"));
	lines.push(
		theme.fg("border", "│") +
		pad(theme.fg("dim", ` Tab/Ctrl+T=settings • Esc=close`), innerW) +
		theme.fg("border", "│"),
	);
	lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

	// Messages
	const messages = state.messages;
	const contentW = innerW - 8;

	const visualLines: Array<{ text: string }> = [];
	for (const msg of messages) {
		const isUser = msg.role === "user";
		const wrapped = wrapTextWithAnsi(msg.content, contentW);
		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0
				? (isUser ? theme.fg("accent", " You: ") : ` ${profile?.icon ?? "🤖"}  `)
				: "      ";
			const color = isUser ? "text" : (profile?.color ?? "text");
			visualLines.push({
				text: ` ${prefix}${theme.fg(color, wrapped[i]!)}`,
			});
		}
		visualLines.push({ text: "" });
	}

	if (ui.isGenerating) {
		visualLines.push({
			text: ` ${profile?.icon ?? "🤖"} ${theme.fg("dim", "thinking...")}`,
		});
	}

	// Auto-scroll to bottom
	if (visualLines.length > contentLines) {
		ui.scrollOffset = Math.max(0, visualLines.length - contentLines);
	}

	const start = Math.max(0, Math.min(ui.scrollOffset, Math.max(0, visualLines.length - contentLines)));
	const visible = visualLines.slice(start, start + contentLines);

	for (const vl of visible) {
		lines.push(theme.fg("border", "│") + pad(vl.text || "", innerW) + theme.fg("border", "│"));
	}
	for (let i = visible.length; i < contentLines; i++) {
		lines.push(theme.fg("border", "│") + " ".repeat(innerW) + theme.fg("border", "│"));
	}

	// Footer
	lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

	const inputW = innerW - 2;
	const cursor = "█";
	if (ui.inputText.length <= inputW - 1) {
		const display = ui.inputText.length > 0
			? ui.inputText.slice(0, ui.cursorPos) + cursor + ui.inputText.slice(ui.cursorPos)
			: theme.fg("dim", "Type a message...");
		lines.push(theme.fg("border", "│") + pad(` ${display}`, innerW) + theme.fg("border", "│"));
	} else {
		const before = ui.inputText.slice(0, ui.cursorPos);
		const after = ui.inputText.slice(ui.cursorPos);
		const line1 = (before.slice(-(inputW)) + cursor).slice(0, inputW);
		const remaining = before.slice(0, -(inputW)) + after;
		lines.push(theme.fg("border", "│") + pad(` ${remaining.slice(-(inputW))}`, innerW) + theme.fg("border", "│"));
		lines.push(theme.fg("border", "│") + pad(` ${line1}`, innerW) + theme.fg("border", "│"));
	}

	const scrollInfo = messages.length > 0 ? ` • ${messages.length} msgs` : "";
	lines.push(
		theme.fg("border", "│") +
		pad(theme.fg("dim", ` Enter=send • Esc=close • ↑↓ scroll${scrollInfo}`), innerW) +
		theme.fg("border", "│"),
	);
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

	return lines;
}

// ─── Settings pane ───────────────────────────────────────────────────

function renderSettings(
	width: number,
	theme: Theme,
	state: AssistantState,
	ui: { settingsCursor: number },
	profile: PersonalityProfile | undefined,
): string[] {
	const lines: string[] = [];
	const innerW = width - 2;
	const termRows = process.stdout.rows || 24;
	const maxItems = Math.max(5, Math.floor(termRows * 0.6) - 8);

	// Header
	lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╯`));
	lines.push(
		theme.fg("border", "│") +
		pad(` ${theme.bold("⚙  Assistant Settings")}`, innerW) +
		theme.fg("border", "│"),
	);
	lines.push(
		theme.fg("border", "│") +
		pad(theme.fg("dim", ` Tab/Ctrl+T=chat • Enter/Space=select • ↑↓ navigate`), innerW) +
		theme.fg("border", "│"),
	);
	lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));
	lines.push(
		theme.fg("border", "│") +
		pad(theme.fg("dim", " Select which assistant to chat with:"), innerW) +
		theme.fg("border", "│"),
	);
	lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

	// List
	const assistants = Array.from(state.assistants.values());
	const selected = state.config.selectedAssistantId;
	const start = Math.max(0, Math.min(ui.settingsCursor, Math.max(0, assistants.length - maxItems)));
	const visible = assistants.slice(start, start + maxItems);

	for (let i = 0; i < visible.length; i++) {
		const a = visible[i]!;
		const isSelected = a.id === selected;
		const isHighlighted = (start + i) === ui.settingsCursor;
		const radio = isSelected ? "◉" : "○";
		const marker = isHighlighted ? " ▸ " : "   ";
		const name = isSelected
			? theme.fg(a.color, theme.bold(`${radio} ${a.icon} ${a.name}`))
			: `${radio} ${a.icon} ${theme.fg(a.color, a.name)}`;
		const desc = theme.fg("dim", ` — ${a.description}`);

		lines.push(
			theme.fg("border", "│") +
			pad(marker + name + desc, innerW) +
			theme.fg("border", "│"),
		);
	}

	for (let i = visible.length; i < maxItems; i++) {
		lines.push(theme.fg("border", "│") + " ".repeat(innerW) + theme.fg("border", "│"));
	}

	// Selected profile details
	if (profile) {
		lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));
		const goalsText = profile.goals.length > 0
			? profile.goals.slice(0, 3).map(g => `  • ${g}`).join("  ")
			: "  none";
		lines.push(
			theme.fg("border", "│") +
			pad(theme.fg("dim", ` Goals: ${goalsText}`), innerW) +
			theme.fg("border", "│"),
		);
	}

	// Footer
	lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));
	lines.push(
		theme.fg("border", "│") +
		pad(theme.fg("dim", " Custom: add .pi/assistants/<name>.json"), innerW) +
		theme.fg("border", "│"),
	);
	lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

	return lines;
}
