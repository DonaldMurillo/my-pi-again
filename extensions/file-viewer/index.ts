/**
 * File viewer extension — overlay file viewer with clickable links.
 *
 * Provides:
 *   - `/view <path>` command — open file in overlay (max 80% w/h)
 *   - `view_file` tool — agent can prompt to open files for user
 *   - Mouse click on files to open them in a nested viewer
 *   - Syntax highlighting for code files
 *   - Scroll, jump to line, search within file
 *   - File tree navigation with Enter/click to open files
 *
 * Usage:
 *   /view src/index.ts          — open file
 *   /view src/index.ts:42       — open at line 42
 *   /view .                     — show file tree
 *   Agent: view_file({ path: "src/index.ts" })
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	Text,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	readFileSync,
	existsSync,
	statSync,
	readdirSync,
	lstatSync,
	unlinkSync,
} from "node:fs";
import {
	join,
	relative,
	basename,
	extname,
	resolve,
	dirname,
} from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────

interface FileEntry {
	name: string;
	path: string;
	isDir: boolean;
	size: number;
}

interface MouseClick {
	row: number; // 1-based terminal row
	col: number; // 1-based terminal col
}

// ─── Mouse helpers ───────────────────────────────────────────────────

const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h"; // enable + SGR mode
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

/** SGR button field bits */
const BTN_MASK = 0b11;      // lower 2 bits: 0=left, 1=middle, 2=right, 3=release/wheel
const SHIFT_BIT = 0b0100;   // bit 2
const META_BIT  = 0b1000;   // bit 3 (alt)
const CTRL_BIT  = 0b10000;  // bit 4
const MOTION_BIT = 0b100000; // bit 5 (drag)

interface MouseEvent {
	button: number; // raw button byte
	col: number;
	row: number;
	release: boolean;
	isCtrl: boolean;
	isShift: boolean;
	isAlt: boolean;
	isLeftClick: boolean;
	isScrollUp: boolean;
	isScrollDown: boolean;
}

/** Parse SGR mouse event from handleInput data. */
function parseMouseEvent(data: string): MouseEvent | null {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return null;
	const raw = parseInt(match[1], 10);
	return {
		button: raw,
		col: parseInt(match[2], 10),
		row: parseInt(match[3], 10),
		release: match[4] === "m",
		isLeftClick: (raw & BTN_MASK) === 0,
		isScrollUp: raw === 64,
		isScrollDown: raw === 65,
		isCtrl: !!(raw & CTRL_BIT),
		isShift: !!(raw & SHIFT_BIT),
		isAlt: !!(raw & META_BIT),
	};
}

/** Open a file:line in the user's editor. */
function openInEditor(filePath: string, line?: number): void {
	const editor = process.env.EDITOR || process.env.VISUAL;
	if (editor) {
		const lineArg = line ? ` +${line}` : "";
		try {
			execSync(`${editor}${lineArg} "${filePath}"`, { stdio: "ignore", timeout: 3000 });
		} catch {
			// Fallback to OS open
			openWithOS(filePath);
		}
	} else {
		openWithOS(filePath);
	}
}

function openWithOS(filePath: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	try {
		execSync(`${cmd} "${filePath}"`, { stdio: "ignore", timeout: 3000 });
	} catch { /* give up */ }
}

// ─── Shared state (set on session_start) ─────────────────────────────

let _ctx: ExtensionContext | null = null;

function getCtx(): ExtensionContext {
	if (!_ctx) throw new Error("file-viewer: no session context");
	return _ctx;
}

/**
 * Open a file in the overlay viewer. Importable from other extensions:
 *
 *   import { viewFile } from "../file-viewer/index.js";
 *   viewFile("src/index.ts", 42);
 */
export function viewFile(path: string, line?: number): void {
	const ctx = getCtx();
	const resolved = resolve(ctx.cwd, path);
	if (!existsSync(resolved)) throw new Error(`File not found: ${path}`);
	if (lstatSync(resolved).isDirectory()) {
		openFileTree(ctx, resolved);
	} else {
		openViewer(ctx, resolved, line);
	}
}

