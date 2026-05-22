/**
 * Pipeline Eval Checklist
 *
 * Flat battery of yes/no checks. Both deterministic (file checks, regex)
 * and non-deterministic (LLM judge). No weights, no grades — just a list
 * of what passed and what didn't.
 *
 * Usage:
 *   checkPipeline(dir) → { checks: Check[], passed: number, total: number }
 */

import {
	existsSync, readFileSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ─── Types ──────────────────────────────────────────────────────────

export interface Check {
	id: string;
	category: string;
	description: string;
	passed: boolean;
	details: string;
	method: "deterministic" | "llm";
}

export interface PipelineReport {
	checks: Check[];
	passed: number;
	total: number;
	byCategory: Record<string, { passed: number; total: number }>;
}

export interface CheckConfig {
	slug: string;
	expectedSrcFiles: string[];
	runBuild?: boolean;
	llmJudge?: { model?: string; timeoutMs?: number };
}

// ─── Main ───────────────────────────────────────────────────────────

export async function checkPipeline(
	dir: string,
	config: Partial<CheckConfig> = {},
): Promise<PipelineReport> {
	const cfg: CheckConfig = {
		slug: "mcp-discovery",
		expectedSrcFiles: [
			"src/index.ts",
			"src/types.ts",
			"src/config.ts",
			"src/search.ts",
			"src/search.test.ts",
		],
		runBuild: true,
		...config,
	};
	const slugDir = join(dir, "docs", "plans", cfg.slug);
	const checks: Check[] = [];

	// ── Plan Artifacts ──
	const planFiles = {
		"invariants.md": "invariants.md",
		"meta.md": "meta.md",
		"prompt.md": "prompt.md",
		"initial-plan.md": "initial-plan.md",
		"user-flow-spec.md": "user-flow-spec.md",
		"deepened-plan.md": "deepened-plan.md",
		"questions.md": "questions.md",
		"final-plan.md": "final-plan.md",
		"task-breakdown.md": "execution/task-breakdown.md",
		"task-log.md": "execution/task-log.md",
		"test-results.md": "review/test-results.md",
		"insights.md": "insights.md",
		"commit-plan.md": "complete/commit-plan.md",
		"doc-manifest.md": "complete/doc-manifest.md",
	};
	for (const [label, path] of Object.entries(planFiles)) {
		const full = join(slugDir, ...path.split("/"));
		const content = tryRead(full);
		checks.push({
			id: `plan-exists:${label}`,
			category: "Plan Artifacts",
			description: `${label} exists with content`,
			passed: !!content && content.length > 20,
			details: content ? `${content.length} chars` : "missing",
			method: "deterministic",
		});
	}

	// Research files
	const researchFiles = [
		"locate-codebase.md", "locate-docs.md", "locate-git-history.md",
		"locate-patterns.md", "research-architecture.md", "research-domain.md",
		"research-patterns.md", "research-web.md",
	];
	for (const f of researchFiles) {
		const content = tryRead(join(slugDir, "research", f));
		checks.push({
			id: `research-exists:${f}`,
			category: "Research",
			description: `research/${f} exists`,
			passed: !!content && content.length > 20,
			details: content ? `${content.length} chars` : "missing",
			method: "deterministic",
		});
	}

	// Critique files
	const critiqueFiles = ["critique-swe.md", "critique-security.md", "critique-perf.md", "critique-ux.md"];
	for (const f of critiqueFiles) {
		const content = tryRead(join(slugDir, "critiques", f));
		checks.push({
			id: `critique-exists:${f}`,
			category: "Critiques",
			description: `critiques/${f} exists`,
			passed: !!content && content.length > 20,
			details: content ? `${content.length} chars` : "missing",
			method: "deterministic",
		});
	}

	// ── Plan Content ──

	const meta = tryRead(join(slugDir, "meta.md")) ?? "";
	checks.push({
		id: "meta-has-phase-table",
		category: "Plan Content",
		description: "meta.md has phase tracking table",
		passed: /Phase.*Status|Status.*Phase/i.test(meta),
		details: /Phase.*Status|Status.*Phase/i.test(meta) ? "found phase table" : "no phase table found",
		method: "deterministic",
	});
	checks.push({
		id: "meta-has-slug",
		category: "Plan Content",
		description: "meta.md has slug",
		passed: /slug/i.test(meta),
		details: /slug/i.test(meta) ? "found slug" : "no slug",
		method: "deterministic",
	});
	checks.push({
		id: "meta-has-user-prompt",
		category: "Plan Content",
		description: "meta.md has user prompt",
		passed: /User Prompt|user prompt/i.test(meta),
		details: /User Prompt|user prompt/i.test(meta) ? "found user prompt" : "no user prompt",
		method: "deterministic",
	});

	const prompt = tryRead(join(slugDir, "prompt.md")) ?? "";
	checks.push({
		id: "prompt-has-timestamp",
		category: "Plan Content",
		description: "prompt.md has timestamp",
		passed: /timestamp/i.test(prompt),
		details: /timestamp/i.test(prompt) ? "found timestamp" : "no timestamp",
		method: "deterministic",
	});
	checks.push({
		id: "prompt-has-task",
		category: "Plan Content",
		description: "prompt.md references the task",
		passed: /mcp-discovery|MCP/i.test(prompt),
		details: /mcp-discovery|MCP/i.test(prompt) ? "references task" : "no task reference",
		method: "deterministic",
	});

	const initialPlan = tryRead(join(slugDir, "initial-plan.md")) ?? "";
	for (const section of ["Goal", "Architecture", "Testing"]) {
		checks.push({
			id: `plan-section:${section}`,
			category: "Plan Content",
			description: `initial-plan.md has ${section} section`,
			passed: new RegExp(section, "i").test(initialPlan),
			details: new RegExp(section, "i").test(initialPlan) ? "found" : "missing",
			method: "deterministic",
		});
	}

	const flowSpec = tryRead(join(slugDir, "user-flow-spec.md")) ?? "";
	checks.push({
		id: "flowspec-has-actors",
		category: "Plan Content",
		description: "user-flow-spec.md has actors",
		passed: /actor/i.test(flowSpec),
		details: /actor/i.test(flowSpec) ? "found actors" : "no actors",
		method: "deterministic",
	});
	checks.push({
		id: "flowspec-has-flows",
		category: "Plan Content",
		description: "user-flow-spec.md has flows",
		passed: /flow/i.test(flowSpec),
		details: /flow/i.test(flowSpec) ? "found flows" : "no flows",
		method: "deterministic",
	});
	checks.push({
		id: "flowspec-has-test-matrix",
		category: "Plan Content",
		description: "user-flow-spec.md has test matrix",
		passed: /test matrix/i.test(flowSpec),
		details: /test matrix/i.test(flowSpec) ? "found test matrix" : "no test matrix",
		method: "deterministic",
	});
	checks.push({
		id: "flowspec-has-error-flows",
		category: "Plan Content",
		description: "user-flow-spec.md has error flows",
		passed: /error flow|error case/i.test(flowSpec),
		details: /error flow|error case/i.test(flowSpec) ? "found error flows" : "no error flows",
		method: "deterministic",
	});

	// ── Critique Substance ──

	for (const f of critiqueFiles) {
		const content = tryRead(join(slugDir, "critiques", f)) ?? "";
		const severityCount = (content.match(/High|Medium|Low/gi) || []).length;
		checks.push({
			id: `critique-depth:${f}`,
			category: "Critique Substance",
			description: `${f} has 5+ severity-tagged concerns`,
			passed: severityCount >= 5,
			details: `${severityCount} severity items`,
			method: "deterministic",
		});
	}

	// ── Q&A Quality ──

	const questions = tryRead(join(slugDir, "questions.md")) ?? "";
	checks.push({
		id: "qa-has-questions",
		category: "Q&A",
		description: "questions.md has 3+ distinct questions",
		passed: (questions.match(/\*\*Q\d|Q\d:/g) || []).length >= 3,
		details: `${(questions.match(/\*\*Q\d|Q\d:/g) || []).length} questions`,
		method: "deterministic",
	});
	checks.push({
		id: "qa-has-options",
		category: "Q&A",
		description: "questions.md has options (A/B/C)",
		passed: /\(A\)|Option A|\*\*A\*\*/i.test(questions),
		details: /\(A\)|Option A|\*\*A\*\*/i.test(questions) ? "found options" : "no options",
		method: "deterministic",
	});
	checks.push({
		id: "qa-has-rationale",
		category: "Q&A",
		description: "questions.md has rationale/confidence",
		passed: /rationale|confidence|high confidence/i.test(questions),
		details: /rationale|confidence|high confidence/i.test(questions) ? "found" : "missing",
		method: "deterministic",
	});

	// ── Code ──

	for (const f of cfg.expectedSrcFiles) {
		const content = tryRead(join(dir, f));
		checks.push({
			id: `code-exists:${f}`,
			category: "Code",
			description: `${f} exists with 50+ chars`,
			passed: !!content && content.length > 50,
			details: content ? `${content.length} chars` : "missing",
			method: "deterministic",
		});
	}

	const types = tryRead(join(dir, "src/types.ts")) ?? "";
	checks.push({
		id: "code-has-interfaces",
		category: "Code Quality",
		description: "types.ts exports 3+ interfaces",
		passed: (types.match(/export interface/g) || []).length >= 3,
		details: `${(types.match(/export interface/g) || []).length} interfaces`,
		method: "deterministic",
	});

	const search = tryRead(join(dir, "src/search.ts")) ?? "";
	checks.push({
		id: "code-has-pure-functions",
		category: "Code Quality",
		description: "search.ts exports 3+ functions",
		passed: (search.match(/export function/g) || []).length >= 3,
		details: `${(search.match(/export function/g) || []).length} exported functions`,
		method: "deterministic",
	});
	checks.push({
		id: "code-search-is-pure",
		category: "Code Quality",
		description: "search.ts has no I/O imports (pure)",
		passed: !search || !/import.*fs|import.*http|import.*fetch/.test(search),
		details: /import.*fs|import.*http|import.*fetch/.test(search) ? "has I/O imports" : "pure",
		method: "deterministic",
	});

	const index = tryRead(join(dir, "src/index.ts")) ?? "";
	checks.push({
		id: "code-has-default-export",
		category: "Code Quality",
		description: "index.ts exports default function",
		passed: /export default function/i.test(index),
		details: /export default function/i.test(index) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "code-registers-tools",
		category: "Code Quality",
		description: "index.ts registers tools (registerTool)",
		passed: /registerTool|pi\.register/i.test(index),
		details: /registerTool|pi\.register/i.test(index) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "code-has-search-mcp-tools",
		category: "Code Quality",
		description: "code references search_mcp_tools or list_mcp_servers",
		passed: /search_mcp_tools|list_mcp_servers/.test(index),
		details: /search_mcp_tools|list_mcp_servers/.test(index) ? "found" : "missing",
		method: "deterministic",
	});

	const testFile = tryRead(join(dir, "src/search.test.ts")) ?? "";
	checks.push({
		id: "code-has-tests",
		category: "Code Quality",
		description: "search.test.ts has 10+ test cases",
		passed: (testFile.match(/\bit\(/g) || []).length >= 10,
		details: `${(testFile.match(/\bit\(/g) || []).length} test cases`,
		method: "deterministic",
	});
	checks.push({
		id: "code-tests-edge-cases",
		category: "Code Quality",
		description: "tests cover edge cases (empty, null, invalid)",
		passed: /empty|null|invalid|edge|boundary|case/i.test(testFile),
		details: /empty|null|invalid|edge|boundary|case/i.test(testFile) ? "found edge case tests" : "no edge case tests",
		method: "deterministic",
	});

	// ── Build ──

	if (cfg.runBuild && existsSync(join(dir, "src", "index.ts"))) {
		const buildResult = await runBuild(dir);
		checks.push({
			id: "build-tsc",
			category: "Build",
			description: "tsc --noEmit passes with 0 errors",
			passed: buildResult.tscExit === 0,
			details: buildResult.tscExit === 0 ? "0 errors" : `exit ${buildResult.tscExit}: ${buildResult.tscError.slice(0, 200)}`,
			method: "deterministic",
		});
		checks.push({
			id: "build-vitest",
			category: "Build",
			description: "vitest run passes with 0 failures",
			passed: buildResult.testExit === 0,
			details: buildResult.testExit === 0 ? "all tests pass" : `exit ${buildResult.testExit}: ${buildResult.testOutput.slice(0, 200)}`,
			method: "deterministic",
		});
	}

	// ── Review Honesty ──

	const review = tryRead(join(slugDir, "review", "test-results.md")) ?? "";
	checks.push({
		id: "review-has-meets-standards",
		category: "Review",
		description: "review has Meets Standards verdict",
		passed: /meets standards/i.test(review),
		details: /meets standards/i.test(review) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "review-has-pass-fail",
		category: "Review",
		description: "review has pass/fail counts",
		passed: /passed|failed|PASS|FAIL/i.test(review),
		details: /passed|failed|PASS|FAIL/i.test(review) ? "found" : "missing",
		method: "deterministic",
	});

	// ── Insights ──

	const insights = tryRead(join(slugDir, "insights.md")) ?? "";
	checks.push({
		id: "insights-has-research-highlights",
		category: "Insights",
		description: "insights.md has research highlights",
		passed: /research|web|highlight/i.test(insights),
		details: /research|web|highlight/i.test(insights) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "insights-has-tradeoffs",
		category: "Insights",
		description: "insights.md has trade-off decisions",
		passed: /trade.?off|decision|rationale/i.test(insights),
		details: /trade.?off|decision|rationale/i.test(insights) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "insights-has-patterns",
		category: "Insights",
		description: "insights.md has patterns discovered",
		passed: /pattern|discover/i.test(insights),
		details: /pattern|discover/i.test(insights) ? "found" : "missing",
		method: "deterministic",
	});
	checks.push({
		id: "insights-has-process-improvements",
		category: "Insights",
		description: "insights.md has process improvements",
		passed: /improvement|process|next time/i.test(insights),
		details: /improvement|process|next time/i.test(insights) ? "found" : "missing",
		method: "deterministic",
	});

	// ── LLM Judge ──

	if (cfg.llmJudge) {
		const llmChecks = await runLLMJudge(slugDir, dir, cfg.llmJudge);
		checks.push(...llmChecks);
	}

	// ── Build report ──

	const passed = checks.filter(c => c.passed).length;
	const byCategory: Record<string, { passed: number; total: number }> = {};
	for (const c of checks) {
		if (!byCategory[c.category]) byCategory[c.category] = { passed: 0, total: 0 };
		byCategory[c.category].total++;
		if (c.passed) byCategory[c.category].passed++;
	}

	return { checks, passed, total: checks.length, byCategory };
}

// ─── Build runner ───────────────────────────────────────────────────

async function runBuild(dir: string): Promise<{
	tscExit: number; tscError: string;
	testExit: number; testOutput: string;
}> {
	const installResult = spawn("npm", ["install"], { cwd: dir, stdio: "pipe" });
	await new Promise<void>(r => installResult.on("close", () => r()));

	let tscError = "";
	const tscResult = spawn("npx", ["tsc", "--noEmit"], { cwd: dir, stdio: "pipe" });
	tscResult.stderr?.on("data", (d: Buffer) => tscError += d.toString());
	tscResult.stdout?.on("data", (d: Buffer) => tscError += d.toString());
	const tscExit = await new Promise<number>(r => tscResult.on("close", r));

	let testOutput = "";
	const testResult = spawn("npx", ["vitest", "run"], { cwd: dir, stdio: "pipe" });
	testResult.stdout?.on("data", (d: Buffer) => testOutput += d.toString());
	testResult.stderr?.on("data", (d: Buffer) => testOutput += d.toString());
	const testExit = await new Promise<number>(r => testResult.on("close", r));

	return { tscExit, tscError, testExit, testOutput };
}

// ─── LLM Judge ──────────────────────────────────────────────────────

async function runLLMJudge(
	slugDir: string,
	projectDir: string,
	judgeCfg: { model?: string; timeoutMs?: number },
): Promise<Check[]> {
	const model = judgeCfg.model ?? "zai/glm-5.1";
	const timeoutMs = judgeCfg.timeoutMs ?? 120_000;

	// Gather artifacts
	const artifacts: Record<string, string> = {};
	const planArtifacts: Record<string, string> = {
		"initial-plan": "initial-plan.md",
		"user-flow-spec": "user-flow-spec.md",
		"critique-swe": "critiques/critique-swe.md",
		"questions": "questions.md",
		"insights": "insights.md",
	};
	for (const [key, path] of Object.entries(planArtifacts)) {
		const content = tryRead(join(slugDir, ...path.split("/")));
		if (content) artifacts[key] = content.slice(0, 2000);
	}
	for (const f of ["src/index.ts", "src/search.ts", "src/search.test.ts"]) {
		const content = tryRead(join(projectDir, f));
		if (content) artifacts[f] = content.slice(0, 2000);
	}

	if (Object.keys(artifacts).length === 0) {
		return [{
			id: "llm-no-artifacts",
			category: "LLM Judge",
			description: "LLM judge had artifacts to evaluate",
			passed: false,
			details: "No artifacts found",
			method: "llm",
		}];
	}

	const artifactBlock = Object.entries(artifacts)
		.map(([k, v]) => `## ${k}\n${v}`)
		.join("\n\n");

	const prompt = `You are reviewing a planning + implementation pipeline output.
For each question below, answer YES or NO with a brief reason.
Reply with ONLY a JSON object with these exact keys, each true or false:

{
  "plan_has_real_architecture": true/false,
  "plan_has_specific_files_listed": true/false,
  "plan_has_data_model": true/false,
  "critiques_reference_specific_plan_text": true/false,
  "critiques_have_actionable_fixes": true/false,
  "code_matches_plan_file_structure": true/false,
  "code_matches_plan_interfaces": true/false,
  "tests_are_meaningful_not_trivial": true/false,
  "tests_cover_error_cases": true/false,
  "overall_would_you_merge_this": true/false,
  "reasoning": "brief explanation"
}

## Artifacts:

${artifactBlock}`;

	// Call LLM
	const result = await callLLMJudge(prompt, model, timeoutMs);

	const checks: Check[] = [];
	const keys = [
		"plan_has_real_architecture",
		"plan_has_specific_files_listed",
		"plan_has_data_model",
		"critiques_reference_specific_plan_text",
		"critiques_have_actionable_fixes",
		"code_matches_plan_file_structure",
		"code_matches_plan_interfaces",
		"tests_are_meaningful_not_trivial",
		"tests_cover_error_cases",
		"overall_would_you_merge_this",
	];

	for (const key of keys) {
		const val = result[key];
		checks.push({
			id: `llm:${key}`,
			category: "LLM Judge",
			description: key.replace(/_/g, " "),
			passed: val === true,
			details: typeof val === "boolean" ? (val ? "YES" : "NO") : `no answer (${typeof val})`,
			method: "llm",
		});
	}

	if (result.reasoning) {
		checks.push({
			id: "llm:reasoning",
			category: "LLM Judge",
			description: "LLM provided reasoning",
			passed: true,
			details: result.reasoning.slice(0, 200),
			method: "llm",
		});
	}

	return checks;
}

interface LLMJudgeResult {
	[key: string]: boolean | string;
}

async function callLLMJudge(
	prompt: string,
	model: string,
	timeoutMs: number,
): Promise<LLMJudgeResult> {
	const tmpDir = join(process.cwd(), ".tmp", "llm-judge");
	const { mkdirSync, writeFileSync } = require("node:fs");
	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "judge", private: true }));

	return new Promise<LLMJudgeResult>((resolve) => {
		const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--model", model], {
			cwd: tmpDir, stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		proc.stdout!.on("data", (d: Buffer) => { buffer += d.toString(); });
		proc.stdin!.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");

		const timeout = setTimeout(() => {
			proc.kill();
			resolve({});
		}, timeoutMs);

		const check = setInterval(() => {
			if (buffer.includes('"type":"agent_end"') || buffer.includes('"type": "agent_end"')) {
				clearInterval(check);
				clearTimeout(timeout);

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
				const jsonMatches = [...text.matchAll(/\{[\s\S]*?\}/g)];
				let bestMatch: any = null;
				let bestKeys = 0;
				for (const m of jsonMatches) {
					try {
						const parsed = JSON.parse(m[0]);
						const boolKeys = Object.values(parsed).filter(v => typeof v === "boolean").length;
						if (boolKeys > bestKeys) {
							bestKeys = boolKeys;
							bestMatch = parsed;
						}
					} catch { /* not valid json */ }
				}

				proc.kill();
				resolve(bestMatch ?? {});
			}
		}, 500);
	});
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

