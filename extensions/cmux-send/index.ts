/**
 * cmux-send extension — talk to other cmux terminals from pi.
 *
 * Tools:
 *   cmux_surfaces    — list available surfaces
 *   cmux_read        — read visible text from a surface
 *   cmux_send        — inject text into a surface (like user typed it)
 *   cmux_prompt      — full round-trip: send prompt → wait → read response
 *
 * Command:
 *   /send [target] <text> — quick-send to a surface (default: Claude)
 *
 * Talks directly to the cmux Unix domain socket.
 * Routes by surface UUID (not human-readable ref like "surface:6").
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as net from "node:net";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── cmux Socket Client ─────────────────────────────────────────────

const DEFAULT_SOCK_PATH = join(
	homedir(),
	"Library/Application Support/cmux/cmux.sock",
);

interface CmuxResult {
	ok: boolean;
	result?: any;
	error?: string;
	id: number;
}

function cmuxCall(
	method: string,
	params: Record<string, unknown> = {},
	socketPath = DEFAULT_SOCK_PATH,
	timeoutMs = 5000,
): Promise<CmuxResult> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(socketPath);
		const id = Date.now() + Math.random();

		sock.on("connect", () => {
			sock.write(JSON.stringify({ method, params, id }) + "\n");
		});

		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString();
			try {
				const resp = JSON.parse(buf);
				sock.end();
				resolve(resp);
			} catch {
				// partial read, keep buffering
			}
		});

		sock.on("error", (e) => reject(new Error(`cmux socket error: ${e.message}`)));
		setTimeout(() => {
			sock.end();
			reject(new Error(`cmux call timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
}

// ─── Surface types ───────────────────────────────────────────────────

interface Surface {
	ref: string;
	id: string; // UUID — required for send_text / send_key
	type: string;
	title: string | null;
	focused: boolean;
}

async function listSurfaces(socketPath = DEFAULT_SOCK_PATH): Promise<Surface[]> {
	const resp = await cmuxCall("surface.list", {}, socketPath);
	if (!resp.ok || !resp.result?.surfaces) {
		throw new Error(`Failed to list surfaces: ${JSON.stringify(resp)}`);
	}
	return resp.result.surfaces;
}

/**
 * Detect which agent is running on each cmux surface.
 * Parses `cmux tree --all` for TTY mappings, then checks `ps` for the process.
 * Returns a Map of surface ref → agent type ("Claude Code" | "pi" | "browser" | "unknown").
 */
