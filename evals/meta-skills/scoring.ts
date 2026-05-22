/**
 * Pipeline Eval Scoring Battery
 *
 * Scores GLM output on multiple dimensions so we can compare
 * configurations objectively instead of binary pass/fail.
 *
 * Usage:
 *   scorePipeline(dir) → { dimensions, total, grade }
 *
 * Each dimension scores 0-10. Total is weighted sum.
 */

import {
	existsSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────

export interface DimensionScore {
	name: string;
	score: number;       // 0-10
	max: number;         // always 10
	weight: number;      // multiplier for total
	details: string;
}

export interface PipelineScore {
	dimensions: DimensionScore[];
	total: number;       // weighted sum
	maxTotal: number;    // max possible weighted sum
	grade: string;       // A/B/C/D/F
	summary: string;
}

// ─── LLM Judge ────────────────────────────────────────────────────

export interface LLMJudgeConfig {
	/** RPC-compatible pi command */
	command?: string;
	/** Model to use for judging */
	model?: string;
	/** Timeout in ms for judge calls */
	timeoutMs?: number;
}

export interface ScoreConfig {
	slug: string;
	expectedSrcFiles: string[];
	runBuild?: boolean;
	/** Enable LLM-based quality scoring */
	llmJudge?: LLMJudgeConfig;
}

const DEFAULT_CONFIG: ScoreConfig = {
	slug: "mcp-discovery",
	expectedSrcFiles: [
		"src/index.ts",
		"src/types.ts",
		"src/config.ts",
		"src/search.ts",
		"src/search.test.ts",
	],
	runBuild: true,
};

const DEFAULT_JUDGE: LLMJudgeConfig = {
	command: "pi",
	model: "zai/glm-5.1",
	timeoutMs: 120_000,
};

// ─── Scoring ────────────────────────────────────────────────────────

export async function scorePipeline(
	dir: string,
	config: Partial<ScoreConfig> = {},
): Promise<PipelineScore> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const slugDir = join(dir, "docs", "plans", cfg.slug);

	const dimensions: DimensionScore[] = [];

	// 1. PLAN COMPLETENESS (weight 1.5)
	// How many of the expected plan artifacts exist?
	dimensions.push(scorePlanCompleteness(slugDir));

	// 2. PLAN STRUCTURE (weight 1.0)
	// Do files have correct sections, formats, tables?
	dimensions.push(scorePlanStructure(slugDir));

	// 3. CRITIQUE SUBSTANCE (weight 1.0)
	// Are critiques specific or generic?
	dimensions.push(scoreCritiqueSubstance(slugDir));

	// 4. Q&A QUALITY (weight 0.5)
	// Are questions real trade-offs with options and rationale?
	dimensions.push(scoreQuestionsQuality(slugDir));

	// 5. CODE EXISTENCE (weight 2.0)
	// Do the expected src files exist with real content?
	dimensions.push(scoreCodeExistence(dir, cfg.expectedSrcFiles));

	// 6. CODE ARCHITECTURE (weight 1.5)
	// Is the code modular? Separation of concerns? Pure functions?
	dimensions.push(scoreCodeArchitecture(dir, cfg.expectedSrcFiles));

	// 7. BUILD (weight 2.0)
	// Does it compile and pass tests?
	if (cfg.runBuild) {
		dimensions.push(await scoreBuild(dir));
	} else {
		dimensions.push({ name: "Build", score: 0, max: 10, weight: 2.0, details: "Skipped" });
	}

	// 8. REVIEW HONESTY (weight 1.0)
	// Did review actually run tests or is it theater?
	dimensions.push(scoreReviewHonesty(slugDir, dir));

	// 9. INSIGHTS VALUE (weight 0.5)
	// Does insights.md have real learnings?
	dimensions.push(scoreInsights(slugDir));

	// 10. COMPLETION ARTIFACTS (weight 0.5)
	// Commit plan, doc manifest?
	dimensions.push(scoreCompletion(slugDir));

	// 11. LLM QUALITY JUDGE (weight 3.0)
	// Non-deterministic: LLM rates plan quality, code-plan alignment, test value
	if (cfg.llmJudge) {
		dimensions.push(await scoreLLMJudge(slugDir, dir, cfg.llmJudge));
	} else {
		dimensions.push({
			name: "LLM Quality",
			score: 0, max: 10, weight: 3.0,
			details: "Skipped (enable with llmJudge config)",
		});
	}

	// Calculate totals
	let total = 0;
	let maxTotal = 0;
	for (const d of dimensions) {
		total += d.score * d.weight;
		maxTotal += d.max * d.weight;
	}

	const pct = total / maxTotal;
	const grade = pct >= 0.9 ? "A" : pct >= 0.8 ? "B" : pct >= 0.7 ? "C" : pct >= 0.6 ? "D" : "F";

	const summary = dimensions
		.map(d => `${d.name}: ${d.score}/${d.max}`)
		.join(" | ");

	return { dimensions, total, maxTotal, grade, summary };
}