/** Open a file tree for a directory. */
export function viewDir(dirPath?: string): void {
	const ctx = getCtx();
	const resolved = resolve(ctx.cwd, dirPath ?? ".");
	if (!existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
	openFileTree(ctx, resolved);
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── Inject tool docs into system prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## file-viewer extension

You have a \`view_file\` tool to open files in a syntax-highlighted overlay for the user.

Usage:
- \`view_file({ path: "src/index.ts" })\` — open file in overlay
- \`view_file({ path: "src/index.ts", line: 42 })\` — open at line 42
- \`view_file({ path: "." })\` — open file tree browser

The user sees the file in an 80%×80% overlay. They can scroll (mouse wheel or ↑↓/jk),
search (/), jump to matches (n/N), and click files to navigate. Ctrl+Click opens in editor.

Use \`view_file\` when the user asks to see, view, check, review, or inspect a file,
or when you want to show them specific code.
`;
	});
	// ── Store ctx for cross-extension access ──

	pi.on("session_start", async (_e, ctx) => {
		_ctx = ctx;

		// Check for pending view trigger
		const triggerPath = join(ctx.cwd, ".pi", "view-trigger.json");
		if (existsSync(triggerPath)) {
			try {
				const raw = readFileSync(triggerPath, "utf8");
				const trigger = JSON.parse(raw);
				// Only open if trigger is recent (< 30s old)
				if (trigger.requestedAt && Date.now() - trigger.requestedAt < 30_000) {
					const p = trigger.path;
					const l = trigger.line;
					if (p && existsSync(p)) {
						if (lstatSync(p).isDirectory()) {
							openFileTree(ctx, p);
						} else {
							openViewer(ctx, p, l ?? undefined);
						}
					}
				}
				// Clean up trigger
				try { unlinkSync(triggerPath); } catch {}
			} catch { /* ignore bad trigger */ }
		}
	});

	// ── Tool: view_file ────────────────────────────────────────────────

	pi.registerTool({
		name: "view_file",
		label: "View File",
		description:
			"Open a file in a syntax-highlighted overlay viewer. The user can scroll, search, and click file links to open in their editor. " +
			"Use this when the user asks to see, view, check, review, or inspect a file, or when you want to show them specific code. " +
			"Also supports directories — pass a directory path to show a browsable file tree. " +
			"File names are clickable in the overlay.",
		parameters: Type.Object({
			path: Type.String({ description: "File or directory path to view (relative to cwd). Pass '.' to browse the file tree." }),
			line: Type.Optional(Type.Number({ description: "Line number to scroll to (1-based). Only for files." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			if (!existsSync(filePath)) {
				return { content: [{ type: "text" as const, text: `File not found: ${params.path}` }], isError: true as const };
			}

			const stat = lstatSync(filePath);

			if (stat.isDirectory()) {
				openFileTree(ctx, filePath);
			} else {
				openViewer(ctx, filePath, params.line);
			}

			return {
				content: [{ type: "text" as const, text: `Opened ${params.path} in viewer` }],
				details: { path: filePath, displayPath: params.path, line: params.line },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("view_file ")) +
				theme.fg("muted", args.path) +
				(args.line ? theme.fg("dim", `:${args.line}`) : ""),
				0, 0,
			);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { path: string; displayPath: string; line?: number } | undefined;
			if (!details) return new Text(theme.fg("success", "✓ Opened in viewer"), 0, 0);
			const lineInfo = details.line ? theme.fg("dim", `:${details.line}`) : "";
			return new Text(
				theme.fg("success", "✓ Opened ") +
				theme.fg("accent", details.displayPath) + lineInfo +
				theme.fg("dim", " in overlay — click filenames to navigate, Esc to close"),
				0, 0,
			);
		},
	});

	// ── Command: /view ─────────────────────────────────────────────────

	pi.registerCommand("view", {
		description: "View a file in overlay: /view <path>[:line] or /view . for file tree",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/view requires interactive mode", "error");
				return;
			}

			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /view <path>[:line]  or  /view . for file tree", "info");
				return;
			}

			// Parse path:line
			let filePath: string;
			let targetLine: number | undefined;

			const colonMatch = input.match(/^(.+):(\d+)$/);
			if (colonMatch) {
				filePath = colonMatch[1];
				targetLine = parseInt(colonMatch[2], 10);
			} else {
				filePath = input;
			}

			const resolved = resolve(ctx.cwd, filePath);

			if (!existsSync(resolved)) {
				ctx.ui.notify(`Not found: ${filePath}`, "error");
				return;
			}

			if (lstatSync(resolved).isDirectory()) {
				openFileTree(ctx, resolved);
			} else {
				openViewer(ctx, resolved, targetLine);
			}
		},
	});
}

