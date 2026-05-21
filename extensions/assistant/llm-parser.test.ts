/**
 * Unit tests for the AWTY JSON parser in llm.ts.
 * Tests all 4 fallback strategies: code block, balanced braces, whole text, plain text.
 *
 * Run: npx vitest run extensions/assistant/llm-parser.test.ts
 */

import { describe, it, expect } from "vitest";

// Inline the parser functions since they're not exported — we test the logic directly.
// These are copied from llm.ts to keep tests self-contained.

interface AWTYResult {
	achieved: boolean;
	summary: string;
	gaps: string[];
	fixes: string[];
	wasFallback: boolean;
}

function parseAWTYResult(raw: string): AWTYResult {
	let cleaned = raw.replace(/<think[\s\S]*?<\/think>/g, "").trim();

	// Strategy 1: markdown code block
	const codeBlock = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlock) {
		const r = tryParseJSON(codeBlock[1]!);
		if (r) return r;
	}

	// Strategy 2: balanced braces
	const balanced = extractBalancedJSON(cleaned);
	if (balanced) {
		const r = tryParseJSON(balanced);
		if (r) return r;
	}

	// Strategy 3: whole text
	const whole = tryParseJSON(cleaned);
	if (whole) return whole;

	// Strategy 4: plain text fallback
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

// ═══════════════════════════════════════════════════════════════════════

describe("AWTY Parser", () => {

	describe("Strategy 1: Markdown code block extraction", () => {
		it("should parse JSON from ```json code block", () => {
			const input = 'Here is my evaluation:\n```json\n{"achieved": true, "summary": "All done", "gaps": [], "fixes": []}\n```';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toBe("All done");
			expect(result.gaps).toEqual([]);
		});

		it("should parse JSON from ``` code block (no language tag)", () => {
			const input = '```\n{"achieved": false, "summary": "Not done", "gaps": ["missing tests"], "fixes": ["add tests"]}\n```';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
			expect(result.gaps).toEqual(["missing tests"]);
			expect(result.fixes).toEqual(["add tests"]);
		});
	});

	describe("Strategy 2: Balanced brace extraction", () => {
		it("should find JSON object in surrounding text", () => {
			const input = 'I evaluated the goal. Result: {"achieved": false, "summary": "Needs work", "gaps": ["no error handling"], "fixes": ["add try/catch"]} and that is all.';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
			expect(result.summary).toBe("Needs work");
			expect(result.gaps).toEqual(["no error handling"]);
		});

		it("should find JSON with nested braces", () => {
			const input = 'Some text {"achieved": true, "summary": "Done", "gaps": [], "fixes": [], "metadata": {"key": "val"}} end';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toBe("Done");
		});

		it("should skip brace blocks that don't contain 'achieved'", () => {
			const input = 'Here {"type": "other"} then {"achieved": true, "summary": "Yes", "gaps": [], "fixes": []}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
		});

		it("should handle JSON with string containing braces", () => {
			const input = '{"achieved": false, "summary": "Use {curly} braces", "gaps": ["syntax"], "fixes": ["escape { with \\\\}"]}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
			expect(result.summary).toContain("curly");
		});
	});

	describe("Strategy 3: Whole text parse", () => {
		it("should parse raw JSON with no surrounding text", () => {
			const input = '{"achieved": true, "summary": "Perfect", "gaps": [], "fixes": []}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toBe("Perfect");
		});

		it("should parse JSON with extra whitespace", () => {
			const input = '  \n  {"achieved": false, "summary": "Gaps exist", "gaps": ["x"], "fixes": []}  \n  ';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
			expect(result.gaps).toEqual(["x"]);
		});
	});

	describe("Strategy 4: Plain text fallback", () => {
		it("should detect achieved from keyword matching", () => {
			const input = "The goal has been fully achieved. All files are correct.";
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toContain("fully achieved");
		});

		it("should detect achieved from 'achieved: true' pattern", () => {
			const input = "Based on my analysis:\nachieved: true\nEverything looks good.";
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
		});

		it("should default to not achieved with gap message", () => {
			const input = "I don't think this is done. The code is missing error handling.";
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
			expect(result.gaps).toEqual(["LLM did not return structured JSON — see summary for details"]);
		});
	});

	describe("Thinking tag stripping", () => {
		it("should strip thinking tags and parse the JSON after", () => {
			const input = '<think let me analyze this carefully</think\n```json\n{"achieved": true, "summary": "All good", "gaps": [], "fixes": []}\n```';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toBe("All good");
		});

		it("should handle multiple thinking tags", () => {
			const input = '<think first thought</think some text <think second thought</think {"achieved": false, "summary": "Not done", "gaps": ["test"], "fixes": []}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false);
		});
	});

	describe("Edge cases", () => {
		it("should handle empty input", () => {
			const result = parseAWTYResult("");
			expect(result.achieved).toBe(false);
			expect(result.gaps.length).toBeGreaterThan(0);
		});

		it("should handle missing optional fields", () => {
			const input = '{"achieved": true}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(true);
			expect(result.summary).toBe("");
			expect(result.gaps).toEqual([]);
			expect(result.fixes).toEqual([]);
		});

		it("should handle non-boolean achieved gracefully", () => {
			const input = '{"achieved": "yes", "summary": "Looks good", "gaps": [], "fixes": []}';
			const result = parseAWTYResult(input);
			expect(result.achieved).toBe(false); // "yes" !== true
		});
	});
});
