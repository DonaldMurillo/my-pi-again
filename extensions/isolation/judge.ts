/**
 * LLM Judge for the Isolation extension.
 *
 * Uses pi's own SDK (`complete` from `@mariozechner/pi-ai`) to call models,
 * so auth (OAuth, API keys, env vars) is resolved through pi's model registry.
 *
 * Config (in .pi/isolation.json):
 *   {
 *     "autoMode": true,
 *     "judgeProvider": "zai",
 *     "judgeModel": "glm-4.7-flash",
 *     "judgeTimeout": 8000
 *   }
 */

import { createHash } from "node:crypto";
import { complete } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";

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
const RATE_LIMIT_COOLDOWN = 30 * 1000; // 30 seconds

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

Respond with EXACTLY this JSON format, nothing else. No markdown, no explanation, no code blocks:
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

// ─── Verdict parsing ────────────────────────────────────────────────

function parseVerdict(raw: string): JudgeVerdict {
	// Try to find JSON in the response — handle markdown code blocks, extra text, etc.
	const jsonPatterns = [
		/```(?:json)?\s*\n?(\{[\s\S]*?"safe"[\s\S]*?\})\n?```/,	// ```json {...} ```
		/\{"safe"\s*:\s*(?:true|false)\s*,\s*"reason"\s*:\s*"[^"]*"\s*\}/,	// exact JSON
		/\{[\s\S]*?"safe"[\s\S]*?\}/,				// loose JSON
	];

	for (const pattern of jsonPatterns) {
		const match = raw.match(pattern);
		if (!match) continue;
		const jsonStr = match[1] ?? match[0];
		try {
			const parsed = JSON.parse(jsonStr) as { safe?: boolean; reason?: string };
			return {
				safe: parsed.safe === true,
				reason: parsed.reason ?? "No reason provided",
			};
		} catch {
			continue;
		}
	}

	return { safe: false, reason: `Judge returned unparseable response: ${raw.slice(0, 100)}` };
}

// ─── Public API ─────────────────────────────────────────────────────

export const DEFAULT_AUTO_MODE: AutoModeConfig = {
	enabled: true,
	judgeProvider: "zai",
	judgeModel: "glm-4.5-air",
	judgeTimeout: 8000,
};

type FindModelFn = (provider: string, modelId: string) => Model<Api> | undefined;
type GetAuthFn = (model: Model<Api>) => Promise<{
	ok: true;
	apiKey?: string;
	headers?: Record<string, string>;
} | {
	ok: false;
	error: string;
}>;

/**
 * Ask the LLM judge if a restricted bash command is actually safe.
 * Uses pi's SDK to call the model — no raw HTTP, proper auth resolution.
 */
export async function judgeCommand(
	command: string,
	currentCwd: string,
	config: AutoModeConfig,
	findModel: FindModelFn,
	getAuth: GetAuthFn,
	signal?: AbortSignal,
): Promise<JudgeVerdict | null> {
	if (!config.enabled) return null;

	// Check rate-limit cooldown
	if (Date.now() - lastRateLimitAt < RATE_LIMIT_COOLDOWN) {
		return { safe: false, reason: "Judge rate-limited, retry later" };
	}

	// Check cache
	const key = cacheKey(command, currentCwd);
	const cached = cacheGet(key);
	if (cached) return cached;

	// Resolve model through pi's registry
	const model = findModel(config.judgeProvider, config.judgeModel);
	if (!model) {
		return { safe: false, reason: `Judge model ${config.judgeProvider}/${config.judgeModel} not found` };
	}

	// Resolve auth through pi's registry (handles OAuth, API keys, env vars)
	const auth = await getAuth(model);
	if (!auth.ok) {
		return { safe: false, reason: `Judge auth failed: ${auth.error}` };
	}
	if (!auth.apiKey) {
		return { safe: false, reason: `No API key for judge provider "${config.judgeProvider}"` };
	}

	try {
		const userPrompt = `Project directory: ${currentCwd}\nCommand: ${command}\n\nIs this command safe to run?`;

		// Use pi's SDK to call the model — handles streaming, auth, provider quirks
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort(), config.judgeTimeout);

		// Also abort if parent signal fires
		if (signal) {
			signal.addEventListener("abort", () => timeoutController.abort());
		}

		const response = await complete(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() },
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: timeoutController.signal,
			},
		);

		clearTimeout(timeout);

		// Extract text from response
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!text) {
			return { safe: false, reason: "Judge returned empty text response" };
		}

		const verdict = parseVerdict(text);

		// Cache definitive verdicts only
		if (!verdict.reason.includes("unparseable") && !verdict.reason.includes("invalid JSON")) {
			cacheSet(key, verdict);
		}

		return verdict;
	} catch (error) {
		if ((error as Error).name === "AbortError") {
			return { safe: false, reason: "Judge timed out" };
		}
		const msg = (error as Error).message ?? String(error);
		if (msg.includes("429") || msg.includes("rate")) {
			lastRateLimitAt = Date.now();
			return { safe: false, reason: "Judge rate-limited" };
		}
		return { safe: false, reason: `Judge error: ${msg}` };
	}
}

/**
 * Clear the judge cache.
 */
export function clearJudgeCache(): void {
	cache.clear();
	lastRateLimitAt = 0;
}