// ─── File Tree ────────────────────────────────────────────────────────

function openFileTree(ctx: ExtensionContext, dirPath: string): void {
	const entries = readDir(dirPath);

	ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		// Enable mouse tracking
		process.stdout.write(MOUSE_ENABLE);

		const state: {
			entries: FileEntry[];
			selected: number;
			scrollOffset: number;
			dirPath: string;
			history: string[];
		} = {
			entries,
			selected: 0,
			scrollOffset: 0,
			dirPath,
			history: [dirPath],
		};

		const component = {
			handleInput(data: string) {
				const maxVisible = getMaxVisible();

				// ── Mouse events ──
				const mouse = parseMouseEvent(data);
				if (mouse) {
					if (mouse.isScrollUp) {
						state.scrollOffset = Math.max(0, state.scrollOffset - 3);
						tui.requestRender(); return;
					}
					if (mouse.isScrollDown) {
						state.scrollOffset = Math.min(Math.max(0, state.entries.length - maxVisible), state.scrollOffset + 3);
						tui.requestRender(); return;
					}
					if (!mouse.release && mouse.isLeftClick) {
						const clickedIndex = mapClickToIndex(mouse, state.scrollOffset, maxVisible);
						if (clickedIndex !== null) {
							state.selected = clickedIndex;
							tui.requestRender();
							const entry = state.entries[state.selected];
							if (!entry) return;

							if (mouse.isCtrl || mouse.isShift) {
								if (!entry.isDir) openInEditor(entry.path);
							} else if (entry.isDir) {
								state.history.push(state.dirPath);
								state.dirPath = entry.path;
								state.entries = readDir(entry.path);
								state.selected = 0;
								state.scrollOffset = 0;
							} else {
								cleanup();
								done(entry.path);
							}
						}
					}
					return;
				}

				// ── Keyboard ──
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					cleanup();
					done(null);
					return;
				}

				if (matchesKey(data, "up") || matchesKey(data, "k")) {
					state.selected = Math.max(0, state.selected - 1);
					if (state.selected < state.scrollOffset) {
						state.scrollOffset = state.selected;
					}
				} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
					state.selected = Math.min(state.entries.length - 1, state.selected + 1);
					if (state.selected >= state.scrollOffset + maxVisible) {
						state.scrollOffset = state.selected - maxVisible + 1;
					}
				} else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
					const entry = state.entries[state.selected];
					if (!entry) return;

					if (entry.isDir) {
						state.history.push(state.dirPath);
						state.dirPath = entry.path;
						state.entries = readDir(entry.path);
						state.selected = 0;
						state.scrollOffset = 0;
					} else {
						cleanup();
						done(entry.path);
					}
				} else if (matchesKey(data, "backspace") || matchesKey(data, "h")) {
					if (state.history.length > 0) {
						const prev = state.history.pop()!;
						state.dirPath = prev;
						state.entries = readDir(prev);
						state.selected = 0;
						state.scrollOffset = 0;
					} else {
						cleanup();
						done(null);
					}
				} else if (matchesKey(data, "g")) {
					state.selected = 0;
					state.scrollOffset = 0;
				} else if (matchesKey(data, "G")) {
					state.selected = state.entries.length - 1;
					state.scrollOffset = Math.max(0, state.selected - getMaxVisible() + 1);
				}

				tui.requestRender();
			},

			render(width: number): string[] {
				const lines: string[] = [];
				const innerW = width - 2;
				const maxVis = getMaxVisible();

				// Header
				lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
				const header = ` 📁 ${relative(process.cwd(), state.dirPath) || state.dirPath}`;
				lines.push(
					theme.fg("border", "│") +
					padLine(theme.fg("accent", truncateToWidth(header, innerW)), innerW) +
					theme.fg("border", "│"),
				);
				lines.push(
					theme.fg("border", "│") +
					padLine(theme.fg("dim", ` ${state.entries.length} items • Click=open • Ctrl+Click=editor • Backspace up • Esc close`), innerW) +
					theme.fg("border", "│"),
				);
				lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

				// Entries
				const visible = state.entries.slice(state.scrollOffset, state.scrollOffset + maxVis);
				for (let i = 0; i < visible.length; i++) {
					const entry = visible[i]!;
					const isSelected = state.scrollOffset + i === state.selected;
					const icon = entry.isDir ? "📁" : getFileIcon(entry.name);
					const name = entry.isDir
						? (isSelected ? theme.fg("accent", theme.bold(entry.name)) : theme.fg("accent", entry.name))
						: (isSelected ? theme.bold(entry.name) : entry.name);
					const suffix = entry.isDir ? theme.fg("dim", "/") : "";

					const prefix = isSelected ? theme.bg("selectedBg", " ▶ ") : "   ";
					const line = `${prefix}${icon} ${name}${suffix}`;

					lines.push(
						theme.fg("border", "│") +
						padLine(line, innerW) +
						theme.fg("border", "│"),
					);
				}

				// Pad remaining
				for (let i = visible.length; i < maxVis; i++) {
					lines.push(
						theme.fg("border", "│") +
						" ".repeat(innerW) +
						theme.fg("border", "│"),
					);
				}

				// Scroll indicator
				if (state.entries.length > maxVis) {
					const pct = Math.round(((state.scrollOffset + maxVis) / state.entries.length) * 100);
					lines.push(
						theme.fg("border", "│") +
						padLine(theme.fg("dim", ` ${pct}% (${state.scrollOffset + 1}-${state.scrollOffset + maxVis} of ${state.entries.length})`), innerW) +
						theme.fg("border", "│"),
					);
				}

				lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
				return lines;
			},

			invalidate(): void {},
			dispose(): void {
				cleanup();
			},
		};

		function cleanup() {
			process.stdout.write(MOUSE_DISABLE);
		}

		function getMaxVisible(): number {
			return Math.max(5, Math.floor((process.stdout.rows || 24) * 0.6) - 7);
		}

		return component;
	}, {
		overlay: true,
		overlayOptions: {
			width: "80%",
			maxHeight: "80%",
			anchor: "center",
		},
	}).then((result) => {
		process.stdout.write(MOUSE_DISABLE);
		if (result) {
			// User selected a file — open it in viewer
			openViewer(ctx, result);
		}
	});
}