// ─── Dimension scorers ──────────────────────────────────────────────

function scorePlanCompleteness(slugDir: string): DimensionScore {
	const expectedFiles = [
		"invariants.md",
		"meta.md",
		"prompt.md",
		"research/locate-codebase.md",
		"research/locate-docs.md",
		"research/locate-git-history.md",
		"research/locate-patterns.md",
		"research/research-architecture.md",
		"research/research-domain.md",
		"research/research-patterns.md",
		"research/research-web.md",
		"initial-plan.md",
		"user-flow-spec.md",
		"deepened-plan.md",
		"critiques/critique-swe.md",
		"critiques/critique-security.md",
		"critiques/critique-perf.md",
		"critiques/critique-ux.md",
		"questions.md",
		"final-plan.md",
		"execution/task-breakdown.md",
		"execution/task-log.md",
	];

	const found = expectedFiles.filter(f => {
		const fullPath = join(slugDir, ...f.split("/"));
		return existsSync(fullPath) && readFileSync(fullPath, "utf8").length > 20;
	}).length;

	const score = Math.round((found / expectedFiles.length) * 10);
	return {
		name: "Plan Completeness",
		score,
		max: 10,
		weight: 1.5,
		details: `${found}/${expectedFiles.length} files exist with content`,
	};
}

function scorePlanStructure(slugDir: string): DimensionScore {
	let points = 0;
	const maxPoints = 10;
	const details: string[] = [];

	// meta.md has phase tracking table (2 points)
	const meta = tryRead(join(slugDir, "meta.md"));
	if (meta && /Phase.*Status|Status.*Phase/i.test(meta)) {
		points += 2;
		details.push("meta.md: phase table ✓");
	} else {
		details.push("meta.md: no phase table");
	}

	// meta.md has slug (1 point)
	if (meta && /slug/i.test(meta)) {
		points += 1;
		details.push("meta.md: slug ✓");
	}

	// prompt.md has timestamp (1 point)
	const prompt = tryRead(join(slugDir, "prompt.md"));
	if (prompt && /timestamp/i.test(prompt)) {
		points += 1;
		details.push("prompt.md: timestamp ✓");
	}

	// initial-plan has Goal + Architecture + Testing (2 points)
	const plan = tryRead(join(slugDir, "initial-plan.md"));
	if (plan) {
		const hasGoal = /Goal/i.test(plan);
		const hasArch = /Architecture/i.test(plan);
		const hasTesting = /Test/i.test(plan);
		const planPoints = [hasGoal, hasArch, hasTesting].filter(Boolean).length;
		points += Math.round((planPoints / 3) * 2);
		details.push(`initial-plan: ${planPoints}/3 key sections`);
	}

	// user-flow-spec has actors + flows + test matrix (2 points)
	const flowSpec = tryRead(join(slugDir, "user-flow-spec.md"));
	if (flowSpec) {
		const hasActors = /Actor/i.test(flowSpec);
		const hasFlows = /Flow/i.test(flowSpec);
		const hasMatrix = /test matrix|Test Matrix/i.test(flowSpec);
		const flowPoints = [hasActors, hasFlows, hasMatrix].filter(Boolean).length;
		points += Math.round((flowPoints / 3) * 2);
		details.push(`user-flow-spec: ${flowPoints}/3 (actors, flows, matrix)`);
	}

	// final-plan has Q&A resolutions (1 point)
	const finalPlan = tryRead(join(slugDir, "final-plan.md"));
	if (finalPlan && /Q&A|resolution|auto-resolve/i.test(finalPlan)) {
		points += 1;
		details.push("final-plan: Q&A resolutions ✓");
	}

	return {
		name: "Plan Structure",
		score: points,
		max: 10,
		weight: 1.0,
		details: details.join("; "),
	};
}

