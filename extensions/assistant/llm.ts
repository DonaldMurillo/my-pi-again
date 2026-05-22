/**
 * LLM-backed assistant responses using pi-ai `complete`.
 *
 * Uses the same pattern as isolation/judge.ts — resolve model through
 * pi's model registry, call `complete` with the personality systemPrompt.
 */

import { complete } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import type { PersonalityProfile, Message } from "./types.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────

export interface LLMConfig {
	provider: string;
	model: string;
	timeoutMs: number;
}

// ─── Response generation ─────────────────────────────────────────────

export async function generateResponse(
	profile: PersonalityProfile,
	history: Message[],
	userMessage: string,
	ctx: ExtensionContext,
	llmConfig: LLMConfig,
	signal?: AbortSignal,
): Promise<string> {
	const model = ctx.modelRegistry.find(llmConfig.provider, llmConfig.model);
	if (!model) throw new Error(`Assistant model not found: ${llmConfig.provider}/${llmConfig.model}`);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Assistant auth failed: ${auth.error}`);
	if (!auth.apiKey) throw new Error(`No API key for assistant provider "${llmConfig.provider}"`);

	const messages = history.map((msg) => ({
		role: msg.role,
		content: [{ type: "text" as const, text: msg.content }],
		timestamp: msg.timestamp,
	}));
	messages.push({
		role: "user",
		content: [{ type: "text", text: userMessage }],
		timestamp: Date.now(),
	});

	const timeoutController = new AbortController();
	const timeout = setTimeout(() => timeoutController.abort(), llmConfig.timeoutMs);
	if (signal) signal.addEventListener("abort", () => timeoutController.abort());

	try {
		const response = await complete(model, { systemPrompt: profile.systemPrompt, messages }, {
			apiKey: auth.apiKey, headers: auth.headers, signal: timeoutController.signal,
		});
		clearTimeout(timeout);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text).join("\n").trim();
		return text || "(assistant returned empty response)";
	} catch (err) {
		clearTimeout(timeout);
		if ((err as Error).name === "AbortError") throw new Error("Assistant response timed out");
		throw err;
	}
}

// ─── Agent review ────────────────────────────────────────────────────

export async function generateAgentReview(
	profile: PersonalityProfile,
	agentOutput: string,
	ctx: ExtensionContext,
	llmConfig: LLMConfig,
	signal?: AbortSignal,
): Promise<string> {
	const model = ctx.modelRegistry.find(llmConfig.provider, llmConfig.model);
	if (!model) throw new Error(`Assistant model not found: ${llmConfig.provider}/${llmConfig.model}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`Assistant auth failed: ${auth.error ?? "no API key"}`);

	const reviewPrompt = `The main coding agent just completed a task. Here is its output:\n\n---\n${agentOutput.slice(0, 4000)}\n---\n\nAs a ${profile.name}, review this output briefly. Focus on:\n${profile.goals.map((g) => `- ${g}`).join("\n")}\n\nBe concise — 2–4 sentences max.`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), llmConfig.timeoutMs);
	if (signal) signal.addEventListener("abort", () => controller.abort());

	try {
		const response = await complete(model, { systemPrompt: profile.systemPrompt, messages: [
			{ role: "user", content: [{ type: "text", text: reviewPrompt }], timestamp: Date.now() },
		] }, { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal });
		clearTimeout(timeout);
		return response.content.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text).join("\n").trim() || "(review returned empty)";
	} catch (err) {
		clearTimeout(timeout);
		if ((err as Error).name === "AbortError") return "(review timed out)";
		return `(review error: ${(err as Error).message})`;
	}
}

// ─── Are We There Yet evaluation ─────────────────────────────────────

export interface AWTYResult {
	achieved: boolean;
	summary: string;
	gaps: string[];
	fixes: string[];
	wasFallback: boolean;
}

export interface EvalMemory {
	round: number;
	achieved: boolean;
	summary: string;
	gaps: string[];
	wasFallback: boolean;
}