// ─── File Viewer ──────────────────────────────────────────────────────

function openViewer(ctx: ExtensionContext, filePath: string, targetLine?: number): void {
	const content = readFileSync(filePath, "utf8");
	const lines = content.split("\n");
	const lang = getLanguageFromPath(filePath);

	// Syntax highlight the whole file
	let highlighted: string[];
	try {
		highlighted = highlightCode(content, lang);
		if (highlighted.length < lines.length) {
			highlighted = lines;
		}
	} catch {
		highlighted = lines;
	}

	const dirPath = dirname(filePath);
	const dirEntries = readDir(dirPath);

	ctx.ui.custom<void>((tui, theme, _kb, done) => {
		// Enable mouse tracking
		process.stdout.write(MOUSE_ENABLE);

		const state: {
			scrollOffset: number;
			selectedLine: number | null;
			searchQuery: string;
			searchMode: boolean;
			searchMatches: number[];
			searchMatchIndex: number;
			totalVisualLines: number;
		} = {
			scrollOffset: Math.max(0, (targetLine ?? 1) - 3),
			selectedLine: targetLine ?? null,
			searchQuery: "",
			searchMode: false,
			searchMatches: [],
			searchMatchIndex: 0,
			totalVisualLines: lines.length, // updated each render
		};

		const component = {
			handleInput(data: string) {
				const maxVisible = getMaxVisible();

				// ── Mouse events ──
				const mouse = parseMouseEvent(data);
				if (mouse) {
					if (mouse.isScrollUp) {
						state.scrollOffset = Math.max(0, state.scrollOffset - 3);
						tui.requestRender(); return;
					}
					if (mouse.isScrollDown) {
						state.scrollOffset = Math.min(maxScroll(), state.scrollOffset + 3);
						tui.requestRender(); return;
					}
					if (!mouse.release && mouse.isLeftClick) {
						handleMouseClick(mouse);
						tui.requestRender(); return;
					}
					return;
				}

				// ── Search mode ──
				if (state.searchMode) {
					handleSearchInput(data);
					tui.requestRender();
					return;
				}

				// ── Keyboard ──
				if (matchesKey(data, "escape") || matchesKey(data, "q")) {
					cleanup();
					done();
					return;
				}

				if (matchesKey(data, "down") || matchesKey(data, "j")) {
					state.scrollOffset = Math.min(maxScroll(), state.scrollOffset + 1);
				} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
					state.scrollOffset = Math.max(0, state.scrollOffset - 1);
				} else if (matchesKey(data, "ctrl+d") || matchesKey(data, "J")) {
					state.scrollOffset = Math.min(maxScroll(), state.scrollOffset + maxVisible);
				} else if (matchesKey(data, "ctrl+u") || matchesKey(data, "K")) {
					state.scrollOffset = Math.max(0, state.scrollOffset - maxVisible);
				} else if (matchesKey(data, "g")) {
					state.scrollOffset = 0;
				} else if (matchesKey(data, "G")) {
					state.scrollOffset = maxScroll();
				} else if (matchesKey(data, "/")) {
					state.searchMode = true;
					state.searchQuery = "";
					state.searchMatches = [];
					state.searchMatchIndex = 0;
				} else if (matchesKey(data, "n")) {
					if (state.searchMatches.length > 0) {
						state.searchMatchIndex = (state.searchMatchIndex + 1) % state.searchMatches.length;
						scrollToSearch();
					}
				} else if (matchesKey(data, "N")) {
					if (state.searchMatches.length > 0) {
						state.searchMatchIndex = (state.searchMatchIndex - 1 + state.searchMatches.length) % state.searchMatches.length;
						scrollToSearch();
					}
				}

				tui.requestRender();
			},

			render(width: number): string[] {
				const result: string[] = [];
				const innerW = width - 2;
				const maxVis = getMaxVisible();
				const lineNumWidth = String(lines.length).length;

				// Header
				const fileName = basename(filePath);
				const lineInfo = `${lines.length} lines`;

				result.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
				result.push(
					theme.fg("border", "│") +
					padLine(` 📄 ${theme.fg("accent", theme.underline(fileName))} ${theme.fg("dim", `(${lineInfo})`)}`, innerW) +
					theme.fg("border", "│"),
				);

				// Help bar
				const help = state.searchMode
					? theme.fg("warning", ` Search: ${state.searchQuery}█`) +
					  theme.fg("dim", ` (${state.searchMatches.length} matches) Enter/Esc done`)
					: theme.fg("dim", " ↑↓ scroll • / search • n/N next • g/G top/bot • Click=open in overlay • Ctrl+Click=editor • Esc close");
				result.push(
					theme.fg("border", "│") +
					padLine(help, innerW) +
					theme.fg("border", "│"),
				);
				result.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

				// Content lines — support wrapping
				const start = state.scrollOffset;
				const lineNumColWidth = 3 + lineNumWidth + 3; // " 123 │ "
				const contentWidth = innerW - lineNumColWidth;

				// Build visual lines from source lines (wrapping long lines)
				const visualLines: Array<{ srcLine: number; isFirst: boolean; text: string; isTarget: boolean; isMatch: boolean; isCurrentMatch: boolean }> = [];
				for (let i = 0; i < lines.length; i++) {
					let lineContent = highlighted[i] ?? lines[i] ?? "";
					const isTarget = targetLine === i + 1;
					const isSearchMatch = state.searchMatches.includes(i);
					const isCurrentMatch = state.searchMatches.length > 0 && state.searchMatches[state.searchMatchIndex] === i;

					if (isTarget) {
						lineContent = theme.bg("selectedBg", lineContent);
					} else if (isCurrentMatch) {
						lineContent = theme.bg("selectedBg", theme.fg("warning", lineContent));
					}

					// Wrap if wider than content area
					const rawVis = visibleWidth(lines[i] ?? "");
					if (rawVis > contentWidth) {
						const wrapped = wrapTextWithAnsi(lineContent, contentWidth);
						for (let w = 0; w < wrapped.length; w++) {
							visualLines.push({ srcLine: i, isFirst: w === 0, text: wrapped[w]!, isTarget, isMatch: isSearchMatch, isCurrentMatch });
						}
					} else {
						visualLines.push({ srcLine: i, isFirst: true, text: lineContent, isTarget, isMatch: isSearchMatch, isCurrentMatch });
					}
				}

				state.totalVisualLines = visualLines.length;
				const visEnd = Math.min(start + maxVis, visualLines.length);

				for (let vi = start; vi < visEnd; vi++) {
					const vl = visualLines[vi]!;

					// Line number only on first visual line of a source line
					const numStr = vl.isFirst
						? String(vl.srcLine + 1).padStart(lineNumWidth)
						: theme.fg("dim", "·".padStart(lineNumWidth));

					const numColor = !vl.isFirst ? numStr :
						vl.isTarget ? theme.fg("accent", theme.underline(numStr)) :
						vl.isMatch ? theme.fg("warning", theme.underline(numStr)) :
						theme.fg("dim", theme.underline(numStr));

					const sep = theme.fg("dim", vl.isFirst ? " │ " : "   ");

					result.push(
						theme.fg("border", "│") +
						padLine(` ${numColor}${sep}${vl.text}`, innerW) +
						theme.fg("border", "│"),
					);
				}

				// Fill remaining space
				for (let i = visEnd; i < start + maxVis; i++) {
					result.push(
						theme.fg("border", "│") +
						" ".repeat(innerW) +
						theme.fg("border", "│"),
					);
				}

				// Footer with scroll position
				const pct = visualLines.length <= maxVis ? "All" :
					`${Math.round((visEnd / visualLines.length) * 100)}%`;

				// Directory files — clickable links at bottom
				const siblings = dirEntries
					.filter((e) => !e.isDir)
					.slice(0, Math.min(5, Math.floor(innerW / 12)));
				if (siblings.length > 0) {
					const links = siblings.map((s) =>
						s.path === filePath
							? theme.fg("accent", theme.bold(s.name))
							: theme.fg("accent", theme.underline(s.name)),
					).join(theme.fg("dim", " · "));
					result.push(
						theme.fg("border", "│") +
						padLine(` ${theme.fg("dim", "Files:")} ${links}`, innerW) +
						theme.fg("border", "│"),
					);
				}

				const posInfo = `${start + 1}-${visEnd} of ${visualLines.length} visual lines (${lines.length} source, ${pct})`;
				result.push(
					theme.fg("border", "│") +
					padLine(theme.fg("dim", ` ${posInfo}`), innerW) +
					theme.fg("border", "│"),
				);

				result.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
				return result;
			},

			invalidate(): void {},
			dispose(): void {
				cleanup();
			},
		};

		function cleanup() {
			process.stdout.write(MOUSE_DISABLE);
		}

		function getMaxVisible(): number {
			return Math.max(5, Math.floor((process.stdout.rows || 24) * 0.6) - 8);
		}

		function maxScroll(): number {
			return Math.max(0, state.totalVisualLines - getMaxVisible());
		}

		function handleMouseClick(mouse: MouseEvent): void {
			const overlayTop = getOverlayTop();
			const overlayLeft = getOverlayLeft();

			const relRow = mouse.row - overlayTop;
			const relCol = mouse.col - overlayLeft;

			const headerLines = 4;
			const contentRow = relRow - headerLines;

			const maxVis = getMaxVisible();

			// ── Content area click ──
			if (contentRow >= 0 && contentRow < maxVis) {
				const contentLine = state.scrollOffset + contentRow;

				// Ctrl+click anywhere on a code line → open file at that line in editor
				if (mouse.isCtrl || mouse.isShift) {
					openInEditor(filePath, contentLine + 1);
					return;
				}
			}

			// ── Footer: "Files:" sibling links ──
			const footerStart = headerLines + maxVis;
			if (relRow === footerStart && dirEntries.length > 0) {
				const clickedFile = mapColToSibling(relCol, dirEntries.filter((e) => !e.isDir));
				if (clickedFile) {
					if (mouse.isCtrl || mouse.isShift) {
						// Ctrl+click → external editor
						openInEditor(clickedFile.path);
					} else {
						// Normal click → open in overlay
						cleanup();
						done();
						openViewer(ctx, clickedFile.path);
					}
					return;
				}
			}
		}

		function getOverlayTop(): number {
			const termRows = process.stdout.rows || 24;
			const contentRows = getMaxVisible() + 8; // header + footer + borders
			return Math.max(0, Math.floor((termRows - contentRows) / 2));
		}

		function getOverlayLeft(): number {
			const termCols = process.stdout.columns || 80;
			const overlayWidth = Math.floor(termCols * 0.8);
			return Math.floor((termCols - overlayWidth) / 2);
		}

		function mapColToSibling(col: number, files: FileEntry[]): FileEntry | null {
			// The "Files: " prefix takes about 7 cols, then each file is separated by " · "
			// We approximate: each file occupies name.length + 3 chars
			let offset = 8; // " Files: " + theme codes
			for (const file of files) {
				const entryWidth = file.name.length + 3; // name + " · "
				if (col >= offset && col < offset + file.name.length) {
					return file;
				}
				offset += entryWidth;
			}
			return null;
		}

		function handleSearchInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
				state.searchMode = false;
				if (state.searchMatches.length > 0) {
					scrollToSearch();
				}
				return;
			}

			if (matchesKey(data, "backspace")) {
				state.searchQuery = state.searchQuery.slice(0, -1);
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				state.searchQuery += data;
			}

			// Find matches
			state.searchMatches = [];
			state.searchMatchIndex = 0;
			if (state.searchQuery.length > 0) {
				const query = state.searchQuery.toLowerCase();
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].toLowerCase().includes(query)) {
						state.searchMatches.push(i);
					}
				}
			}
		}

		function scrollToSearch(): void {
			if (state.searchMatches.length === 0) return;
			const targetLineIdx = state.searchMatches[state.searchMatchIndex]!;
			const maxVis = getMaxVisible();
			state.scrollOffset = Math.max(0, Math.min(
				targetLineIdx - Math.floor(maxVis / 2),
				maxScroll(),
			));
		}

		return component;
	}, {
		overlay: true,
		overlayOptions: {
			width: "80%",
			maxHeight: "80%",
			anchor: "center",
		},
	}).then(() => {
		process.stdout.write(MOUSE_DISABLE);
	});
}