function scoreCritiqueSubstance(slugDir: string): DimensionScore {
	const critiqueFiles = [
		"critiques/critique-swe.md",
		"critiques/critique-security.md",
		"critiques/critique-perf.md",
		"critiques/critique-ux.md",
	];

	let totalSeverity = 0;
	let totalChars = 0;
	let filesWithContent = 0;
	const details: string[] = [];

	for (const f of critiqueFiles) {
		const content = tryRead(join(slugDir, ...f.split("/")));
		if (!content || content.length < 50) {
			details.push(`${f}: missing/empty`);
			continue;
		}
		filesWithContent++;
		totalChars += content.length;
		const severities = (content.match(/High|Medium|Low/gi) || []).length;
		totalSeverity += severities;
		details.push(`${f}: ${severities} issues, ${content.length} chars`);
	}

	// Score: average severity count * 2 (max 10 if avg >= 5)
	const avgSeverity = filesWithContent > 0 ? totalSeverity / filesWithContent : 0;
	const score = Math.min(10, Math.round(avgSeverity * 2));

	return {
		name: "Critique Substance",
		score,
		max: 10,
		weight: 1.0,
		details: details.join("; "),
	};
}

function scoreQuestionsQuality(slugDir: string): DimensionScore {
	const content = tryRead(join(slugDir, "questions.md"));
	if (!content) {
		return { name: "Q&A Quality", score: 0, max: 10, weight: 0.5, details: "questions.md missing" };
	}

	let points = 0;
	const details: string[] = [];

	// Has auto-resolved questions (2 points)
	const autoResolved = (content.match(/AUTO-RESOLVED|auto-resolve|auto.resolve/i) || []).length;
	if (autoResolved >= 3) {
		points += 2;
		details.push(`${autoResolved} auto-resolved questions`);
	} else if (autoResolved >= 1) {
		points += 1;
	}

	// Has options (A/B/C) (2 points)
	const options = (content.match(/\*?\*?\(A\)|\*?\*?\(B\)|Option A|Option B/i) || []).length;
	if (options >= 4) {
		points += 2;
		details.push(`${options} options`);
	} else if (options >= 2) {
		points += 1;
	}

	// Has rationale/confidence (2 points)
	if (/rationale|confidence|high confidence/i.test(content)) {
		points += 2;
		details.push("has rationale/confidence");
	}

	// Size check (2 points for >= 1500 chars)
	if (content.length >= 1500) {
		points += 2;
		details.push(`${content.length} chars (substantial)`);
	} else if (content.length >= 500) {
		points += 1;
	}

	// Number of distinct questions (2 points for >= 3)
	const questions = (content.match(/\*\*Q\d|Q\d:/g) || []).length;
	if (questions >= 3) {
		points += 2;
		details.push(`${questions} questions`);
	} else if (questions >= 1) {
		points += 1;
	}

	return {
		name: "Q&A Quality",
		score: points,
		max: 10,
		weight: 0.5,
		details: details.join("; "),
	};
}

