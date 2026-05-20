/**
 * LLM Judge for the Isolation extension.
 *
 * When a bash command is flagged as "restricted" by the static rules,
 * this module asks a fast model whether the command is actually safe
 * given the context (cwd, command, intent).
 *
 * Flow:
 *   restricted command → cache check → LLM judge → allow/block
 *
 * Config (in .pi/isolation.json):
 *   {
 *     "autoMode": true,
 *     "judgeModel": "zai/glm-4.7-flash",
 *     "judgeTimeout": 5000
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────

export interface AutoModeConfig {
	enabled: boolean;
	judgeModel: string;
	judgeTimeout: number;
}

interface JudgeVerdict {
	safe: boolean;
	reason: string;
}

interface CacheEntry {
	verdict: JudgeVerdict;
	timestamp: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX = 200;

const SYSTEM_PROMPT = `You are a security judge for a coding agent sandbox. Given a bash command and the project directory, decide if the command is SAFE or UNSAFE.

Rules:
- Commands that only READ or LIST files are SAFE (cat, ls, grep, rg, find, head, tail, git log, etc.)
- Commands that install dependencies are SAFE (npm install, pnpm install, pip install, etc.)
- Commands that run tests, linters, or build tools are SAFE (npm test, npm run build, eslint, tsc, etc.)
- Commands that write files WITHIN the project directory are SAFE
- Commands that write files OUTSIDE the project directory are generally UNSAFE
- Commands that delete system files or modify OS config are UNSAFE
- Commands that download and execute arbitrary code (curl | bash) are UNSAFE
- Commands that access credentials, secrets, or SSH keys are UNSAFE
- Docker commands that build/run within project context are SAFE
- Git operations (commit, push, pull, merge) are SAFE if within project

Respond with EXACTLY this JSON format, nothing else:
{"safe": true/false, "reason": "one sentence explanation"}`;

// ─── Cache ───────────────────────────────────────────────────────────

let cache = new Map<string, CacheEntry>();

function cacheKey(command: string, cwd: string): string {
	return createHash("sha256").update(`${cwd}:${command}`).digest("hex").slice(0, 16);
}

function cacheGet(key: string): JudgeVerdict | null {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.timestamp > CACHE_TTL) {
		cache.delete(key);
		return null;
	}
	return entry.verdict;
}

function cacheSet(key: string, verdict: JudgeVerdict): void {
	if (cache.size >= CACHE_MAX) {
		// Evict oldest
		const oldest = cache.entries().next().value;
		if (oldest) cache.delete(oldest[0]);
	}
	cache.set(key, { verdict, timestamp: Date.now() });
}

// ─── LLM call ───────────────────────────────────────────────────────

async function callJudge(command: string, cwd: string, config: AutoModeConfig, signal?: AbortSignal): Promise<JudgeVerdict> {
	const userPrompt = `Project directory: ${cwd}\nCommand: ${command}\n\nIs this command safe to run?`;

	// Try to use pi's model registry via the OpenAI-compatible endpoint
	// We make a direct HTTP request to avoid circular dependency on the extension API
	const [provider, ...modelParts] = config.judgeModel.split("/");
	const modelId = modelParts.join("/") || config.judgeModel;

	// Resolve API key
	const apiKey = resolveApiKey(provider);
	if (!apiKey) {
		return { safe: false, reason: `No API key found for judge provider "${provider}"` };
	}

	// Resolve base URL
	const baseUrl = resolveBaseUrl(provider);
	if (!baseUrl) {
		return { safe: false, reason: `Unknown judge provider "${provider}"` };
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.judgeTimeout);

	// Also abort if parent signal fires
	if (signal) {
		signal.addEventListener("abort", () => controller.abort());
	}

	try {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: userPrompt },
				],
				max_tokens: 100,
				temperature: 0,
				stream: false,
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			return { safe: false, reason: `Judge API error: ${response.status}` };
		}

		const data = await response.json() as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		const content = data.choices?.[0]?.message?.content?.trim() ?? "";
		return parseVerdict(content);
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			return { safe: false, reason: "Judge timed out" };
		}
		return { safe: false, reason: `Judge error: ${(error as Error).message}` };
	} finally {
		clearTimeout(timeout);
	}
}

function parseVerdict(raw: string): JudgeVerdict {
	// Extract JSON from the response (model might add extra text)
	const jsonMatch = raw.match(/\{[\s\S]*?"safe"[\s\S]*?\}/);
	if (!jsonMatch) {
		return { safe: false, reason: "Judge returned unparseable response" };
	}

	try {
		const parsed = JSON.parse(jsonMatch[0]) as { safe?: boolean; reason?: string };
		return {
			safe: parsed.safe === true,
			reason: parsed.reason ?? "No reason provided",
		};
	} catch {
		return { safe: false, reason: "Judge returned invalid JSON" };
	}
}

// ─── API key / URL resolution ────────────────────────────────────────

const PROVIDER_ENV_KEYS: Record<string, string> = {
	zai: "ZAI_API_KEY",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	groq: "GROQ_API_KEY",
	google: "GEMINI_API_KEY",
};

const PROVIDER_BASE_URLS: Record<string, string> = {
	zai: "https://api.z.ai/api/coding/paas/v4",
	openai: "https://api.openai.com/v1",
	deepseek: "https://api.deepseek.com/v1",
	groq: "https://api.groq.com/openai/v1",
};

function resolveApiKey(provider: string): string | null {
	// Check auth.json first
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (existsSync(authPath)) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, any>;
			const entry = auth[provider];
			if (entry?.type === "api_key" && typeof entry.key === "string") {
				return entry.key;
			}
		} catch { /* skip */ }
	}

	// Fall back to env var
	const envKey = PROVIDER_ENV_KEYS[provider];
	return envKey ? (process.env[envKey] ?? null) : null;
}

function resolveBaseUrl(provider: string): string | null {
	return PROVIDER_BASE_URLS[provider] ?? null;
}

// ─── Public API ─────────────────────────────────────────────────────

export const DEFAULT_AUTO_MODE: AutoModeConfig = {
	enabled: true,
	judgeModel: "zai/glm-4.7-flash",
	judgeTimeout: 5000,
};

/**
 * Ask the LLM judge if a restricted bash command is actually safe.
 * Returns null if auto-mode is disabled or the command is cached as unsafe.
 */
export async function judgeCommand(
	command: string,
	currentCwd: string,
	config: AutoModeConfig,
	signal?: AbortSignal,
): Promise<JudgeVerdict | null> {
	if (!config.enabled) return null;

	// Check cache
	const key = cacheKey(command, currentCwd);
	const cached = cacheGet(key);
	if (cached) return cached;

	// Call judge
	const verdict = await callJudge(command, currentCwd, config, signal);

	// Cache the result
	cacheSet(key, verdict);

	return verdict;
}

/**
 * Clear the judge cache.
 */
export function clearJudgeCache(): void {
	cache.clear();
}