// ─── File Tree click mapping ──────────────────────────────────────────

function mapClickToIndex(
	mouse: { row: number; col: number },
	scrollOffset: number,
	maxVisible: number,
): number | null {
	const termRows = process.stdout.rows || 24;
	const contentRows = maxVisible + 7; // header (4) + border + footer + bottom border
	const overlayTop = Math.max(0, Math.floor((termRows - contentRows) / 2));

	const relRow = mouse.row - overlayTop;
	const headerLines = 4; // border + title + help + separator
	const contentRow = relRow - headerLines;

	if (contentRow < 0 || contentRow >= maxVisible) return null;

	const index = scrollOffset + contentRow;
	return index;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
	"node_modules", ".git", "dist", "build", ".next", ".nuxt",
	"coverage", ".cache", ".turbo", ".pi", ".claude",
]);

const IGNORED_FILES = new Set([
	".DS_Store", "Thumbs.db",
]);

function readDir(dirPath: string): FileEntry[] {
	const entries: FileEntry[] = [];
	try {
		const files = readdirSync(dirPath).sort();
		for (const name of files) {
			if (IGNORED_FILES.has(name) || (name.startsWith(".") && name !== ".env")) continue;
			const fullPath = join(dirPath, name);
			try {
				const stat = lstatSync(fullPath);
				if (stat.isDirectory()) {
					if (IGNORED_DIRS.has(name)) continue;
					entries.push({ name, path: fullPath, isDir: true, size: 0 });
				} else {
					entries.push({ name, path: fullPath, isDir: false, size: stat.size });
				}
			} catch { /* skip unreadable */ }
		}
	} catch { /* dir not readable */ }

	// Dirs first, then files
	return [
		...entries.filter((e) => e.isDir),
		...entries.filter((e) => !e.isDir),
	];
}

function padLine(s: string, width: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, width - vis));
}

function getFileIcon(name: string): string {
	const ext = extname(name).toLowerCase();
	const icons: Record<string, string> = {
		".ts": "🔷", ".tsx": "⚛️", ".js": "🟨", ".jsx": "⚛️",
		".json": "📋", ".md": "📝", ".css": "🎨", ".scss": "🎨",
		".html": "🌐", ".py": "🐍", ".go": "🔵", ".rs": "🦀",
		".yaml": "📄", ".yml": "📄", ".toml": "📄", ".env": "🔒",
		".sh": "📜", ".bash": "📜", ".zsh": "📜",
		".sql": "🗄️", ".graphql": "🔮",
		".png": "🖼️", ".jpg": "🖼️", ".svg": "🖼️",
		".lock": "🔒", ".map": "🗺️",
	};
	return icons[ext] ?? "📄";
}