function detectAgents(): Map<string, string> {
	const agents = new Map<string, string>();

	try {
		// Get the tree output with TTY info
		const tree = execSync("cmux tree --all 2>&1", { encoding: "utf-8", timeout: 3000 });

		// Get all processes with their TTYs
		const psOutput = execSync("ps -o tty=,comm= -ax 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
		const ttyProcesses = new Map<string, string[]>();
		for (const line of psOutput.split("\n")) {
			const match = line.match(/^(\S+)\s+(.+)$/);
			if (match) {
				const [, tty, comm] = match;
				if (!ttyProcesses.has(tty)) ttyProcesses.set(tty, []);
				ttyProcesses.get(tty)!.push(comm);
			}
		}

		// Parse tree lines: "surface surface:6 [terminal] \"...\" tty=ttys001"
		const surfaceRegex = /surface (surface:\d+).*tty=(\S+)/g;
		let m;
		while ((m = surfaceRegex.exec(tree)) !== null) {
			const [, surfRef, tty] = m;
			const procs = ttyProcesses.get(tty) || [];

			// Check for Claude Code (the claude binary)
			const isClaude = procs.some((p) =>
				p.includes("/claude") || p === "claude" || p.includes("/.local/bin/claude"),
			);
			// Check for pi
			const isPi = procs.some((p) => p === "pi" || p.endsWith("/pi"));

			if (isClaude) {
				agents.set(surfRef, "Claude Code");
			} else if (isPi) {
				agents.set(surfRef, "pi");
			} else {
				agents.set(surfRef, "unknown");
			}
		}

		// Mark browser surfaces
		const browserRegex = /surface (surface:\d+) \[browser\]/g;
		while ((m = browserRegex.exec(tree)) !== null) {
			agents.set(m[1], "browser");
		}
	} catch {
		// Graceful fallback — detection is best-effort
	}

	return agents;
}

async function findSurface(query: string, socketPath = DEFAULT_SOCK_PATH): Promise<Surface | null> {
	const surfaces = await listSurfaces(socketPath);
	const lower = query.toLowerCase();

	// Exact ref match ("surface:6")
	const byRef = surfaces.find((s) => s.ref === query);
	if (byRef) return byRef;

	// Exact title match
	const exact = surfaces.find((s) => s.title?.toLowerCase() === lower);
	if (exact) return exact;

	// Contains match ("claude" matches "✳ Claude Code")
	const partial = surfaces.find((s) => s.title?.toLowerCase().includes(lower));
	if (partial) return partial;

	return null;
}

// ─── Core operations ─────────────────────────────────────────────────

async function sendText(
	surfaceId: string,
	text: string,
	pressEnter: boolean,
	socketPath: string,
): Promise<{ textResult: CmuxResult; keyResult?: CmuxResult }> {
	const textResult = await cmuxCall("surface.send_text", {
		surface_id: surfaceId,
		text,
	}, socketPath);

	let keyResult: CmuxResult | undefined;
	if (pressEnter) {
		keyResult = await cmuxCall("surface.send_key", {
			surface_id: surfaceId,
			key: "Enter",
		}, socketPath);
	}

	return { textResult, keyResult };
}

async function readText(
	surfaceId: string,
	socketPath: string,
): Promise<string> {
	const r = await cmuxCall("surface.read_text", {
		surface_id: surfaceId,
	}, socketPath);
	return r.result?.text || "";
}

/**
 * Poll a surface until Claude Code is idle (done responding).
 *
 * Detection strategy: Claude Code's status bar is always the last line.
 *   - BUSY: contains "esc to interrupt"
 *   - IDLE: contains "← for agents" or "for agents"
 *
 * When idle, there's also an empty "❯" prompt above the separator.
 */
async function waitForIdle(
	surfaceId: string,
	socketPath: string,
	maxWaitMs = 120000,
	pollIntervalMs = 2000,
): Promise<string> {
	const start = Date.now();

	while (Date.now() - start < maxWaitMs) {
		const text = await readText(surfaceId, socketPath);
		const lines = text.trimEnd().split("\n");

		// Status bar is always the last line
		const statusBar = lines[lines.length - 1] || "";

		// IDLE indicator: status bar mentions "for agents" (not "esc to interrupt")
		if (statusBar.includes("← for agents") || statusBar.includes("for agents")) {
			// Verify there's an empty ❯ prompt above the separator
			const nearBottom = lines.slice(-5, -2);
			const hasEmptyPrompt = nearBottom.some(
				(l) => l.trimEnd() === "❯" || l.trimEnd() === "❯ ",
			);
			if (hasEmptyPrompt) {
				return text;
			}
		}

		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}

	throw new Error(`cmux: timed out after ${maxWaitMs}ms waiting for surface to become idle`);
}

/**
 * Extract the latest response from the terminal buffer.
 * Splits on "❯" prompts and returns the block before the last empty prompt.
 */
function extractLastResponse(fullText: string): string {
	const parts = fullText.split("❯");
	if (parts.length < 2) return fullText;

	// The last "❯" is the current empty input prompt.
	// The second-to-last block is the latest Q&A pair.
	const block = parts[parts.length - 2];

	// Clean up — remove leading prompt text, keep just the response
	// The block starts with the user's question text, then has the response
	// We want everything after the first newline (which is the response)
	const lines = block.split("\n");

	// Find where the response starts (after the user prompt line)
	// The user prompt is the first line, response follows
	if (lines.length > 1) {
		return lines.slice(1).join("\n").trim();
	}

	return block.trim();
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	function sockPath(): string {
		return process.env.CMUX_SOCK_PATH || DEFAULT_SOCK_PATH;
	}

	// ── Tool: cmux_surfaces ──

	pi.registerTool({
		name: "cmux_surfaces",
		label: "List cmux surfaces",
		description:
			"List all terminal/browser surfaces in cmux. " +
			"Returns ref, type, and title for each surface.",
		parameters: Type.Object({}),
		promptSnippet: "List cmux terminal surfaces",

		async execute() {
			try {
				const surfaces = await listSurfaces(sockPath());
				if (surfaces.length === 0) {
					return { content: [{ type: "text" as const, text: "No cmux surfaces found." }] };
				}

				const agents = detectAgents();

				const lines = surfaces.map((s) => {
					const icon = s.focused ? "→ " : "  ";
					const typeIcon = s.type === "browser" ? "🌐" : "💻";
					const agent = agents.get(s.ref);
					const agentTag = agent && agent !== "unknown" ? ` (${agent})` : "";
					return `${icon}${typeIcon} ${s.ref}  "${s.title || "untitled"}"${agentTag}`;
				});

				return {
					content: [{
						type: "text" as const,
						text: `cmux surfaces (${surfaces.length}):\n${lines.join("\n")}`,
					}],
				};
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }],
					isError: true,
				};
			}
		},
	});

	// ── Tool: cmux_read ──

	pi.registerTool({
		name: "cmux_read",
		label: "Read text from a cmux surface",
		description:
			"Read the visible text from a cmux terminal surface. " +
			"Returns whatever is currently on screen.",
		parameters: Type.Object({
			target: Type.String({
				description: 'Surface ref (e.g. "surface:6") or fuzzy title (e.g. "Claude")',
			}),
		}),
		promptSnippet: "Read text from a cmux surface",

		async execute(_id, params) {
			try {
				const surface = await findSurface(params.target, sockPath());
				if (!surface) {
					return {
						content: [{ type: "text" as const, text: `No surface matching "${params.target}"` }],
						isError: true,
					};
				}

				const text = await readText(surface.id, sockPath());
				return {
					content: [{ type: "text" as const, text }],
				};
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }],
					isError: true,
				};
			}
		},
	});

	// ── Tool: cmux_send ──

	pi.registerTool({
		name: "cmux_send",
		label: "Send text to a cmux surface",
		description:
			"Inject text into a cmux terminal surface, exactly as if the user typed it. " +
			"By default presses Enter after sending (set pressEnter=false to just type). " +
			"Does NOT wait for a response — use cmux_prompt for round-trip.",
		parameters: Type.Object({
			target: Type.String({
				description: 'Surface ref (e.g. "surface:6") or fuzzy title (e.g. "Claude")',
			}),
			text: Type.String({
				description: "Text to inject",
			}),
			pressEnter: Type.Optional(
				Type.Boolean({ description: "Press Enter after text (default: true)", default: true }),
			),
		}),
		promptSnippet: "Send text to a cmux terminal",
		promptGuidelines: [
			"This is fire-and-forget. The text is injected immediately, no response is collected.",
			"For a full round-trip with response, use cmux_prompt instead.",
		],

		async execute(_id, params) {
			try {
				const surface = await findSurface(params.target, sockPath());
				if (!surface) {
					const surfaces = await listSurfaces(sockPath());
					const available = surfaces
						.map((s) => `  ${s.ref} "${s.title || "untitled"}"`)
						.join("\n");
					return {
						content: [{ type: "text" as const, text: `No surface matching "${params.target}". Available:\n${available}` }],
						isError: true,
					};
				}

				const { textResult } = await sendText(
					surface.id, params.text, params.pressEnter ?? true, sockPath(),
				);

				if (!textResult.ok) {
					return {
						content: [{ type: "text" as const, text: `send_text failed: ${JSON.stringify(textResult)}` }],
						isError: true,
					};
				}

				const action = params.pressEnter !== false ? "sent + Enter" : "typed (no Enter)";
				return {
					content: [{
						type: "text" as const,
						text: `✓ ${action} to ${surface.ref} "${surface.title}"`,
					}],
				};
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }],
					isError: true,
				};
			}
		},
	});

	// ── Tool: cmux_prompt ──

	pi.registerTool({
		name: "cmux_prompt",
		label: "Send a prompt and get the response",
		description:
			"Full round-trip: sends a prompt to a cmux terminal, waits for the response, " +
			"and returns the response text. Use for actual conversations with Claude Code or " +
			"any other interactive terminal. Supports multi-turn (the target maintains context).",
		parameters: Type.Object({
			target: Type.String({
				description: 'Surface ref (e.g. "surface:6") or fuzzy title (e.g. "Claude")',
			}),
			prompt: Type.String({
				description: "The prompt to send",
			}),
			timeoutMs: Type.Optional(
				Type.Number({
					description: "Max wait time for response in ms (default: 120000 = 2min)",
					default: 120000,
				}),
			),
			returnFull: Type.Optional(
				Type.Boolean({
					description: "Return full terminal text instead of just the last response (default: false)",
					default: false,
				}),
			),
		}),
		promptSnippet: "Send prompt and get response from a cmux terminal",
		promptGuidelines: [
			"This does a full round-trip: send → wait for idle → read response.",
			"The target terminal maintains conversation context across calls.",
			"You can also send slash commands like '/compact' or '/model sonnet'.",
		],

		async execute(_id, params) {
			try {
				const surface = await findSurface(params.target, sockPath());
				if (!surface) {
					const surfaces = await listSurfaces(sockPath());
					const available = surfaces
						.map((s) => `  ${s.ref} "${s.title || "untitled"}"`)
						.join("\n");
					return {
						content: [{ type: "text" as const, text: `No surface matching "${params.target}". Available:\n${available}` }],
						isError: true,
					};
				}

				// Send the prompt
				await sendText(surface.id, params.prompt, true, sockPath());

				// Wait for response (poll until idle)
				const fullText = await waitForIdle(
					surface.id,
					sockPath(),
					params.timeoutMs ?? 120000,
				);

				// Extract just the latest response (between last two ❯ prompts)
				const response = params.returnFull
					? fullText
					: extractLastResponse(fullText);

				return {
					content: [{ type: "text" as const, text: response }],
				};
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }],
					isError: true,
				};
			}
		},
	});

	// ── /send command ──

	pi.registerCommand("cmux-send", {
		description: "Send a prompt to another cmux surface (default: Claude Code)",
		args: [
			{ name: "target", description: "Surface ref or title (default: Claude)", optional: true },
			{ name: "prompt", description: "Text to send", variadic: true },
		],
		async execute(args, ctx) {
			const argParts = args._.filter((a): a is string => typeof a === "string");

			if (argParts.length === 0) {
				ctx.ui.notify("Usage: /send [target] <prompt>", "warning");
				return;
			}

			let target = "Claude";
			let text: string;

			if (argParts.length === 1) {
				text = argParts[0];
			} else {
				target = argParts[0];
				text = argParts.slice(1).join(" ");
			}

			try {
				const surface = await findSurface(target, sockPath());
				if (!surface) {
					ctx.ui.notify(`No cmux surface matching "${target}"`, "error");
					return;
				}

				await sendText(surface.id, text, true, sockPath());
				ctx.ui.notify(
					`→ Sent to "${surface.title}": ${text.slice(0, 60)}${text.length > 60 ? "..." : ""}`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(
					`Failed: ${e instanceof Error ? e.message : e}`,
					"error",
				);
			}
		},
	});

	// ── System prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

<cmux>
You can interact with other cmux terminal surfaces — inject prompts, read responses, have conversations.

<tools>
cmux_surfaces()                          — list all surfaces (ref, type, title, agent type)
cmux_read({ target })                    — read current visible text from a surface
cmux_send({ target, text, pressEnter? }) — inject text (fire-and-forget, no response)
cmux_prompt({ target, prompt, timeoutMs?, returnFull? }) — send prompt, wait, return response
</tools>

<target_resolution>
The "target" parameter resolves in order: exact ref ("surface:6") → exact title → fuzzy title match.
cmux_surfaces auto-detects which agent runs on each surface (Claude Code, pi, browser).
Use "Claude" as target to auto-find a Claude Code instance.
</target_resolution>

<use_cases>
- Talk to Claude Code: cmux_prompt({ target: "Claude", prompt: "..." })
- Send a slash command: cmux_send({ target: "Claude", text: "/compact" })
- Run a command in another terminal: cmux_send({ target: "pi", text: "npm test" })
- Check what's on screen: cmux_read({ target: "Claude" })
</use_cases>
</cmux>
`;
	});
}
