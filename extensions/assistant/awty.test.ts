/**
 * Unit tests for the AWTY evaluation loop components:
 *   - parseAWTYResult (4-level JSON fallback + wasFallback flag)
 *   - Eval memory and progressive evaluation
 *   - Smarter reprompts based on round count
 *   - Evaluator failure detection (consecutive fallbacks)
 *   - Session history accumulation
 *   - File change detection (snapshot hashing)
 *   - Persistent gap detection
 *
 * Run: npx vitest run extensions/assistant/awty.test.ts
 */

import { describe, it, expect } from "vitest";

// --- Inline logic under test ---

interface AWTYResult {
	achieved: boolean;
	summary: string;
	gaps: string[];
	fixes: string[];
	wasFallback: boolean;
}

function parseAWTYResult(raw: string): AWTYResult {
	let cleaned = raw.replace(/<think[\s\S]*?<\/think>/g, "").trim();
	const codeBlock = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlock) {
		const r = tryParseJSON(codeBlock[1]!);
		if (r) return r;
	}
	const balanced = extractBalancedJSON(cleaned);
	if (balanced) {
		const r = tryParseJSON(balanced);
		if (r) return r;
	}
	const whole = tryParseJSON(cleaned);
	if (whole) return whole;
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
	let depth = 0, inString = false, escape = false;
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
	} catch {}
	return null;
}

function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return hash.toString(36);
}

interface EvalEntry { gaps: string[]; wasFallback: boolean; }

function findPersistentGaps(history: EvalEntry[]): string[] {
	if (history.length < 3) return [];
	const recent = history.slice(-5);
	const gapCounts = new Map<string, number>();
	for (const eval_ of recent) {
		if (eval_.wasFallback) continue;
		for (const gap of eval_.gaps) {
			const normalized = gap.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
			if (normalized.length < 5) continue;
			gapCounts.set(normalized, (gapCounts.get(normalized) ?? 0) + 1);
		}
	}
	return [...gapCounts.entries()]
		.filter(([, count]) => count >= 2)
		.map(([gap]) => gap);
}

function shouldEvaluate(
	userText: string,
	evalInProgress: boolean,
): boolean {
	if (evalInProgress) return false;
	if (userText.includes("Are We There Yet evaluation found")) return false;
	return true;
}

