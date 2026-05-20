/**
 * Isolation Extension for Pi
 *
 * Restricts the agent to only write/edit/delete files within the
 * conversation's base working directory (cwd). Blocks any file
 * operations that escape the sandbox.
 *
 * Auto-mode: When a command is flagged as restricted by static rules,
 * a fast LLM judge evaluates whether it's actually safe. This allows
 * sensible commands through without manual allow-listing.
 *
 * Commands:
 *   /isolation status  — show current isolation state
 *   /isolation on      — enable isolation (default on session start)
 *   /isolation off     — disable isolation (emergency override)
 *   /isolation allow <path> — add an escape hatch for a specific path
 *   /isolation reset   — clear custom allow-list
 *   /isolation auto    — toggle auto-mode (LLM judge)
 *
 * Config: .pi/isolation.json
 *   {
 *     "enabled": true,
 *     "allowPaths": ["/tmp/build-output"],
 *     "autoMode": true,
 *     "judgeModel": "zai/glm-4.7-flash",
 *     "judgeTimeout": 5000
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import {
	isWithinBase,
	isWithinAllowed,
	isHomeDirectory,
	isHardForbidden,
	isBashCommandRestricted,
	extractPathsFromBash,
} from "./isolation-helpers.js";
import {
	judgeCommand,
	clearJudgeCache,
	DEFAULT_AUTO_MODE,
	type AutoModeConfig,
} from "./judge.js";

// ─── Types ──────────────────────────────────────────────────────────

interface IsolationConfig {
	enabled: boolean;
	allowPaths: string[];
	blockHomeDirectory: boolean;
	autoMode: boolean;
	judgeModel: string;
	judgeTimeout: number;
}

const DEFAULT_CONFIG: IsolationConfig = {
	enabled: true,
	allowPaths: [],
	blockHomeDirectory: true,
	autoMode: true,
	judgeModel: DEFAULT_AUTO_MODE.judgeModel,
	judgeTimeout: DEFAULT_AUTO_MODE.judgeTimeout,
};

// ─── Config loading ─────────────────────────────────────────────────

function loadConfig(cwd: string): IsolationConfig {
	const configPath = resolve(cwd, ".pi", "isolation.json");
	if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw) as Partial<IsolationConfig>;
		return {
			enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
			allowPaths: parsed.allowPaths ?? DEFAULT_CONFIG.allowPaths,
			blockHomeDirectory: parsed.blockHomeDirectory ?? DEFAULT_CONFIG.blockHomeDirectory,
			autoMode: parsed.autoMode ?? DEFAULT_CONFIG.autoMode,
			judgeProvider: parsed.judgeProvider ?? DEFAULT_AUTO_MODE.judgeProvider,
			judgeModel: parsed.judgeModel ?? DEFAULT_CONFIG.judgeModel,
			judgeTimeout: parsed.judgeTimeout ?? DEFAULT_CONFIG.judgeTimeout,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ─── Tool names that modify the filesystem ──────────────────────────

const WRITE_TOOLS = new Set(["write", "edit"]);

// ─── Extension registration ─────────────────────────────────────────

let config: IsolationConfig = { ...DEFAULT_CONFIG };
let cwd = "";
let bypassEnabled = false;
let judgeStats = { allowed: 0, blocked: 0, timedOut: 0 };

function checkPath(filePath: string): { allowed: boolean; reason: string } {
	if (bypassEnabled) return { allowed: true, reason: "" };
	if (!config.enabled) return { allowed: true, reason: "" };

	// Expand ~ before resolving
	const expanded = filePath.startsWith("~/") ? filePath.replace("~/", homedir() + "/") : filePath;
	const resolved = resolve(cwd, expanded);

	// Allow anything within cwd
	if (isWithinBase(filePath, cwd)) {
		return { allowed: true, reason: "" };
	}

	// Allow explicitly allowed escape paths
	if (config.allowPaths.length > 0 && isWithinAllowed(filePath, config.allowPaths)) {
		return { allowed: true, reason: "" };
	}

	// Block home directory access if configured
	if (config.blockHomeDirectory && isHomeDirectory(filePath)) {
		return {
			allowed: false,
			reason: `Isolation: path "${filePath}" is outside the project directory (${cwd}) and inside home directory. Use /isolation allow <path> if needed.`,
		};
	}

	return {
		allowed: false,
		reason: `Isolation: path "${filePath}" is outside the project directory (${cwd}). Use /isolation allow <path> if needed.`,
	};
}

export default function registerIsolation(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		config = loadConfig(ctx.cwd);
		bypassEnabled = false;
		judgeStats = { allowed: 0, blocked: 0, timedOut: 0 };

		if (config.enabled && ctx.hasUI) {
			const autoTag = config.autoMode ? " 🔮 auto" : "";
			const allowedInfo = config.allowPaths.length > 0
				? ` (+${config.allowPaths.length} hatch${config.allowPaths.length > 1 ? "es" : ""})`
				: "";
			ctx.ui.setStatus("isolation", `🔒${autoTag} ${cwd}${allowedInfo}`);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (bypassEnabled || !config.enabled) return;
		cwd = ctx.cwd;

		const toolName = event.toolName;

		// Check write/edit tools — hard rules, no judge
		if (WRITE_TOOLS.has(toolName)) {
			const filePath = String((event.input as { path?: string }).path ?? "");
			if (!filePath) return;

			if (isHardForbidden(filePath)) {
				return { block: true, reason: `Isolation: path "${filePath}" is hard-forbidden (system-critical). Cannot be overridden.` };
			}

			const check = checkPath(filePath);
			if (!check.allowed) {
				return { block: true, reason: check.reason };
			}
		}

		// Check bash for file-modifying commands
		if (toolName === "bash") {
			const command = String((event.input as { command?: string }).command ?? "");
			if (!command) return;

			if (isBashCommandRestricted(command)) {
				const paths = extractPathsFromBash(command);

				// If we extracted paths, check them against hard rules
				if (paths.length > 0) {
					for (const p of paths) {
						// Recursive delete check
						if (p.startsWith("__RECURSIVE__:")) {
							const actualPath = p.replace("__RECURSIVE__:", "");
							if (isHardForbidden(actualPath)) {
								return { block: true, reason: `Isolation: recursive delete of "${actualPath}" is hard-forbidden. Cannot be overridden.` };
							}
							// Block recursive delete on .git even within cwd
							if (/\.git/.test(actualPath)) {
								return { block: true, reason: `Isolation: recursive delete of "${actualPath}" would destroy git history. Use /isolation off if you really need this.` };
							}
						}

						// Hard-forbidden paths (never overridable)
						if (!p.startsWith("__RECURSIVE__:") && isHardForbidden(p)) {
							return { block: true, reason: `Isolation: path "${p}" is hard-forbidden (system-critical). Cannot be overridden.` };
						}

						const check = checkPath(p.startsWith("__RECURS__:") ? p.replace("__RECURSIVE__:", "") : p);
						if (!check.allowed) {
							return { block: true, reason: check.reason };
						}
					}
					// All paths are within allowed areas — let it through
					return;
				}

				// No paths extracted — command is ambiguous
				// If auto-mode is on, ask the judge
				if (config.autoMode) {
					const verdict = await judgeCommand(
						command,
						cwd,
						{
							enabled: config.autoMode,
							judgeProvider: config.judgeProvider,
							judgeModel: config.judgeModel,
							judgeTimeout: config.judgeTimeout,
						},
						(provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
						ctx.signal,
					);

					if (verdict?.safe) {
						judgeStats.allowed++;
						// Judge says safe — let it through
						return;
					}

					if (verdict && !verdict.safe) {
						judgeStats.blocked++;
						return {
							block: true,
							reason: `Isolation (judge): ${verdict.reason}. Command: "${command.slice(0, 80)}"`,
						};
					}

					// Judge timed out or errored — default deny
					judgeStats.timedOut++;
				}

				return {
					block: true,
					reason: `Isolation: bash command may modify files outside the project directory. Command: "${command.slice(0, 100)}"`,
				};
			}
		}

		// All other tools (read, grep, etc.) are allowed
	});

	pi.registerCommand("isolation", {
		description: "Manage file system isolation for the current session",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "status";

			switch (subcommand) {
				case "status": {
					const lines = [
						"🔒 Isolation",
						`  enabled: ${config.enabled ? "yes" : "no"}`,
						`  bypass: ${bypassEnabled ? "ACTIVE" : "off"}`,
						`  auto-mode: ${config.autoMode ? `on (${config.judgeModel})` : "off"}`,
						`  project root: ${cwd}`,
						`  block home dir: ${config.blockHomeDirectory ? "yes" : "no"}`,
						`  escape hatches: ${config.allowPaths.length > 0 ? config.allowPaths.join(", ") : "(none)"}`,
						`  judge stats: ${judgeStats.allowed} allowed, ${judgeStats.blocked} blocked, ${judgeStats.timedOut} timed out`,
						`  config: ${resolve(cwd, ".pi", "isolation.json")}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "on": {
					config.enabled = true;
					bypassEnabled = false;
					ctx.ui.notify("🔒 Isolation enabled. Agent restricted to project directory.", "info");
					break;
				}

				case "off": {
					bypassEnabled = true;
					ctx.ui.notify("⚠️  Isolation bypass enabled. Agent can write anywhere. Use /isolation on to re-enable.", "warning");
					break;
				}

				case "allow": {
					const path = parts[1];
					if (!path) {
						ctx.ui.notify("Usage: /isolation allow <path>", "info");
						break;
					}
					const resolved = resolve(cwd, path);
					if (!config.allowPaths.includes(resolved)) {
						config.allowPaths.push(resolved);
					}
					ctx.ui.notify(`🔓 Escape hatch added: ${resolved}`, "info");
					break;
				}

				case "auto": {
					config.autoMode = !config.autoMode;
					clearJudgeCache();
					ctx.ui.notify(
						config.autoMode
							? `🔮 Auto-mode ON — restricted commands will be evaluated by ${config.judgeModel}`
							: "🔮 Auto-mode OFF — restricted commands are hard-blocked",
						"info",
					);
					break;
				}

				case "reset": {
					config.allowPaths = [];
					clearJudgeCache();
					judgeStats = { allowed: 0, blocked: 0, timedOut: 0 };
					ctx.ui.notify("🔒 Escape hatches and judge cache cleared.", "info");
					break;
				}

				default:
					ctx.ui.notify("Usage: /isolation <status|on|off|auto|allow <path>|reset>", "info");
			}
		},
	});
}