function scoreCodeExistence(dir: string, expectedFiles: string[]): DimensionScore {
	let found = 0;
	let totalChars = 0;
	const details: string[] = [];

	for (const f of expectedFiles) {
		const fullPath = join(dir, f);
		const content = tryRead(fullPath);
		if (!content) {
			details.push(`${f}: MISSING`);
			continue;
		}
		if (content.length < 50) {
			details.push(`${f}: ${content.length} chars (too small)`);
			continue;
		}
		found++;
		totalChars += content.length;
		details.push(`${f}: ${content.length} chars`);
	}

	// 5 points for existence, 5 points for substantial content
	const existenceScore = Math.round((found / expectedFiles.length) * 5);
	const contentScore = totalChars > 5000 ? 5 : totalChars > 2000 ? 3 : totalChars > 500 ? 1 : 0;

	return {
		name: "Code Existence",
		score: existenceScore + contentScore,
		max: 10,
		weight: 2.0,
		details: details.join("; "),
	};
}

function scoreCodeArchitecture(dir: string, expectedFiles: string[]): DimensionScore {
	let points = 0;
	const details: string[] = [];

	// Check for modular file structure (not all in one file)
	const srcFiles = readdirSync(join(dir, "src"), { withFileTypes: true })
		.filter(d => d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".d.ts"))
		.map(d => d.name);
	if (srcFiles.length >= 4) {
		points += 3;
		details.push(`${srcFiles.length} src files (modular)`);
	} else if (srcFiles.length >= 2) {
		points += 1;
		details.push(`${srcFiles.length} src files (partial)`);
	} else {
		details.push(`${srcFiles.length} src files (monolithic)`);
	}

	// Check types.ts has real interfaces
	const types = tryRead(join(dir, "src/types.ts"));
	if (types) {
		const interfaces = (types.match(/export interface/g) || []).length;
		if (interfaces >= 3) {
			points += 2;
			details.push(`types.ts: ${interfaces} interfaces`);
		} else if (interfaces >= 1) {
			points += 1;
		}
	}

	// Check search.ts has pure functions
	const search = tryRead(join(dir, "src/search.ts"));
	if (search) {
		const exports = (search.match(/export function/g) || []).length;
		if (exports >= 3) {
			points += 2;
			details.push(`search.ts: ${exports} exported functions`);
		} else if (exports >= 1) {
			points += 1;
		}
		// Pure function indicator: no fs, no network
		if (!search.includes("import") || !/import.*fs|import.*http|import.*fetch/.test(search)) {
			points += 1;
			details.push("search.ts: pure (no I/O imports)");
		}
	}

	// Check index.ts exports default function
	const index = tryRead(join(dir, "src/index.ts"));
	if (index) {
		if (/export default function/i.test(index)) {
			points += 2;
			details.push("index.ts: default export ✓");
		}
		if (/registerTool|pi\.register/i.test(index)) {
			points += 1;
			details.push("index.ts: registers tools ✓");
		}
	}

	return {
		name: "Code Architecture",
		score: Math.min(10, points),
		max: 10,
		weight: 1.5,
		details: details.join("; "),
	};
}

async function scoreBuild(dir: string): Promise<DimensionScore> {
	let tscOk = false;
	let testOk = false;
	let tscError = "";
	let testOutput = "";

	// npm install
	const installResult = spawn("npm", ["install"], { cwd: dir, stdio: "pipe" });
	await new Promise<void>((resolve) => {
		installResult.on("close", () => resolve());
	});

	// tsc
	const tscResult = spawn("npx", ["tsc", "--noEmit"], { cwd: dir, stdio: "pipe" });
	tscResult.stderr?.on("data", (d: Buffer) => tscError += d.toString());
	tscResult.stdout?.on("data", (d: Buffer) => tscError += d.toString());
	const tscExit = await new Promise<number>((resolve) => tscResult.on("close", resolve));
	tscOk = tscExit === 0;

	// vitest
	const testResult = spawn("npx", ["vitest", "run"], { cwd: dir, stdio: "pipe" });
	testResult.stdout?.on("data", (d: Buffer) => testOutput += d.toString());
	testResult.stderr?.on("data", (d: Buffer) => testOutput += d.toString());
	const testExit = await new Promise<number>((resolve) => testResult.on("close", resolve));
	testOk = testExit === 0;

	// Score: tsc=5 points, vitest=5 points
	const score = (tscOk ? 5 : 0) + (testOk ? 5 : 0);
	const details: string[] = [];
	details.push(`tsc: ${tscOk ? "PASS" : "FAIL"}`);
	if (!tscOk) details.push(tscError.slice(-200));
	details.push(`vitest: ${testOk ? "PASS" : "FAIL"}`);
	if (!testOk) details.push(testOutput.slice(-200));

	return {
		name: "Build",
		score,
		max: 10,
		weight: 2.0,
		details: details.join("; "),
	};
}

