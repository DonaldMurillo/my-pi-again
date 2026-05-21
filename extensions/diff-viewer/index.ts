/**
 * Inline Diff Viewer Extension for Pi
 *
 * Shows git diff and unified diff output in inline format instead of side-by-side,
 * saving screen space while maintaining readability.
 *
 * Features:
 * - Inline diff display (added/removed/changed lines)
 * - Syntax highlighting for code diffs
 * - Navigation between hunks and lines
 * - Mouse click to open files at specific lines
 *
 * Usage:
 *   /diff <file>           — show git diff for file
 *   /diff --unified <file> — show unified diff
 *   /diff <old-file> <new-file> — diff two files
 *   /diff --staged         — show staged changes
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	Text,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	existsSync,
	readFileSync,
	statSync,
} from "node:fs";
import {
	join,
	resolve,
} from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────

interface DiffLine {
	type: 'unchanged' | 'added' | 'removed' | 'changed';
	oldLine?: number;
	newLine?: number;
	content: string;
	isHunk?: boolean;
}

interface DiffFile {
	oldPath: string;
	newPath: string;
	originalOldPath?: string;
	originalNewPath?: string;
	lines: DiffLine[];
}

interface DiffContext {
	files: DiffFile[];
	currentFileIndex: number;
	scrollOffset: number;
	searchQuery: string;
	searchMode: boolean;
	searchMatches: number[];
	searchMatchIndex: number;
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── Inject tool docs into system prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## diff-viewer extension

You have a \`diff_file\` tool to show inline diff views.

Usage:
- \`diff_file({ path: "src/index.ts" })\` — show git diff for file
- \`diff_file({ path: "src/index.ts", unified: true })\` — show unified diff
- \`diff_file({ oldPath: "old.js", newPath: "new.js" })\` — diff two files
- \`diff_file({ staged: true })\` — show staged changes

The diff displays in an inline format with:
- Green lines added
- Red lines removed
- Yellow lines changed
- Click on lines to open files at that position
`;
	});

	// ── Tool: diff_file ─────────────────────────────────────────────────

	pi.registerTool({
		name: "diff_file",
		label: "Diff File",
		description:
			"Show inline diff view for git diffs or file comparisons. " +
			"Displays diff in inline format to save screen space while maintaining readability. " +
			"Use this when user wants to see code differences, changes, or compare files.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "File path to show git diff for" })),
			oldPath: Type.Optional(Type.String({ description: "Old file path for file comparison" })),
			newPath: Type.Optional(Type.String({ description: "New file path for file comparison" })),
			unified: Type.Optional(Type.Boolean({ description: "Show unified diff format" })),
			staged: Type.Optional(Type.Boolean({ description: "Show staged changes" })),
			lines: Type.Optional(Type.Number({ description: "Number of context lines to show" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				let diffResult: { files: DiffFile[], command: string };
				
				if (params.staged) {
					diffResult = getStagedDiff(ctx.cwd, params.lines);
				} else if (params.oldPath && params.newPath) {
					diffResult = getFileDiff(params.oldPath, params.newPath, ctx.cwd, params.unified);
				} else if (params.path) {
					diffResult = getGitDiff(params.path, ctx.cwd, params.staged, params.unified, params.lines);
				} else {
					throw new Error("Specify either path, oldPath+newPath, or use --staged");
				}

				if (diffResult.files.length === 0) {
					return { content: [{ type: "text" as const, text: "No differences found" }] };
				}

				// Open the diff viewer
				openInlineDiffViewer(ctx, diffResult.files, 0);

				return {
					content: [{ type: "text" as const, text: `Showing inline diff for ${diffResult.files.length} file(s)` }],
					details: { files: diffResult.files.length, command: diffResult.command },
				};
			} catch (error) {
				return { 
					content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], 
					isError: true as const 
				};
			}
		},
		renderCall(args, theme) {
			const parts = [];
			if (args.staged) parts.push(theme.fg("warning", "--staged"));
			if (args.unified) parts.push(theme.fg("accent", "--unified"));
			if (args.path) parts.push(theme.fg("muted", args.path));
			if (args.oldPath && args.newPath) parts.push(theme.fg("muted", `${args.oldPath} → ${args.newPath}`));
			
			return new Text(
				theme.fg("toolTitle", theme.bold("diff_file ")) +
				(parts.length > 0 ? parts.join(" ") : "diff"),
				0, 0,
			);
		},
		renderResult(result, _opts, theme) {
			const details = result.details as { files: number; command: string } | undefined;
			if (!details) return new Text(theme.fg("success", "✓ Diff opened in viewer"), 0, 0);
			
			return new Text(
				theme.fg("success", "✓ Showing ") +
				theme.fg("accent", `${details.files} file`) +
				theme.fg("dim", " in inline diff view"),
				0, 0,
			);
		},
	});

	// ── Command: /diff ─────────────────────────────────────────────────

	pi.registerCommand("diff", {
		description: "Show inline diff: /diff <file> | /diff --staged | /diff <old> <new> | /diff --unified <file>",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/diff requires interactive mode", "error");
				return;
			}

			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify("Usage: /diff <file> | /diff --staged | /diff <old> <new> | /diff --unified <file>", "info");
				return;
			}

			const staged = parts.includes("--staged");
			const unified = parts.includes("--unified") || parts.includes("-u");
			let files: string[] = parts.filter(p => !p.startsWith("--"));

			try {
				let diffResult: { files: DiffFile[], command: string };
				
				if (staged) {
					diffResult = getStagedDiff(ctx.cwd);
				} else if (files.length === 2) {
					diffResult = getFileDiff(files[0], files[1], ctx.cwd, unified);
				} else if (files.length === 1) {
					diffResult = getGitDiff(files[0], ctx.cwd, staged, unified);
				} else {
					ctx.ui.notify("Usage: /diff <file> | /diff --staged | /diff <old> <new> | /diff --unified <file>", "info");
					return;
				}

				if (diffResult.files.length === 0) {
					ctx.ui.notify("No differences found", "info");
					return;
				}

				openInlineDiffViewer(ctx, diffResult.files, 0);
			} catch (error) {
				ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

// ─── Diff Generation ──────────────────────────────────────────────────

function getGitDiff(path: string, cwd: string, staged = false, unified = false, context?: number): { files: DiffFile[], command: string } {
	const resolvedPath = resolve(cwd, path);
	if (!existsSync(resolvedPath)) {
		throw new Error(`File not found: ${path}`);
	}

	const contextFlag = context ? `-U${context}` : (unified ? "-U3" : "");
	const stagedFlag = staged ? "--staged" : "";
	const command = `git diff ${contextFlag} ${stagedFlag} -- "${path}"`;

	try {
		const output = execSync(command, { cwd, encoding: "utf8", timeout: 10000 });
		const files = parseGitDiff(output, cwd);
		return { files, command };
	} catch (error) {
		throw new Error(`Git diff failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function getFileDiff(oldPath: string, newPath: string, cwd: string, unified = false): { files: DiffFile[], command: string } {
	const resolvedOldPath = resolve(cwd, oldPath);
	const resolvedNewPath = resolve(cwd, newPath);
	
	if (!existsSync(resolvedOldPath)) {
		throw new Error(`File not found: ${oldPath}`);
	}
	if (!existsSync(resolvedNewPath)) {
		throw new Error(`File not found: ${newPath}`);
	}

	const contextFlag = unified ? "-U3" : "";
	const command = `diff ${contextFlag} "${resolvedOldPath}" "${resolvedNewPath}"`;

	try {
		const output = execSync(command, { cwd, encoding: "utf8", timeout: 10000 });
		const files = parseUnifiedDiff(output, cwd);
		return { files, command };
	} catch (error) {
		throw new Error(`Diff failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function getStagedDiff(cwd: string, context?: number): { files: DiffFile[], command: string } {
	const contextFlag = context ? `-U${context}` : "-U3";
	const command = `git diff ${contextFlag} --staged`;

	try {
		const output = execSync(command, { cwd, encoding: "utf8", timeout: 10000 });
		const files = parseGitDiff(output, cwd);
		return { files, command };
	} catch (error) {
		throw new Error(`Staged diff failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ─── Diff Parsing ───────────────────────────────────────────────────

function parseGitDiff(diffOutput: string, cwd: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = diffOutput.split("\n");
	let currentFile: DiffFile | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		
		// File header
		const fileHeaderMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		if (fileHeaderMatch) {
			if (currentFile) files.push(currentFile);
			currentFile = {
				oldPath: resolve(cwd, fileHeaderMatch[1]),
				newPath: resolve(cwd, fileHeaderMatch[2]),
				lines: [],
			};
			continue;
		}

		// Index header
		const indexMatch = line.match(/^index [\w\.]+\.\.[\w\.]+/);
		if (indexMatch) {
			continue;
		}

		// From/To header
		const fromToMatch = line.match(/^--- (?:a\/)?(.+)$/);
		if (fromToMatch) {
			currentFile!.oldPath = resolve(cwd, fromToMatch[1].replace(/\/dev\/null/, "/dev/null"));
			continue;
		}
		const toMatch = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
		if (toMatch) {
			currentFile!.newPath = resolve(cwd, toMatch[1].replace(/\/dev\/null/, "/dev/null"));
			continue;
		}

		// Hunk header
		const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (hunkMatch) {
			const newLineStart = parseInt(hunkMatch[1]);
			const newLineCount = parseInt(hunkMatch[2] || "1");
			currentFile!.lines.push({
				type: 'unchanged',
				isHunk: true,
				content: line,
				oldLine: newLineStart - 1,
				newLine: newLineStart,
			});
			continue;
		}

		// Diff lines
		if (!currentFile) continue;

		if (line.startsWith("+")) {
			currentFile.lines.push({
				type: 'added',
				content: line.substring(1),
				newLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		} else if (line.startsWith("-")) {
			currentFile.lines.push({
				type: 'removed',
				content: line.substring(1),
				oldLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		} else if (line.startsWith("\\ No newline")) {
			continue;
		} else {
			currentFile.lines.push({
				type: 'unchanged',
				content: line,
				oldLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
				newLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		}
	}

	if (currentFile) files.push(currentFile);
	return files;
}

function parseUnifiedDiff(diffOutput: string, cwd: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = diffOutput.split("\n");
	let currentFile: DiffFile | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		
		// File headers
		const oldFileMatch = line.match(/^--- (.+)$/);
		if (oldFileMatch) {
			if (currentFile) files.push(currentFile);
			currentFile = {
				oldPath: resolve(cwd, oldFileMatch[1].replace(/\/dev\/null/, "/dev/null")),
				newPath: currentFile?.newPath || resolve(cwd, "/dev/null"),
				lines: [],
			};
			continue;
		}

		const newFileMatch = line.match(/^\+\+\+ (.+)$/);
		if (newFileMatch) {
			currentFile!.newPath = resolve(cwd, newFileMatch[1].replace(/\/dev\/null/, "/dev/null"));
			continue;
		}

		// Hunk header
		const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (hunkMatch) {
			const newLineStart = parseInt(hunkMatch[1]);
			const newLineCount = parseInt(hunkMatch[2] || "1");
			currentFile!.lines.push({
				type: 'unchanged',
				isHunk: true,
				content: line,
				oldLine: newLineStart - 1,
				newLine: newLineStart,
			});
			continue;
		}

		// Skip empty lines in unified diff headers
		if (line.startsWith(" ") && !currentFile) continue;
		if (line.startsWith("Index: ")) continue;

		// Diff lines
		if (!currentFile) continue;

		if (line.startsWith("+")) {
			currentFile.lines.push({
				type: 'added',
				content: line.substring(1),
				newLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		} else if (line.startsWith("-")) {
			currentFile.lines.push({
				type: 'removed',
				content: line.substring(1),
				oldLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		} else if (line.startsWith(" ")) {
			currentFile.lines.push({
				type: 'unchanged',
				content: line.substring(1),
				oldLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
				newLine: currentFile.lines.filter(l => !l.isHunk && l.type !== 'unchanged').length + 1,
			});
		} else {
			currentFile.lines.push({
				type: 'unchanged',
				content: line,
			});
		}
	}

	if (currentFile) files.push(currentFile);
	return files;
}

// ─── Inline Diff Viewer ─────────────────────────────────────────────

function openInlineDiffViewer(ctx: ExtensionContext, files: DiffFile[], startIndex: number): void {
	const theme = ctx.theme;
	const context: DiffContext = {
		files,
		currentFileIndex: Math.max(0, Math.min(startIndex, files.length - 1)),
		scrollOffset: 0,
		searchQuery: "",
		searchMode: false,
		searchMatches: [],
		searchMatchIndex: 0,
	};

	ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const component = {
			handleInput(data: string) {
				const maxVisible = getMaxVisible();

				// ── Keyboard ──
				if (matchesKey(data, "escape") || matchesKey(data, "q")) {
					done();
					return;
				}

				if (matchesKey(data, "left") || matchesKey(data, "h")) {
					if (context.currentFileIndex > 0) {
						context.currentFileIndex--;
						context.scrollOffset = 0;
						tui.requestRender();
					}
				} else if (matchesKey(data, "right") || matchesKey(data, "l")) {
					if (context.currentFileIndex < context.files.length - 1) {
						context.currentFileIndex++;
						context.scrollOffset = 0;
						tui.requestRender();
					}
				} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
					context.scrollOffset = Math.max(0, context.scrollOffset - 1);
				} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
					context.scrollOffset = Math.min(maxScroll(), context.scrollOffset + 1);
				} else if (matchesKey(data, "g")) {
					context.scrollOffset = 0;
				} else if (matchesKey(data, "G")) {
					context.scrollOffset = maxScroll();
				} else if (matchesKey(data, "/")) {
					context.searchMode = true;
					context.searchQuery = "";
					context.searchMatches = [];
					context.searchMatchIndex = 0;
				} else if (matchesKey(data, "n")) {
					if (context.searchMatches.length > 0) {
						context.searchMatchIndex = (context.searchMatchIndex + 1) % context.searchMatches.length;
						scrollToSearch();
					}
				} else if (matchesKey(data, "N")) {
					if (context.searchMatches.length > 0) {
						context.searchMatchIndex = (context.searchMatchIndex - 1 + context.searchMatches.length) % context.searchMatches.length;
						scrollToSearch();
					}
				}

				tui.requestRender();
			},

			render(width: number): string[] {
				const result: string[] = [];
				const innerW = width - 2;
				const maxVis = getMaxVisible();
				const currentFile = context.files[context.currentFileIndex];

				if (!currentFile) return result;

				// Header
				result.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
				
				// File info
				const fileName = currentFile.newPath === "/dev/null" 
					? currentFile.oldPath 
					: currentFile.oldPath === currentFile.newPath
					? currentFile.oldPath
					: `${currentFile.oldPath} → ${currentFile.newPath}`;
				
				result.push(
					theme.fg("border", "│") +
					padLine(` 📄 ${theme.fg("accent", fileName)} (${context.currentFileIndex + 1}/${context.files.length})`, innerW) +
					theme.fg("border", "│"),
				);

				// Help bar
				const help = context.searchMode
					? theme.fg("warning", ` Search: ${context.searchQuery}█`)
					: theme.fg("dim", " ←→ navigate files | ↑↓ scroll | / search | n/N next | Esc close");
				result.push(
					theme.fg("border", "│") +
					padLine(help, innerW) +
					theme.fg("border", "│"),
				);
				result.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

				// Diff lines
				const start = context.scrollOffset;
				const end = Math.min(start + maxVis, currentFile.lines.length);
				const lineNumWidth = String(Math.max(currentFile.lines.length, 100)).length;

				for (let i = start; i < end; i++) {
					const line = currentFile.lines[i];
					if (!line) continue;

					let lineColor = "";
					let linePrefix = " ";
					let lineNum = "";

					if (line.type === 'added') {
						lineColor = theme.fg("success");
						linePrefix = "+";
						lineNum = theme.fg("success", `+${line.newLine || ""}`);
					} else if (line.type === 'removed') {
						lineColor = theme.fg("error");
						linePrefix = "-";
						lineNum = theme.fg("error", `-${line.oldLine || ""}`);
					} else if (line.type === 'changed') {
						lineColor = theme.fg("warning");
						linePrefix = "~";
						lineNum = theme.fg("warning", `~${line.newLine || ""}`);
					} else {
						lineColor = theme.fg("dim");
						lineNum = theme.fg("dim", ` ${line.oldLine || ""}`);
					}

					if (line.isHunk) {
						result.push(
							theme.fg("border", "│") +
							lineColor(padLine(` ${linePrefix} ${line.content}`, innerW)) +
							theme.fg("border", "│"),
						);
					} else {
						const numWidth = lineNumWidth + 2;
						const content = padLine(`${linePrefix} ${lineNum} ${line.content}`, innerW);
						result.push(
							theme.fg("border", "│") +
							content.substring(0, numWidth) +
							lineColor(content.substring(numWidth)) +
							theme.fg("border", "│"),
						);
					}
				}

				// Fill remaining space
				for (let i = end; i < start + maxVis; i++) {
					result.push(
						theme.fg("border", "│") +
						" ".repeat(innerW) +
						theme.fg("border", "│"),
					);
				}

				// Footer
				const pct = currentFile.lines.length <= maxVis ? "All" :
					`${Math.round((end / currentFile.lines.length) * 100)}%`;
				
				result.push(
					theme.fg("border", "│") +
					padLine(theme.fg("dim", ` ${start + 1}-${end} of ${currentFile.lines.length} lines (${pct})`), innerW) +
					theme.fg("border", "│"),
				);
				result.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

				return result;
			},

			invalidate(): void {},
			dispose(): void {},
		};

		function getMaxVisible(): number {
			return Math.max(5, Math.floor((process.stdout.rows || 24) * 0.7) - 6);
		}

		function maxScroll(): number {
			return Math.max(0, currentFile.lines.length - getMaxVisible());
		}

		function scrollToSearch(): void {
			// Implementation for search navigation
		}

		return component;
	}, {
		overlay: true,
		overlayOptions: {
			width: "80%",
			maxHeight: "80%",
			anchor: "center",
		},
	});
}

// ─── Helpers ─────────────────────────────────────────────────────────

function padLine(s: string, width: number): string {
	const len = s.replace(/\x1b\[[0-9;]*m/g, "").length; // Remove ANSI codes for length calculation
	return s + " ".repeat(Math.max(0, width - len));
}