export async function generateAreWeThereYet(
	profile: PersonalityProfile,
	fullConversation: string,
	fileSnapshot: string,
	ctx: ExtensionContext,
	llmConfig: LLMConfig,
	evalHistory: EvalMemory[] = [],
	busSignals?: string,
): Promise<AWTYResult> {
	const model = ctx.modelRegistry.find(llmConfig.provider, llmConfig.model);
	if (!model) throw new Error(`Model not found: ${llmConfig.provider}/${llmConfig.model}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`Auth failed: ${auth.error ?? "no key"}`);

	// Build evaluation history context
	let historySection = "";
	if (evalHistory.length > 0) {
		const recent = evalHistory.slice(-5);
		const resolved = recent.filter((e) => e.achieved).length;
		const lines = recent.map((e) =>
			`Round ${e.round}: ${e.achieved ? "ACHIEVED" : "NOT ACHIEVED"} - ${e.summary}${e.wasFallback ? " (LLM output was unparseable)" : ""}${e.gaps.length > 0 ? `\n  Gaps: ${e.gaps.join(", ")}` : ""}`,
		);
		historySection = `

=== Evaluation History (${resolved}/${recent.length} resolved) ===
${lines.join("\n")}

Progressive guidance:
- Previously flagged gaps that are now resolved: acknowledge them.
- Gaps that persist across multiple rounds: suggest a fundamentally different approach.
- If the same gap appears 3+ times: break it into smaller sub-tasks.`;
	}

	const round = evalHistory.length + 1;
	const steerNote = round <= 2 ? ""
		: round <= 5 ? "\nNote: This is a multi-round task. Focus on the MOST IMPACTFUL fix first."
		: round <= 10 ? "\nNote: Agent has made multiple attempts. If the same issues persist, suggest a COMPLETELY DIFFERENT approach. Don't repeat previous advice."
		: "\nNote: This is a long-running task. Break remaining work into the smallest possible independent pieces. Prioritize ruthlessly.";

	const signalSection = busSignals && busSignals !== "(no events)"
		? `\n\n=== Real-time Events (from event bus, last 5 min) ===\n${busSignals}\n\nIf you see repeated isolation:blocked or agent:error events, that means the agent is STUCK on infrastructure — not a code problem. The fix should address the tooling issue (e.g., "fix isolation config", "disable isolation", "check API key"), not tell the agent to try harder.`
		: "";

	const evalPrompt = `Here is the full conversation between the user and a coding agent:

---
${fullConversation.slice(0, 8000)}
---

Here are the current contents of the files that were touched during the conversation:

---
${fileSnapshot.slice(0, 12000)}
---${historySection}${signalSection}
Evaluate: has the original goal been fully achieved? (round ${round})
${steerNote}
The file contents above are what is ACTUALLY on disk right now.
Compare the goal against the actual files. Cite specific files and line numbers.
Be brutally honest. Output ONLY valid JSON.`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), llmConfig.timeoutMs);

	try {
		const response = await complete(model, { systemPrompt: profile.systemPrompt, messages: [
			{ role: "user", content: [{ type: "text", text: evalPrompt }], timestamp: Date.now() },
		] }, { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal });
		clearTimeout(timeout);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text).join("\n").trim();
		return parseAWTYResult(text);
	} catch (err) {
		clearTimeout(timeout);
		throw err;
	}
}

// ─── Robust JSON parsing ─────────────────────────────────────────────

function parseAWTYResult(raw: string): AWTYResult {
	// Strip thinking tags some models emit
	let cleaned = raw.replace(/<think[\s\S]*?<\/think>/g, "").trim();

	// Strategy 1: extract from markdown code block
	const codeBlock = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlock) {
		const r = tryParseJSON(codeBlock[1]!);
		if (r) return r;
	}

	// Strategy 2: find balanced braces containing "achieved"
	const balanced = extractBalancedJSON(cleaned);
	if (balanced) {
		const r = tryParseJSON(balanced);
		if (r) return r;
	}

	// Strategy 3: try the whole thing as JSON
	const whole = tryParseJSON(cleaned);
	if (whole) return whole;

	// Fallback: treat raw text as a plain-text evaluation
	const isAchieved = /achieved\s*:\s*true|goal.{0,30}(met|complete|done|achieved|success)/i.test(cleaned);
	return {
		achieved: isAchieved,
		summary: cleaned.slice(0, 500),
		gaps: isAchieved ? [] : ["LLM did not return structured JSON — see summary for details"],
		fixes: [],
		wasFallback: true,
	};
}

function extractBalancedJSON(text: string): string | null {
	const startIdx = text.indexOf("{");
	if (startIdx === -1) return null;

	let depth = 0;
	let inString = false;
	let escape = false;

	for (let i = startIdx; i < text.length; i++) {
		const ch = text[i]!;
		if (escape) { escape = false; continue; }
		if (ch === "\\" && inString) { escape = true; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				const candidate = text.slice(startIdx, i + 1);
				if (candidate.includes("achieved")) return candidate;
				// Try next opening brace after this block
				const next = text.indexOf("{", i + 1);
				if (next === -1) return null;
				return extractBalancedJSON(text.slice(next));
			}
		}
	}
	return null;
}

function tryParseJSON(jsonStr: string): AWTYResult | null {
	try {
		const parsed = JSON.parse(jsonStr.trim());
		if (typeof parsed === "object" && parsed !== null) {
			return {
				achieved: parsed.achieved === true,
				summary: String(parsed.summary ?? ""),
				gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
				fixes: Array.isArray(parsed.fixes) ? parsed.fixes.map(String) : [],
				wasFallback: false,
			};
		}
	} catch { /* not valid JSON */ }
	return null;
}

// ─── Config resolution ────────────────────────────────────────────────

export function resolveLLMConfig(
	assistantConfig: { provider?: string; model?: string; responseTimeoutMs: number },
	ctx: ExtensionContext,
): LLMConfig {
	const sessionModel = ctx.model as any;
	return {
		provider: assistantConfig.provider ?? sessionModel?.provider ?? "zai",
		model: assistantConfig.model ?? sessionModel?.id ?? sessionModel?.name ?? "glm-5-turbo",
		timeoutMs: assistantConfig.responseTimeoutMs,
	};
}
