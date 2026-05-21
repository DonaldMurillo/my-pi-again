/**
 * Model tiers — maps abstract tier names (fast/balanced/deep) to concrete models.
 *
 * Config cascade: defaults < user overrides < project overrides.
 * Resolution happens at spawn time via ctx.modelRegistry.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface TierConfig {
	provider: string;
	model: string;
	description?: string;
}

export interface ModelConfig {
	tiers: Record<string, TierConfig>;
	defaults: {
		defaultTier: string;
		maxConcurrency: number;
		timeoutSeconds: number;
	};
}

export type ModelTier = "fast" | "balanced" | "deep";

// ─── Built-in defaults ──────────────────────────────────────────────

const builtinConfig: ModelConfig = {
	tiers: {
		fast: {
			provider: "zai",
			model: "glm-4.5-air",
			description: "Fast & cheap — simple tasks, formatting, boilerplate",
		},
		balanced: {
			provider: "zai",
			model: "glm-5-turbo",
			description: "Balanced — most coding tasks",
		},
		deep: {
			provider: "zai",
			model: "glm-5.1",
			description: "Deep — architecture, reviews, complex bugs",
		},
	},
	defaults: {
		defaultTier: "balanced",
		maxConcurrency: 5,
		timeoutSeconds: 300,
	},
};

// ─── Config loading ─────────────────────────────────────────────────

/** Load and parse a JSON config file, returning null if missing or invalid. */
function loadJsonConfig(path: string): Partial<ModelConfig> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Deep merge model configs. Later values win.
 * Merges tiers (by key) and defaults (by field).
 */
function mergeConfigs(base: ModelConfig, ...overrides: Array<Partial<ModelConfig> | null>): ModelConfig {
	let result: ModelConfig = JSON.parse(JSON.stringify(base));

	for (const override of overrides) {
		if (!override) continue;

		if (override.tiers) {
			for (const [key, tier] of Object.entries(override.tiers)) {
				result.tiers[key] = { ...result.tiers[key], ...tier };
			}
		}

		if (override.defaults) {
			result.defaults = { ...result.defaults, ...override.defaults };
		}
	}

	return result;
}

/**
 * Load the full model config with cascade:
 *   built-in defaults < user global < project local
 */
export function loadConfig(projectDir?: string): ModelConfig {
	// User-level overrides
	const userPath = join(homedir(), ".pi", "agent", "extensions", "subagent", "models.json");
	const userConfig = loadJsonConfig(userPath);

	// Project-level overrides
	let projectConfig: Partial<ModelConfig> | null = null;
	if (projectDir) {
		const projectPath = join(projectDir, ".pi", "agent-models.json");
		projectConfig = loadJsonConfig(projectPath);
	}

	return mergeConfigs(builtinConfig, userConfig, projectConfig);
}

// ─── Tier resolution ────────────────────────────────────────────────

/**
 * Get the tier config for a given tier name.
 * Falls back to the default tier if the name is unknown.
 */
export function getTierConfig(config: ModelConfig, tier: string): TierConfig | null {
	return config.tiers[tier] ?? config.tiers[config.defaults.defaultTier] ?? null;
}

/**
 * List all available tiers with their config.
 */
export function listTiers(config: ModelConfig): Array<TierConfig & { name: string }> {
	return Object.entries(config.tiers).map(([name, tier]) => ({
		name,
		...tier,
	}));
}

/**
 * Check if a tier name is valid.
 */
export function isValidTier(config: ModelConfig, tier: string): boolean {
	return tier in config.tiers;
}