function scoreReviewHonesty(slugDir: string, dir: string): DimensionScore {
	const reviewPath = join(slugDir, "review", "test-results.md");
	const content = tryRead(reviewPath);

	if (!content) {
		return { name: "Review Honesty", score: 0, max: 10, weight: 1.0, details: "review/test-results.md missing" };
	}

	let points = 0;
	const details: string[] = [];

	// File exists (2 points)
	points += 2;
	details.push("review file exists");

	// Contains "Meets Standards" (2 points)
	if (/meets standards/i.test(content)) {
		points += 2;
		details.push("has Meets Standards verdict");
	}

	// Contains test count/exit code — signs of real execution (3 points)
	if (/passed|failed|exit/i.test(content)) {
		points += 3;
		details.push("has pass/fail counts");
	}

	// Contains actual error output (not just "all good") (3 points)
	if (/error|warning|TS\d{4}|FAIL/i.test(content) || content.length > 500) {
		points += 3;
		details.push(`substantial content (${content.length} chars)`);
	}

	return {
		name: "Review Honesty",
		score: points,
		max: 10,
		weight: 1.0,
		details: details.join("; "),
	};
}

function scoreInsights(slugDir: string): DimensionScore {
	const content = tryRead(join(slugDir, "insights.md"));

	if (!content) {
		return { name: "Insights Value", score: 0, max: 10, weight: 0.5, details: "insights.md missing" };
	}

	let points = 0;
	const details: string[] = [];

	// Size (2 points for substantial)
	if (content.length >= 1500) {
		points += 2;
		details.push(`${content.length} chars (substantial)`);
	} else if (content.length >= 500) {
		points += 1;
	}

	// Has research highlights (2 points)
	if (/research|web|highlight/i.test(content)) {
		points += 2;
		details.push("has research highlights");
	}

	// Has trade-off decisions (2 points)
	if (/trade.?off|decision|rationale/i.test(content)) {
		points += 2;
		details.push("has trade-off decisions");
	}

	// Has patterns (2 points)
	if (/pattern|discover/i.test(content)) {
		points += 2;
		details.push("has patterns");
	}

	// Has process improvements (2 points)
	if (/improvement|process|next time/i.test(content)) {
		points += 2;
		details.push("has process improvements");
	}

	return {
		name: "Insights Value",
		score: points,
		max: 10,
		weight: 0.5,
		details: details.join("; "),
	};
}

function scoreCompletion(slugDir: string): DimensionScore {
	let points = 0;
	const details: string[] = [];

	const commitPlan = tryRead(join(slugDir, "complete", "commit-plan.md"));
	const docManifest = tryRead(join(slugDir, "complete", "doc-manifest.md"));

	if (commitPlan) {
		points += 5;
		details.push(`commit-plan: ${commitPlan.length} chars`);
		if (/commit|message|file/i.test(commitPlan)) {
			points += 1;
			details.push("commit-plan: has commit structure");
		}
	}

	if (docManifest) {
		points += 4;
		details.push(`doc-manifest: ${docManifest.length} chars`);
	}

	return {
		name: "Completion Artifacts",
		score: Math.min(10, points),
		max: 10,
		weight: 0.5,
		details: details.join("; ") || "no completion artifacts",
	};
}

// ─── LLM Judge Scorer ──────────────────────────────────────────────

