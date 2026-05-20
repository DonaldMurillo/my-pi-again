/**
 * LLM Judge for the Isolation extension.
 *
 * When a bash command is flagged as "restricted" by the static rules,
 * this module asks a fast model whether the command is actually safe
 * given the context (cwd, command, intent).
 *
 * Uses pi's own model registry + SDK to resolve auth and make calls,
 * so it works with any provider pi supports (OAuth, API keys, etc.).
 *
 * Flow:
 *   restricted command → cache check → LLM judge → allow/block
 *
 * Config (in .pi/isolation.json):
 *   {
 *     "autoMode": true,
 *     "judgeProvider": "github-copilot",
 *     "judgeModel": "gpt-5-mini",
 *     "judgeTimeout": 8000
 *   }
 */

import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────

export interface AutoModeConfig {
	enabled: boolean;
	judgeProvider: string;
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
const RATE_LIMIT_COOLDOWN = 30 * 1000; // 30 seconds — don't retry after 429

const SYSTEM_PROMPT = `You are a security judge for a coding agent sandbox. Given a bash command and the project directory, decide if the command is SAFE or UNSAFE.

Rules:
- Commands that only READ or LIST files are SAFE (cat, ls, grep, rg, find, head, tail, git log, etc.)
- Commands that install dependencies are SAFE (npm install, pnpm install, pip install, brew install, etc.)
- Commands that run tests, linters, or build tools are SAFE (npm test, npm run build, eslint, tsc, pytest, etc.)
- Commands that write files WITHIN the project directory are SAFE
- Commands that write files OUTSIDE the project directory are generally UNSAFE
- Commands that delete system files or modify OS config are UNSAFE
- Commands that download and execute arbitrary code (curl | bash) are UNSAFE
- Commands that access credentials, secrets, or SSH keys are UNSAFE
- Docker commands that build/run within project context are SAFE
- Git operations (commit, push, pull, merge) are SAFE if within project
- Package manager scripts (npm run, pnpm run) are SAFE

Respond with EXACTLY this JSON format, nothing else:
{"safe": true/false, "reason": "one sentence explanation"}`;

// ─── Cache ───────────────────────────────────────────────────────────

let cache = new Map<string, CacheEntry>();
let lastRateLimitAt = 0;

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
		const oldest = cache.entries().next().value;
		if (oldest) cache.delete(oldest[0]);
	}
	cache.set(key, { verdict, timestamp: Date.now() });
}

// ─── LLM call via pi's model registry ───────────────────────────────

async function callJudge(
	command: string,
	cwd: string,
	config: AutoModeConfig,
	getApiKey: (provider: string) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<JudgeVerdict> {
	// Check if we're in rate-limit cooldown
	if (Date.now() - lastRateLimitAt < RATE_LIMIT_COOLDOWN) {
		return { safe: false, reason: "Judge rate-limited, retry later" };
	}

	const userPrompt = `Project directory: ${cwd}\nCommand: ${command}\n\nIs this command safe to run?`;

	// Resolve API key through pi's model registry (handles OAuth, env vars, auth.json)
	const apiKey = await getApiKey(config.judgeProvider);
	if (!apiKey) {
		return { safe: false, reason: `No auth found for judge provider "${config.judgeProvider}"` };
	}

	// Resolve base URL based on provider
	const baseUrl = getProviderBaseUrl(config.judgeProvider);
	if (!baseUrl) {
		return { safe: false, reason: `Unknown judge provider "${config.judgeProvider}"` };
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.judgeTimeout);
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
				model: config.judgeModel,
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

		if (response.status === 429) {
			lastRateLimitAt = Date.now();
			return { safe: false, reason: "Judge rate-limited" };
		}

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

// ─── Provider URL resolution ─────────────────────────────────────────

function getProviderBaseUrl(provider: string): string | null {
	const urls: Record<string, string> = {
		"github-copilot": "https://api.githubcopilot.com/v1",
		"openai": "https://api.openai.com/v1",
		"zai": "https://api.z.ai/api/coding/paas/v4",
		"deepseek": "https://api.deepseek.com/v1",
		"groq": "https://api.groq.com/openai/v1",
		"anthropic": "https://api.anthropic.com/v1",
	};
	return urls[provider] ?? null;
}

// ─── Public API ─────────────────────────────────────────────────────

export const DEFAULT_AUTO_MODE: AutoModeConfig = {
	enabled: true,
	judgeProvider: "github-copilot",
	judgeModel: "gpt-5-mini",
	judgeTimeout: 8000,
};

/**
 * Ask the LLM judge if a restricted bash command is actually safe.
 * Returns null if auto-mode is disabled.
 */
export async function judgeCommand(
	command: string,
	currentCwd: string,
	config: AutoModeConfig,
	getApiKey: (provider: string) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<JudgeVerdict | null> {
	if (!config.enabled) return null;

	// Check cache
	const key = cacheKey(command, currentCwd);
	const cached = cacheGet(key);
	if (cached) return cached;

	// Call judge
	const verdict = await callJudge(command, currentCwd, config, getApiKey, signal);

	// Only cache definitive verdicts (not rate limits/timeouts)
	if (!verdict.reason.includes("rate-limited") && !verdict.reason.includes("timed out")) {
		cacheSet(key, verdict);
	}

	return verdict;
}

/**
 * Clear the judge cache.
 */
export function clearJudgeCache(): void {
	cache.clear();
	lastRateLimitAt = 0;
}
