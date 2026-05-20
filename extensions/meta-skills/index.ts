/**
 * Meta-Skills Extension for Pi
 *
 * Discovers and bridges skills from multiple ecosystems (Claude, Cursor,
 * Windsurf, Copilot, etc.) into pi's skill system via `resources_discover`.
 *
 * Deduplication:
 *   - Symlinks pointing into pi-owned roots (~/.agents/skills, ~/.pi/agent/skills)
 *     are skipped — pi already loads those.
 *   - Same-name skills: first configured source wins.
 *
 * Configuration: `.pi/meta-skills.json` (project) or `~/.pi/agent/meta-skills.json` (global).
 *
 * Commands:
 *   /meta-skills          — list discovered external skills
 *   /meta-skills scan     — rescan all sources
 *   /meta-skills sources  — show configured sources
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────

type SkillSourceType = "claude" | "claude-plugin" | "cursor" | "copilot" | "generic";

interface SkillSource {
	root: string;
	type?: SkillSourceType;
	enabled?: boolean;
	manifest?: string;
}

interface MetaSkillsConfig {
	sources: SkillSource[];
}

interface DiscoveredSkill {
	name: string;
	path: string;
	source: SkillSourceType;
}

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: MetaSkillsConfig = {
	sources: [
		{ root: "~/.claude/skills", type: "claude" },
		{ root: "~/.claude/plugin-skills", type: "claude-plugin" },
		{ root: ".claude/skills", type: "claude" },
	],
};

// Roots pi already loads — skills here (or symlinks pointing here) are deduped away.
const PI_OWNED_ROOTS = [
	"~/.pi/agent/skills",
	"~/.agents/skills",
	".pi/skills",
	".agents/skills",
];

// ─── Config ─────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function loadConfig(cwd: string): MetaSkillsConfig {
	for (const p of [join(cwd, ".pi", "meta-skills.json"), join(homedir(), ".pi", "agent", "meta-skills.json")]) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<MetaSkillsConfig>;
			if (raw.sources && Array.isArray(raw.sources)) return { sources: raw.sources };
		} catch { /* skip */ }
	}
	return { ...DEFAULT_CONFIG };
}

// ─── Skill discovery ────────────────────────────────────────────────

function resolveRoot(raw: string, cwd: string): string {
	const expanded = expandTilde(raw);
	return raw.startsWith("~") || raw.startsWith("/") ? expanded : resolve(cwd, expanded);
}

/**
 * Check if a skill directory is a symlink into a pi-owned root.
 * Pi already loads those — we skip them to avoid duplicates.
 */
function isSymlinkIntoPiOwned(skillPath: string, piOwnedAbsRoots: Set<string>): boolean {
	try {
		const lstat = lstatSync(skillPath);
		if (!lstat.isSymbolicLink()) return false;

		const { readlinkSync } = require("node:fs") as typeof import("node:fs");
		const linkTarget = readlinkSync(skillPath);
		const resolved = resolve(skillPath, "..", linkTarget);
		const parentDir = resolve(resolved, "..");

		return piOwnedAbsRoots.has(parentDir);
	} catch {
		return false;
	}
}

function collectSkills(
	root: string,
	sourceType: SkillSourceType,
	manifest: string,
	piOwnedAbsRoots: Set<string>,
	seen: Set<string>,
): DiscoveredSkill[] {
	if (!existsSync(root)) return [];

	const skills: DiscoveredSkill[] = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;

			const fullPath = join(root, entry.name);

			// Resolve symlinks to check if directory
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try { isDir = statSync(fullPath).isDirectory(); } catch { continue; }
			}
			if (!isDir) continue;

			// Skip if symlink points into pi-owned root
			if (isSymlinkIntoPiOwned(fullPath, piOwnedAbsRoots)) continue;

			// Check manifest
			const manifests = manifest === "SKILL.md" ? ["SKILL.md", "skill.md"] : [manifest];
			const hasManifest = manifests.some((m) => {
				try { return statSync(join(fullPath, m)).isFile(); } catch { return false; }
			});
			if (!hasManifest) continue;

			// Dedup by name
			if (seen.has(entry.name)) continue;
			seen.add(entry.name);

			skills.push({ name: entry.name, path: fullPath, source: sourceType });
		}
	} catch { /* permission error */ }

	return skills;
}

function discoverExternalSkills(cwd: string, config: MetaSkillsConfig): DiscoveredSkill[] {
	const piOwnedAbsRoots = new Set(PI_OWNED_ROOTS.map((r) => resolve(expandTilde(r))));
	const seen = new Set<string>();
	const skills: DiscoveredSkill[] = [];

	for (const source of config.sources) {
		if (source.enabled === false) continue;

		const root = resolveRoot(source.root, cwd);
		// Skip if the root itself is pi-owned
		if (piOwnedAbsRoots.has(root)) continue;

		const discovered = collectSkills(
			root,
			source.type ?? "generic",
			source.manifest ?? "SKILL.md",
			piOwnedAbsRoots,
			seen,
		);
		skills.push(...discovered);
	}

	return skills;
}

// ─── Display ────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<SkillSourceType, string> = {
	claude: "Claude",
	"claude-plugin": "Plugin",
	cursor: "Cursor",
	copilot: "Copilot",
	generic: "Generic",
};

function formatSkillList(skills: DiscoveredSkill[]): string {
	if (skills.length === 0) return "No external skills discovered.";
	const lines = [
		`External skills discovered: ${skills.length}`,
		"",
		...skills.map((s) => `  ${s.name} [${SOURCE_LABELS[s.source] ?? s.source}]`),
	];
	return lines.join("\n");
}

function formatSourceList(config: MetaSkillsConfig): string {
	if (config.sources.length === 0) return "No skill sources configured.";
	return [
		"Skill sources:",
		"",
		...config.sources.map((s, i) => {
			const status = s.enabled !== false ? "on" : "off";
			return `  ${i + 1}. ${s.root} [${s.type ?? "generic"}, ${status}]`;
		}),
		"",
		"Config: .pi/meta-skills.json or ~/.pi/agent/meta-skills.json",
	].join("\n");
}

// ─── Extension ──────────────────────────────────────────────────────

export default function registerMetaSkills(pi: ExtensionAPI): void {
	let config: MetaSkillsConfig = { sources: [] };
	let skills: DiscoveredSkill[] = [];

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		skills = discoverExternalSkills(ctx.cwd, config);
		if (skills.length > 0 && ctx.hasUI) {
			// Skills are loaded silently — see /custom-pi for info
		}
	});

	pi.on("resources_discover", async (event, _ctx) => {
		config = loadConfig(event.cwd);
		skills = discoverExternalSkills(event.cwd, config);
		if (skills.length > 0) {
			return { skillPaths: skills.map((s) => s.path) };
		}
		return {};
	});

	pi.registerCommand("meta-skills", {
		description: "Discover and manage external skills from Claude, Cursor, Copilot, and other ecosystems",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "list";
			switch (sub) {
				case "list":
				case "status":
					ctx.ui.notify(formatSkillList(skills), "info");
					break;
				case "scan":
				case "refresh":
					config = loadConfig(ctx.cwd);
					skills = discoverExternalSkills(ctx.cwd, config);
					ctx.ui.notify(
						`Scanned ${config.sources.filter((s) => s.enabled !== false).length} sources → ${skills.length} external skill${skills.length !== 1 ? "s" : ""}`,
						"info",
					);
					break;
				case "sources":
					ctx.ui.notify(formatSourceList(config), "info");
					break;
				default:
					ctx.ui.notify("Usage: /meta-skills <list|scan|sources>", "info");
			}
		},
	});
}