async function scoreLLMJudge(
	slugDir: string,
	projectDir: string,
	judgeConfig: LLMJudgeConfig,
): Promise<DimensionScore> {
	const cfg = { ...DEFAULT_JUDGE, ...judgeConfig };

	// Gather key artifacts for the judge to evaluate
	const artifacts: Record<string, string> = {};

	const planFiles = {
		"initial-plan": "initial-plan.md",
		"user-flow-spec": "user-flow-spec.md",
		"final-plan": "final-plan.md",
		"questions": "questions.md",
		"critique-swe": "critiques/critique-swe.md",
		"critique-security": "critiques/critique-security.md",
		"insights": "insights.md",
	};

	for (const [key, path] of Object.entries(planFiles)) {
		const content = tryRead(join(slugDir, ...path.split("/")));
		if (content) artifacts[key] = content.slice(0, 3000); // cap to avoid context overflow
	}

	// Add src files
	const srcFiles = ["src/index.ts", "src/search.ts", "src/search.test.ts"];
	for (const f of srcFiles) {
		const content = tryRead(join(projectDir, f));
		if (content) artifacts[f] = content.slice(0, 3000);
	}

	if (Object.keys(artifacts).length === 0) {
		return {
			name: "LLM Quality",
			score: 0, max: 10, weight: 3.0,
			details: "No artifacts found to judge",
		};
	}

	// Build the judge prompt
	const artifactBlock = Object.entries(artifacts)
		.map(([k, v]) => `## ${k}\n${v}`)
		.join("\n\n");

	const judgePrompt = `You are a senior engineering manager reviewing a planning + implementation pipeline output.
Rate the quality on a 0-10 scale across these dimensions. Be critical — average work is a 5, not a 7.

Respond with ONLY a JSON object like: {"plan_quality": 7, "critique_depth": 5, "code_plan_alignment": 8, "test_value": 6, "architecture": 7, "overall": 7, "reasoning": "brief explanation"}

## Dimensions to rate:

1. **plan_quality** (0-10): Is the initial-plan substantive? Does it have real architecture decisions,
   specific file lists, data models, and a testing strategy? Or is it generic filler?

2. **critique_depth** (0-10): Do the critiques reference specific plan text? Are concerns concrete
   with severity ratings and actionable fixes? Or are they generic advice like "add error handling"?

3. **code_plan_alignment** (0-10): Does the actual code match what the plan described?
   Same file structure? Same interfaces? Same architecture? Or did implementation diverge?

4. **test_value** (0-10): Are the tests meaningful? Do they test real behavior and edge cases?
   Or are they trivial assertions that pass on anything?

5. **architecture** (0-10): Is the code well-structured? Separation of concerns? Pure functions?
   No god objects? Would you merge this PR?

6. **overall** (0-10): Overall pipeline quality — would you trust this planning process
   for a real feature in your codebase?

## Artifacts to evaluate:

${artifactBlock}`;

	// Call the LLM via pi RPC
	const score = await callLLMJudge(judgePrompt, cfg);

	// Weighted average of the 6 sub-dimensions → single 0-10 score
	const subScores = [
		score.plan_quality ?? 0,
		score.critique_depth ?? 0,
		score.code_plan_alignment ?? 0,
		score.test_value ?? 0,
		score.architecture ?? 0,
		score.overall ?? 0,
	];
	const avg = subScores.reduce((a, b) => a + b, 0) / subScores.length;

	const details = [
		`plan:${score.plan_quality ?? "?"} critique:${score.critique_depth ?? "?"} alignment:${score.code_plan_alignment ?? "?"} test:${score.test_value ?? "?"} arch:${score.architecture ?? "?"} overall:${score.overall ?? "?"}`,
		score.reasoning ?? "",
	].join(" | ");

	return {
		name: "LLM Quality",
		score: Math.round(avg),
		max: 10,
		weight: 3.0,
		details,
	};
}

interface LLMJudgeResult {
	plan_quality?: number;
	critique_depth?: number;
	code_plan_alignment?: number;
	test_value?: number;
	architecture?: number;
	overall?: number;
	reasoning?: string;
}