// ─── Formatting ─────────────────────────────────────────────────────

export function formatReport(report: PipelineReport): string {
	const lines: string[] = [];
	lines.push(`\n╔══════════════════════════════════════════════════════════════╗`);
	lines.push(`║  CHECKLIST: ${report.passed}/${report.total} passed`.padEnd(62) + `║`);
	lines.push(`╠══════════════════════════════════════════════════════════════╣`);

	let lastCategory = "";
	for (const c of report.checks) {
		if (c.category !== lastCategory) {
			lines.push(`║                                                              ║`);
			lines.push(`║  ── ${c.category} ${"─".repeat(56 - c.category.length)}`.slice(0, 62) + `║`);
			lastCategory = c.category;
		}
		const icon = c.passed ? "✓" : "✗";
		const text = `${icon} ${c.description}`.slice(0, 48);
		const detail = c.details.slice(0, 12);
		lines.push(`║  ${text.padEnd(49)}${detail.padEnd(13)}║`);
	}

	lines.push(`╠══════════════════════════════════════════════════════════════╣`);
	lines.push(`║  BY CATEGORY:`.padEnd(62) + `║`);
	for (const [cat, { passed, total }] of Object.entries(report.byCategory)) {
		const line = `  ${cat}: ${passed}/${total}`;
		lines.push(`║  ${line}`.padEnd(62) + `║`);
	}
	lines.push(`╚══════════════════════════════════════════════════════════════╝`);
	return lines.join("\n");
}
