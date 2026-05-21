/**
 * Agent profiles — discovery & parsing from multiple sources.
 *
 * Sources (merged in order, later wins):
 *   1. .claude/agents/*.md   — Claude Code compat (prompt only, inherits all)
 *   2. .pi/agents/*.md       — pi-native (YAML frontmatter + prompt)
 *   3. Ad-hoc                — created at runtime
 *
 * Pi-native frontmatter format:
 *   ---
 *   model: fast
 *   tools: [read, bash, grep, find]
 *   ---
 *   Prompt text here...
 *
 * Claude Code agents have no frontmatter — everything inherited.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentDefinition {
	name: string;
	source: "repo-pi" | "repo-claude" | "ad-hoc";
	prompt: string;
	model: string;          // tier name, default "balanced"
	tools: string[] | null; // null = inherit parent tools
}

// ─── Frontmatter parsing ────────────────────────────────────────────

interface FrontmatterResult {
	model?: string;
	tools?: string[] | null;
	prompt: string;
}

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Very minimal — only handles `model:` and `tools:` keys.
 * Returns the parsed metadata and the remaining body as the prompt.
 */
function parseFrontmatter(content: string): FrontmatterResult {
	const trimmed = content.trimStart();

	// No frontmatter
	if (!trimmed.startsWith("---")) {
		return { prompt: trimmed };
	}

	// Find closing ---
	const firstDash = trimmed.indexOf("---");
	const secondDash = trimmed.indexOf("---", firstDash + 3);

	if (secondDash === -1) {
		// Malformed — treat whole thing as prompt
		return { prompt: trimmed };
	}

	const fmStr = trimmed.slice(firstDash + 3, secondDash).trim();
	const prompt = trimmed.slice(secondDash + 3).trim();

	const result: FrontmatterResult = { prompt };

	// Parse frontmatter lines
	for (const line of fmStr.split("\n")) {
		const trimmedLine = line.trim();
		if (!trimmedLine || trimmedLine.startsWith("#")) continue;

		// key: value
		const colonIdx = trimmedLine.indexOf(":");
		if (colonIdx === -1) continue;

		const key = trimmedLine.slice(0, colonIdx).trim();
		const value = trimmedLine.slice(colonIdx + 1).trim();

		if (key === "model") {
			result.model = value || undefined;
		} else if (key === "tools") {
			if (!value || value === "null") {
				result.tools = null;
			} else if (value === "[]") {
				result.tools = [];
			} else {
				// Parse [item1, item2, ...]
				const match = value.match(/^\[(.+)\]$/);
				if (match) {
					result.tools = match[1]
						.split(",")
						.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
						.filter(Boolean);
				} else {
					// Single tool name or comma-separated without brackets
					result.tools = value.split(",").map((s) => s.trim()).filter(Boolean);
				}
			}
		}
	}

	return result;
}

/**
 * Serialize frontmatter back to string.
 */
function serializeFrontmatter(def: Omit<AgentDefinition, "name" | "source">): string {
	const lines: string[] = ["---"];

	if (def.model) lines.push(`model: ${def.model}`);
	if (def.tools === null) lines.push("tools: null");
	else if (def.tools) lines.push(`tools: [${def.tools.join(", ")}]`);

	lines.push("---", "", def.prompt);
	return lines.join("\n");
}

// ─── Single file loading ────────────────────────────────────────────

function loadAgentFile(filePath: string, source: AgentDefinition["source"]): AgentDefinition | null {
	if (!existsSync(filePath)) return null;

	try {
		const content = readFileSync(filePath, "utf8");
		const name = basename(filePath, ".md");
		const parsed = parseFrontmatter(content);

		return {
			name,
			source,
			prompt: parsed.prompt,
			model: parsed.model ?? "balanced",
			tools: parsed.tools !== undefined ? parsed.tools : null,
		};
	} catch {
		return null;
	}
}

// ─── Discovery ──────────────────────────────────────────────────────

/**
 * Discover all agent profiles from a project directory.
 * Merge order: .claude/agents < .pi/agents (later wins on name conflict).
 */
export function loadProfiles(cwd: string): Map<string, AgentDefinition> {
	const profiles = new Map<string, AgentDefinition>();

	// 1. Claude Code agents (no frontmatter, inherits everything)
	const claudeDir = join(cwd, ".claude", "agents");
	if (existsSync(claudeDir)) {
		for (const file of readdirSync(claudeDir)) {
			if (!file.endsWith(".md")) continue;
			const def = loadAgentFile(join(claudeDir, file), "repo-claude");
			if (def) profiles.set(def.name, def);
		}
	}

	// 2. Pi agents (with frontmatter, overrides claude on name conflict)
	const piDir = join(cwd, ".pi", "agents");
	if (existsSync(piDir)) {
		for (const file of readdirSync(piDir)) {
			if (!file.endsWith(".md")) continue;
			const def = loadAgentFile(join(piDir, file), "repo-pi");
			if (def) profiles.set(def.name, def);
		}
	}

	return profiles;
}

/**
 * Load a single profile by name.
 */
export function loadProfile(name: string, cwd: string): AgentDefinition | null {
	// Try pi agents first (higher priority)
	const piPath = join(cwd, ".pi", "agents", `${name}.md`);
	const piDef = loadAgentFile(piPath, "repo-pi");
	if (piDef) return piDef;

	// Fall back to claude agents
	const claudePath = join(cwd, ".claude", "agents", `${name}.md`);
	const claudeDef = loadAgentFile(claudePath, "repo-claude");
	if (claudeDef) return claudeDef;

	return null;
}

/**
 * Create a new agent profile file at .pi/agents/<name>.md.
 * Returns the created definition.
 */
export function createProfile(
	name: string,
	cwd: string,
	opts: { prompt?: string; model?: string; tools?: string[] | null } = {},
): AgentDefinition {
	const dir = join(cwd, ".pi", "agents");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const def: AgentDefinition = {
		name,
		source: "repo-pi",
		prompt: opts.prompt ?? "",
		model: opts.model ?? "balanced",
		tools: opts.tools !== undefined ? opts.tools : null,
	};

	writeFileSync(join(dir, `${name}.md`), serializeFrontmatter(def));

	return def;
}

// ─── Ad-hoc profiles ────────────────────────────────────────────────

/**
 * Create an ad-hoc agent definition (not persisted to disk).
 */
export function createAdHoc(
	name: string,
	opts: { prompt: string; model?: string; tools?: string[] | null },
): AgentDefinition {
	return {
		name,
		source: "ad-hoc",
		prompt: opts.prompt,
		model: opts.model ?? "balanced",
		tools: opts.tools !== undefined ? opts.tools : null,
	};
}

// ─── Exports for testing ────────────────────────────────────────────

export { parseFrontmatter, serializeFrontmatter };