function accumulateHistory(
	sessionHistory: Array<{ role: string; text: string }>,
	messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> }>,
	maxEntries = 200,
): Array<{ role: string; text: string }> {
	const updated = [...sessionHistory];
	for (const m of messages) {
		if (m.role === "user" || m.role === "assistant") {
			const text = (m.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n").trim();
			if (text) updated.push({ role: m.role, text });
		}
	}
	return updated.length > maxEntries ? updated.slice(-maxEntries) : updated;
}

function getSteerText(round: number, fixPrompt: string): string {
	if (round <= 2) {
		return `Are We There Yet evaluation found these gaps:\n${fixPrompt}\n\nFix all of the above. Be specific and thorough.`;
	} else if (round <= 5) {
		return `Are We There Yet evaluation (round ${round}) found these gaps:\n${fixPrompt}\n\nFocus on the MOST IMPACTFUL fix first.`;
	} else if (round <= 10) {
		return `Are We There Yet evaluation (round ${round}) found these gaps:\n${fixPrompt}\n\nTry a COMPLETELY DIFFERENT approach.`;
	} else {
		return `Are We There Yet evaluation (round ${round}).\nRemaining gaps:\n${fixPrompt}\n\nBreak this into the smallest pieces. Fix ONE thing.`;
	}
}

function shouldStopForFallback(evalHistory: EvalEntry[]): boolean {
	const recent = evalHistory.slice(-3);
	return recent.filter((e) => e.wasFallback).length >= 2;
}

// ═══════════════════════════════════════════════════════════════════════

describe("AWTY Evaluation Loop", () => {

	// --- Parser ---

	describe("parseAWTYResult", () => {
		it("parses clean JSON with wasFallback false", () => {
			const r = parseAWTYResult('{"achieved":true,"summary":"done","gaps":[],"fixes":[]}');
			expect(r.achieved).toBe(true);
			expect(r.wasFallback).toBe(false);
		});

		it("parses code block with wasFallback false", () => {
			const r = parseAWTYResult('```json\n{"achieved":false,"summary":"no","gaps":["x"],"fixes":[]}\n```');
			expect(r.wasFallback).toBe(false);
		});

		it("sets wasFallback true on plain text fallback", () => {
			const r = parseAWTYResult("I don't think this is done.");
			expect(r.wasFallback).toBe(true);
			expect(r.achieved).toBe(false);
		});

		it("detects achieved keywords in fallback", () => {
			const r = parseAWTYResult("The goal has been achieved.");
			expect(r.achieved).toBe(true);
			expect(r.wasFallback).toBe(true);
		});
	});

	// --- Eval failure detection ---

	describe("evaluator failure detection", () => {
		it("stops after 2 consecutive fallback results", () => {
			const history: EvalEntry[] = [
				{ gaps: ["x"], wasFallback: false },
				{ gaps: ["y"], wasFallback: true },
				{ gaps: ["z"], wasFallback: true },
			];
			expect(shouldStopForFallback(history)).toBe(true);
		});

		it("does not stop with only 1 fallback", () => {
			const history: EvalEntry[] = [
				{ gaps: ["x"], wasFallback: false },
				{ gaps: ["y"], wasFallback: true },
			];
			expect(shouldStopForFallback(history)).toBe(false);
		});

		it("does not stop with clean results", () => {
			const history: EvalEntry[] = [
				{ gaps: ["x"], wasFallback: false },
				{ gaps: ["y"], wasFallback: false },
				{ gaps: ["z"], wasFallback: false },
			];
			expect(shouldStopForFallback(history)).toBe(false);
		});

		it("only checks last 3 results", () => {
			const history: EvalEntry[] = [
				{ gaps: [], wasFallback: true },
				{ gaps: [], wasFallback: true },
				{ gaps: ["x"], wasFallback: false },
				{ gaps: ["y"], wasFallback: false },
			];
			expect(shouldStopForFallback(history)).toBe(false);
		});
	});

	// --- Smarter reprompts ---

	describe("steer text by round", () => {
		it("round 1-2: standard fix prompt", () => {
			const text = getSteerText(1, "1. Fix X");
			expect(text).toContain("Fix all of the above");
			expect(text).not.toContain("round");
		});

		it("round 3-5: prioritize most impactful", () => {
			const text = getSteerText(3, "1. Fix X");
			expect(text).toContain("MOST IMPACTFUL");
		});

		it("round 6-10: different approach", () => {
			const text = getSteerText(7, "1. Fix X");
			expect(text).toContain("COMPLETELY DIFFERENT");
		});

		it("round 11+: break into pieces", () => {
			const text = getSteerText(12, "1. Fix X");
			expect(text).toContain("ONE thing");
		});
	});

	// --- Persistent gap detection ---

	describe("findPersistentGaps", () => {
		it("finds gaps that appear 2+ times", () => {
			const history: EvalEntry[] = [
				{ gaps: ["Missing unit tests for parser"], wasFallback: false },
				{ gaps: ["Missing unit tests for parser", "No error handling"], wasFallback: false },
				{ gaps: ["Missing unit tests for parser"], wasFallback: false },
			];
			const persistent = findPersistentGaps(history);
			expect(persistent).toContain("missing unit tests for parser");
		});

		it("returns empty for diverse gaps", () => {
			const history: EvalEntry[] = [
				{ gaps: ["Gap A"], wasFallback: false },
				{ gaps: ["Gap B"], wasFallback: false },
				{ gaps: ["Gap C"], wasFallback: false },
			];
			expect(findPersistentGaps(history)).toEqual([]);
		});

		it("skips fallback entries", () => {
			const history: EvalEntry[] = [
				{ gaps: ["Same gap"], wasFallback: true },
				{ gaps: ["Same gap"], wasFallback: true },
				{ gaps: ["Same gap"], wasFallback: true },
			];
			expect(findPersistentGaps(history)).toEqual([]);
		});

		it("requires at least 3 history entries", () => {
			const history: EvalEntry[] = [
				{ gaps: ["Same gap"], wasFallback: false },
				{ gaps: ["Same gap"], wasFallback: false },
			];
			expect(findPersistentGaps(history)).toEqual([]);
		});
	});

	// --- Snapshot hashing ---

	describe("snapshot change detection", () => {
		it("same content produces same hash", () => {
			const content = "file contents here";
			expect(hashString(content)).toBe(hashString(content));
		});

		it("different content produces different hash", () => {
			expect(hashString("content A")).not.toBe(hashString("content B"));
		});

		it("simulates skip-eval-when-no-change", () => {
			const snapshot = "=== Files ===\n--- foo.ts ---\nconst x = 1;";
			const hash1 = hashString(snapshot);
			const hash2 = hashString(snapshot);
			expect(hash1).toBe(hash2); // no change, should skip
		});
	});

	// --- Session history ---

	describe("accumulateHistory", () => {
		it("accumulates user and assistant messages", () => {
			const history = accumulateHistory([], [
				{ role: "user", content: [{ type: "text", text: "Hello" }] },
				{ role: "assistant", content: [{ type: "text", text: "Hi there" }] },
			]);
			expect(history).toEqual([
				{ role: "user", text: "Hello" },
				{ role: "assistant", text: "Hi there" },
			]);
		});

		it("skips non-text and non-user/assistant messages", () => {
			const history = accumulateHistory([], [
				{ role: "toolResult" as any, content: [{ type: "text", text: "skipped" }] },
				{ role: "user", content: [{ type: "text", text: "kept" }] },
			]);
			expect(history).toEqual([{ role: "user", text: "kept" }]);
		});
	});

	// --- Full loop simulation ---

	describe("full AWTY loop simulation", () => {
		it("simulates progressive evaluation with memory", () => {
			const evalHistory: EvalEntry[] = [];
			let repromptCount = 0;

			// Round 1: gaps found
			evalHistory.push({ gaps: ["missing tests", "no error handling"], wasFallback: false });
			repromptCount++;
			const steer1 = getSteerText(repromptCount, "1. missing tests\n2. no error handling");
			expect(steer1).toContain("Fix all of the above");

			// Round 2: one gap resolved
			evalHistory.push({ gaps: ["no error handling"], wasFallback: false });
			repromptCount++;
			const steer2 = getSteerText(repromptCount, "1. no error handling");
			expect(steer2).toContain("Fix all of the above");

			// Round 3: escalate priority
			evalHistory.push({ gaps: ["no error handling"], wasFallback: false });
			repromptCount++;
			const steer3 = getSteerText(repromptCount, "1. no error handling");
			expect(steer3).toContain("MOST IMPACTFUL");

			// Detect persistent gap
			const persistent = findPersistentGaps(evalHistory);
			expect(persistent).toContain("no error handling");

			// Round 7: suggest different approach
			repromptCount = 7;
			const steer7 = getSteerText(repromptCount, "1. no error handling");
			expect(steer7).toContain("COMPLETELY DIFFERENT");
		});

		it("stops reprompting on evaluator failure", () => {
			const evalHistory: EvalEntry[] = [];
			evalHistory.push({ gaps: ["x"], wasFallback: true });
			evalHistory.push({ gaps: ["y"], wasFallback: true });
			expect(shouldStopForFallback(evalHistory)).toBe(true);
		});

		it("skips evaluation when files haven't changed", () => {
			const snapshot = "file content v1";
			const hash1 = hashString(snapshot);
			const hash2 = hashString(snapshot);
			expect(hash1 === hash2).toBe(true); // should skip
			expect(hash1 === hashString("file content v2")).toBe(false); // should eval
		});
	});
});