async function callLLMJudge(
	prompt: string,
	cfg: LLMJudgeConfig,
): Promise<LLMJudgeResult> {
	const tmpDir = join(process.cwd(), ".tmp", "llm-judge");
	const { mkdirSync, writeFileSync } = require("node:fs");
	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "judge", private: true }));

	return new Promise<LLMJudgeResult>((resolve) => {
		const args = ["--mode", "rpc", "--no-session", "--model", cfg.model ?? "zai/glm-5.1"];
		const proc = spawn(cfg.command ?? "pi", args, {
			cwd: tmpDir,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let buffer = "";
		proc.stdout!.on("data", (d: Buffer) => { buffer += d.toString(); });

		proc.stdin!.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");

		const timeout = setTimeout(() => {
			proc.kill();
			resolve({ overall: 0, reasoning: "LLM judge timed out" });
		}, cfg.timeoutMs ?? 120_000);

		const check = setInterval(() => {
			if (buffer.includes('"type":"agent_end"') || buffer.includes('"type": "agent_end"')) {
				clearInterval(check);
				clearTimeout(timeout);

				// Extract the text response
				const parts: string[] = [];
				for (const line of buffer.split("\n")) {
					if (!line.trim()) continue;
					try {
						const obj = JSON.parse(line);
						if (obj.type === "message_update") {
							const msg = obj.message;
							if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
								for (const block of msg.content) {
									if (block.type === "text" && typeof block.text === "string") {
										parts.push(block.text);
									}
								}
							}
						}
					} catch { /* not json */ }
				}

				const text = parts.join("");

				// Parse JSON from response
				try {
					const jsonMatch = text.match(/\{[\s\S]*?\}/);
					if (jsonMatch) {
						const parsed = JSON.parse(jsonMatch[0]);
						proc.kill();
						resolve({
							plan_quality: clamp(parsed.plan_quality),
							critique_depth: clamp(parsed.critique_depth),
							code_plan_alignment: clamp(parsed.code_plan_alignment),
							test_value: clamp(parsed.test_value),
							architecture: clamp(parsed.architecture),
							overall: clamp(parsed.overall),
							reasoning: parsed.reasoning ?? "",
						});
					} else {
						proc.kill();
						resolve({ overall: 0, reasoning: "No JSON in LLM response" });
					}
				} catch (e: any) {
					proc.kill();
					resolve({ overall: 0, reasoning: `Parse error: ${e.message}` });
				}
			}
		}, 500);
	});
}

function clamp(n: unknown): number | undefined {
	if (typeof n !== "number") return undefined;
	return Math.max(0, Math.min(10, Math.round(n)));
}

// ─── Helpers ────────────────────────────────────────────────────────

function tryRead(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const content = readFileSync(path, "utf8");
		return content.length > 10 ? content : null;
	} catch {
		return null;
	}
}

// ─── Grade helper ───────────────────────────────────────────────────

export function formatScore(score: PipelineScore): string {
	const lines: string[] = [];
	lines.push(`\n╔══════════════════════════════════════════════════╗`);
	lines.push(`║  PIPELINE SCORE: ${score.grade} (${(score.total / score.maxTotal * 100).toFixed(0)}%)`.padEnd(50) + `║`);
	lines.push(`║  ${score.total.toFixed(1)} / ${score.maxTotal.toFixed(1)} points`.padEnd(50) + `║`);
	lines.push(`╠══════════════════════════════════════════════════╣`);

	for (const d of score.dimensions) {
		const bar = "█".repeat(d.score) + "░".repeat(d.max - d.score);
		const padded = `${d.name}: ${bar} ${d.score}/${d.max}`;
		lines.push(`║  ${padded}`.padEnd(50) + `║`);
		lines.push(`║  ${d.details}`.slice(0, 49).padEnd(50) + `║`);
	}

	lines.push(`╚══════════════════════════════════════════════════╝`);
	return lines.join("\n");
}
