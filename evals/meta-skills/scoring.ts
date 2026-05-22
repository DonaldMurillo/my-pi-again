/**
 * Pipeline Eval Checklist
 *
 * Hard checks that catch real quality gaps, not just file existence.
 * Designed to fail on mediocre output so we can iterate.
 *
 * Both deterministic (regex, structure) and non-deterministic (LLM judge).
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

	const D = (id: string, category: string, desc: string, passed: boolean, details: string): Check => ({
		id, category, description: desc, passed, details, method: "deterministic" as const,
	});

	// ════════════════════════════════════════════
	// PLAN ARTIFACTS — does each file exist?
	// ════════════════════════════════════════════

	const planFiles: Record<string, string> = {
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
		const c = tryRead(join(slugDir, ...path.split("/")));
		checks.push(D(`plan-exists:${label}`, "Plan Artifacts", `${label} exists`, !!c && c.length > 20, c ? `${c.length} chars` : "missing"));
	}

	// Research files
	const researchFiles = [
		"locate-codebase.md", "locate-docs.md", "locate-git-history.md",
		"locate-patterns.md", "research-architecture.md", "research-domain.md",
		"research-patterns.md", "research-web.md",
	];
	for (const f of researchFiles) {
		const c = tryRead(join(slugDir, "research", f));
		checks.push(D(`research-exists:${f}`, "Research", `research/${f} exists`, !!c && c.length > 20, c ? `${c.length} chars` : "missing"));
	}

	// Critique files
	const critiqueFiles = ["critique-swe.md", "critique-security.md", "critique-perf.md", "critique-ux.md"];
	for (const f of critiqueFiles) {
		const c = tryRead(join(slugDir, "critiques", f));
		checks.push(D(`critique-exists:${f}`, "Critiques", `critiques/${f} exists`, !!c && c.length > 20, c ? `${c.length} chars` : "missing"));
	}

	// ════════════════════════════════════════════
	// META — is it the right format?
	// ════════════════════════════════════════════

	const meta = tryRead(join(slugDir, "meta.md")) ?? "";
	checks.push(D("meta-has-phase-table", "Meta", "meta.md has phase tracking table", /Phase.*Status|Status.*Phase/i.test(meta), /Phase/i.test(meta) ? "found" : "no phase table"));
	checks.push(D("meta-has-slug", "Meta", "meta.md has slug field", /slug/i.test(meta), /slug/i.test(meta) ? "found" : "missing"));
	checks.push(D("meta-has-task-description", "Meta", "meta.md quotes the original task", /mcp-discovery|MCP server/i.test(meta), /mcp-discovery|MCP server/i.test(meta) ? "found task" : "no task text"));
	checks.push(D("meta-has-dates", "Meta", "meta.md has dates in phase table", /202[0-9]/.test(meta), /202[0-9]/.test(meta) ? "found dates" : "no dates"));
	checks.push(D("meta-all-phases-complete", "Meta", "meta.md marks all phases completed", (() => {
		if (!meta) return false;
		const completes = (meta.match(/complete|✅|completed|done|pass/gi) || []).length;
		const pendings = (meta.match(/\bpending\b|\bin.progress\b|\bin_progress\b|\bblocked\b/gi) || []).length;
		return completes >= 5 && pendings === 0;
	})(), (() => {
		const completes = (meta.match(/complete|✅|completed|done|pass/gi) || []).length;
		const pendings = (meta.match(/\bpending\b|\bin.progress\b|\bin_progress\b|\bblocked\b/gi) || []).length;
		return `${completes} completed, ${pendings} pending`;
	})()));

	// ════════════════════════════════════════════
	// PROMPT — verbatim task preserved?
	// ════════════════════════════════════════════

	const promptFile = tryRead(join(slugDir, "prompt.md")) ?? "";
	checks.push(D("prompt-has-timestamp", "Prompt", "prompt.md has timestamp", /timestamp|date|created/i.test(promptFile), /timestamp|date|created/i.test(promptFile) ? "found" : "missing"));
	checks.push(D("prompt-has-verbatim-task", "Prompt", "prompt.md contains verbatim task text", /mcp-servers\.json/.test(promptFile), /mcp-servers\.json/.test(promptFile) ? "found exact text" : "missing"));
	checks.push(D("prompt-not-empty", "Prompt", "prompt.md is 100+ chars", promptFile.length >= 100, `${promptFile.length} chars`));

	// ════════════════════════════════════════════
	// INITIAL PLAN — substance checks
	// ════════════════════════════════════════════

	const plan = tryRead(join(slugDir, "initial-plan.md")) ?? "";
	checks.push(D("plan-has-goal", "Plan Substance", "initial-plan has Goal section", /^#{1,4}\s+.*Goal/mi.test(plan), /^#{1,4}\s+.*Goal/mi.test(plan) ? "found" : "missing"));
	checks.push(D("plan-has-architecture", "Plan Substance", "initial-plan has Architecture section", /^#{1,4}\s+.*Architecture/mi.test(plan), /^#{1,4}\s+.*Architecture/mi.test(plan) ? "found" : "missing"));
	checks.push(D("plan-has-testing-strategy", "Plan Substance", "initial-plan has Testing Strategy section", /testing strategy/i.test(plan), /testing strategy/i.test(plan) ? "found" : "missing"));
	checks.push(D("plan-has-data-model", "Plan Substance", "initial-plan has data model with types/interfaces", /interface|type.*=|data model|TypeScript types/i.test(plan), /interface|type.*=|data model|TypeScript types/i.test(plan) ? "found" : "missing"));
	checks.push(D("plan-has-specific-files", "Plan Substance", "initial-plan lists specific file paths (src/...)", /src\/[a-z_-]+\.(ts|tsx)/i.test(plan), /src\/[a-z_-]+\.(ts|tsx)/i.test(plan) ? "found file paths" : "no specific file paths"));
	checks.push(D("plan-has-open-questions", "Plan Substance", "initial-plan has open questions", /open question|question/i.test(plan), /open question|question/i.test(plan) ? "found" : "missing"));
	checks.push(D("plan-has-key-decisions", "Plan Substance", "initial-plan has key decisions table", /decision|choice|approach/i.test(plan), /decision|choice|approach/i.test(plan) ? "found" : "missing"));
	checks.push(D("plan-is-substantial", "Plan Substance", "initial-plan is 1500+ chars", plan.length >= 1500, `${plan.length} chars`));

	// ════════════════════════════════════════════
	// USER FLOW SPEC — completeness
	// ════════════════════════════════════════════

	const flowSpec = tryRead(join(slugDir, "user-flow-spec.md")) ?? "";
	checks.push(D("flowspec-has-actors", "Flow Spec", "user-flow-spec defines actors", /actor/i.test(flowSpec), /actor/i.test(flowSpec) ? "found" : "missing"));
	checks.push(D("flowspec-has-happy-path", "Flow Spec", "user-flow-spec has happy path flows", /happy path|flow 1|flow.*1/i.test(flowSpec), /happy path|flow 1|flow.*1/i.test(flowSpec) ? "found" : "missing"));
	checks.push(D("flowspec-has-error-flows", "Flow Spec", "user-flow-spec has error flows", /error flow|error case|error.*flow/i.test(flowSpec), /error flow|error case|error.*flow/i.test(flowSpec) ? "found" : "missing"));
	checks.push(D("flowspec-has-test-matrix", "Flow Spec", "user-flow-spec has test matrix", /test matrix/i.test(flowSpec), /test matrix/i.test(flowSpec) ? "found" : "missing"));
	checks.push(D("flowspec-has-edge-cases", "Flow Spec", "user-flow-spec lists edge cases", /edge case|boundary|edge/i.test(flowSpec), /edge case|boundary|edge/i.test(flowSpec) ? "found" : "missing"));
	checks.push(D("flowspec-is-substantial", "Flow Spec", "user-flow-spec is 1000+ chars", flowSpec.length >= 1000, `${flowSpec.length} chars`));

	// ════════════════════════════════════════════
	// DEEPENED PLAN — is it actually deeper?
	// ════════════════════════════════════════════

	const deepPlan = tryRead(join(slugDir, "deepened-plan.md")) ?? "";
	checks.push(D("deep-has-function-signatures", "Deepened Plan", "deepened-plan has function signatures", /function\s+\w+\s*\(|=>\s*{|export function/i.test(deepPlan), /function\s+\w+\s*\(/i.test(deepPlan) ? "found signatures" : "no function signatures"));
	checks.push(D("deep-has-error-handling", "Deepened Plan", "deepened-plan covers error handling", /error handling|error.*case|try.*catch|throw/i.test(deepPlan), /error handling|error.*case|try.*catch|throw/i.test(deepPlan) ? "found" : "missing"));
	checks.push(D("deep-has-implementation-order", "Deepened Plan", "deepened-plan has implementation order", /implementation order|order.*implement|build order/i.test(deepPlan), /implementation order|order.*implement|build order/i.test(deepPlan) ? "found" : "missing"));
	checks.push(D("deep-different-from-initial", "Deepened Plan", "deepened-plan is not a copy of initial-plan", deepPlan !== plan && deepPlan.length > 100, deepPlan === plan ? "identical to initial-plan!" : `${deepPlan.length} chars, different content`));

	// ════════════════════════════════════════════
	// CRITIQUES — are they real or generic?
	// ════════════════════════════════════════════

	for (const f of critiqueFiles) {
		const c = tryRead(join(slugDir, "critiques", f)) ?? "";
		const severityCount = (c.match(/High|Medium|Low/gi) || []).length;
		checks.push(D(`critique-depth:${f}`, "Critique Depth", `${f} has 5+ severity-tagged concerns`, severityCount >= 5, `${severityCount} severity items`));
	}

	// Check if any critique quotes specific plan text
	for (const f of critiqueFiles) {
		const c = tryRead(join(slugDir, "critiques", f)) ?? "";
		const quotesSpecific = /deepened-plan|initial-plan|the plan|section|specifically|line \d+|function \w+|config\.ts|search\.ts|index\.ts/i.test(c);
		checks.push(D(`critique-specific:${f}`, "Critique Specificity", `${f} references specific plan text`, quotesSpecific, quotesSpecific ? "found specific refs" : "generic advice only"));
	}

	// At least one critique has a "Missing from plan" section
	const anyMissingFromPlan = critiqueFiles.some(f => {
		const c = tryRead(join(slugDir, "critiques", f)) ?? "";
		return /missing from plan|not addressed|not covered|gap|omitted|overlooked/i.test(c);
	});
	checks.push(D("critique-has-missing-section", "Critique Depth", "at least one critique has 'Missing from plan' section", anyMissingFromPlan, anyMissingFromPlan ? "found" : "no critique identifies gaps"));

	// ════════════════════════════════════════════
	// Q&A — are questions real trade-offs?
	// ════════════════════════════════════════════

	const questions = tryRead(join(slugDir, "questions.md")) ?? "";
	checks.push(D("qa-has-3-plus-questions", "Q&A", "questions.md has 3+ distinct questions", (questions.match(/\*\*Q\d|Q\d:/g) || []).length >= 3, `${(questions.match(/\*\*Q\d|Q\d:/g) || []).length} questions`));
	checks.push(D("qa-has-options", "Q&A", "questions have options A/B", /\(A\)|Option A|\*\*A\*\*/i.test(questions), /\(A\)|Option A/i.test(questions) ? "found" : "missing"));
	checks.push(D("qa-has-decisions", "Q&A", "questions have decisions (AUTO-RESOLVED, SELECTED, ACCEPTED)", /AUTO-RESOLVED|SELECTED|ACCEPTED|REJECTED|CHOSEN|Decision:/i.test(questions), /AUTO-RESOLVED|SELECTED|ACCEPTED|REJECTED|Decision:/i.test(questions) ? "found" : "missing"));
	checks.push(D("qa-has-source-references", "Q&A", "questions cite their source (which critique raised them)", /Source:|source:/i.test(questions), /Source:|source:/i.test(questions) ? "found" : "missing"));
	checks.push(D("qa-has-confidence", "Q&A", "at least one resolution has confidence level", /confidence/i.test(questions), /confidence/i.test(questions) ? "found" : "missing"));

	// ════════════════════════════════════════════
	// FINAL PLAN — does it incorporate critiques?
	// ════════════════════════════════════════════

	const finalPlan = tryRead(join(slugDir, "final-plan.md")) ?? "";
	checks.push(D("final-has-qa-resolutions", "Final Plan", "final-plan references Q&A resolutions", /Q&A|resolution|auto-resolve|decision/i.test(finalPlan), /Q&A|resolution|auto-resolve|decision/i.test(finalPlan) ? "found" : "missing"));
	checks.push(D("final-has-architecture", "Final Plan", "final-plan has architecture section", /architecture|system design/i.test(finalPlan), /architecture|system design/i.test(finalPlan) ? "found" : "missing"));
	checks.push(D("final-has-file-list", "Final Plan", "final-plan lists new/modified files", /new file|modified file|files.*create|create.*file/i.test(finalPlan), /new file|modified file|files.*create|create.*file/i.test(finalPlan) ? "found" : "missing"));
	checks.push(D("final-has-implementation-order", "Final Plan", "final-plan has implementation order", /implementation order|order|step 1|phase 1/i.test(finalPlan), /implementation order|order|step 1|phase 1/i.test(finalPlan) ? "found" : "missing"));
	checks.push(D("final-different-from-initial", "Final Plan", "final-plan differs from initial-plan", finalPlan !== plan && finalPlan.length > 100, finalPlan === plan ? "identical!" : `${finalPlan.length} chars, different`));

	// ════════════════════════════════════════════
	// EXECUTION — task breakdown & log
	// ════════════════════════════════════════════

	const taskBreakdown = tryRead(join(slugDir, "execution", "task-breakdown.md")) ?? "";
	checks.push(D("exec-has-dependency-graph", "Execution", "task-breakdown has dependency graph or batch structure", /batch|dependency|depends on|→|graph|parallel|sequential/i.test(taskBreakdown), /batch|dependency|depends on/i.test(taskBreakdown) ? "found" : "missing"));
	checks.push(D("exec-has-task-details", "Execution", "task-breakdown has file assignments per task", /file|src\/|\.ts/i.test(taskBreakdown), /file|src\/|\.ts/i.test(taskBreakdown) ? "found" : "missing"));

	const taskLog = tryRead(join(slugDir, "execution", "task-log.md")) ?? "";
	checks.push(D("exec-log-has-table", "Execution", "task-log has status table", /\|.*status|\|.*done|\|.*pass/i.test(taskLog), /\|.*status|\|.*done/i.test(taskLog) ? "found table" : "no table"));
	checks.push(D("exec-log-has-real-status", "Execution", "task-log shows pass/fail lint results", /pass|fail/i.test(taskLog), /pass|fail/i.test(taskLog) ? "found" : "missing"));
	checks.push(D("exec-log-has-verification", "Execution", "task-log has verification section (tsc/vitest output)", /tsc|vitest|verification|typecheck/i.test(taskLog), /tsc|vitest|verification|typecheck/i.test(taskLog) ? "found" : "missing"));

	// ════════════════════════════════════════════
	// CODE — existence + quality
	// ════════════════════════════════════════════

	for (const f of cfg.expectedSrcFiles) {
		const c = tryRead(join(dir, f));
		checks.push(D(`code-exists:${f}`, "Code Existence", `${f} exists with 50+ chars`, !!c && c.length > 50, c ? `${c.length} chars` : "missing"));
	}

	const types = tryRead(join(dir, "src/types.ts")) ?? "";
	checks.push(D("code-types-interfaces", "Code Quality", "types.ts exports 3+ interfaces", (types.match(/export interface/g) || []).length >= 3, `${(types.match(/export interface/g) || []).length} interfaces`));
	checks.push(D("code-types-mcp-config", "Code Quality", "types.ts defines MCPServerConfig", /MCPServerConfig|MCP.*Config/i.test(types), /MCPServerConfig|MCP.*Config/i.test(types) ? "found" : "missing"));
	checks.push(D("code-types-mcp-tool", "Code Quality", "types.ts defines MCPTool or Tool type", /MCPTool|Tool\s*\{/i.test(types), /MCPTool|Tool\s*\{/i.test(types) ? "found" : "missing"));

	const search = tryRead(join(dir, "src/search.ts")) ?? "";
	checks.push(D("code-search-pure-functions", "Code Quality", "search.ts exports 3+ functions", (search.match(/export function/g) || []).length >= 3, `${(search.match(/export function/g) || []).length} functions`));
	checks.push(D("code-search-no-io", "Code Quality", "search.ts has no fs/http/fetch imports", !search || !/import.*\bfs\b|import.*http|import.*fetch/.test(search), /import.*\bfs\b|import.*http|import.*fetch/.test(search) ? "has I/O" : "pure"));
	checks.push(D("code-search-has-scoring", "Code Quality", "search.ts implements relevance scoring", /score|rank|relevance|weight/i.test(search), /score|rank|relevance|weight/i.test(search) ? "found" : "missing"));

	const index = tryRead(join(dir, "src/index.ts")) ?? "";
	checks.push(D("code-index-default-export", "Code Quality", "index.ts exports default function", /export default function/i.test(index), /export default function/i.test(index) ? "found" : "missing"));
	checks.push(D("code-index-register-tool", "Code Quality", "index.ts registers search_mcp_tools tool", /search_mcp_tools/.test(index), /search_mcp_tools/.test(index) ? "found" : "missing"));
	checks.push(D("code-index-register-list", "Code Quality", "index.ts registers list_mcp_servers tool", /list_mcp_servers/.test(index), /list_mcp_servers/.test(index) ? "found" : "missing"));
	checks.push(D("code-index-has-command", "Code Quality", "index.ts registers /mcp command", /registerCommand.*mcp|command.*mcp/i.test(index), /registerCommand.*mcp|command.*mcp/i.test(index) ? "found" : "missing"));
	checks.push(D("code-no-any-types", "Code Quality", "no `any` types in index.ts", !/: any\b/.test(index), /: any\b/.test(index) ? "found any types" : "clean"));

	const testFile = tryRead(join(dir, "src/search.test.ts")) ?? "";
	checks.push(D("code-test-count", "Test Quality", "search.test.ts has 10+ test cases", (testFile.match(/\bit\(/g) || []).length >= 10, `${(testFile.match(/\bit\(/g) || []).length} test cases`));
	checks.push(D("code-test-describe-blocks", "Test Quality", "tests have describe blocks grouping by function", (testFile.match(/describe\(/g) || []).length >= 3, `${(testFile.match(/describe\(/g) || []).length} describe blocks`));
	checks.push(D("code-test-edge-cases", "Test Quality", "tests cover edge cases (empty, null, special chars)", /empty|null|undefined|special char|boundary/i.test(testFile), /empty|null|undefined|special char|boundary/i.test(testFile) ? "found" : "missing"));
	checks.push(D("code-test-scoring", "Test Quality", "tests verify scoring/relevance ordering", /score|rank|relevance|ordering|sorted|descending/i.test(testFile), /score|rank|relevance|ordering|sorted|descending/i.test(testFile) ? "found" : "missing"));
	checks.push(D("code-test-multi-word", "Test Quality", "tests cover multi-word queries", /multi.?word|two word|multiple word|split.*query/i.test(testFile), /multi.?word|two word|multiple word/i.test(testFile) ? "found" : "missing"));

	// ════════════════════════════════════════════
	// BUILD — compile + test
	// ════════════════════════════════════════════

	if (cfg.runBuild && existsSync(join(dir, "src", "index.ts"))) {
		const build = await runBuild(dir);
		checks.push(D("build-tsc", "Build", "tsc --noEmit passes", build.tscExit === 0, build.tscExit === 0 ? "0 errors" : `exit ${build.tscExit}`));
		checks.push(D("build-vitest", "Build", "vitest run passes", build.testExit === 0, build.testExit === 0 ? "all pass" : `exit ${build.testExit}`));
	}

	// ════════════════════════════════════════════
	// REVIEW — multi-round review cycle?
	// ════════════════════════════════════════════

	// Check for round directories (the real deep-review structure)
	const reviewDir = join(slugDir, "review");
	const roundDirs = existsSync(reviewDir)
		? readdirSync(reviewDir, { withFileTypes: true })
			.filter(d => d.isDirectory() && d.name.startsWith("round-"))
			.map(d => d.name)
		: [];

	checks.push(D("review-has-3-plus-rounds", "Review Rounds", "review has 3+ round directories (round-1, round-2, round-3)", roundDirs.length >= 3, `${roundDirs.length} round dirs: ${roundDirs.join(", ") || "none"}`));

	// Each round should have reviewer files
	const reviewerNames = ["quality", "security", "completeness", "test-runner"];
	for (const round of roundDirs) {
		for (const reviewer of reviewerNames) {
			const c = tryRead(join(reviewDir, round, `${reviewer}.md`));
			checks.push(D(`review-round-file:${round}/${reviewer}`, "Review Rounds", `${round}/${reviewer}.md exists with content`, !!c && c.length > 50, c ? `${c.length} chars` : "missing"));
		}
	}

	// Check for summary
	const summaryFile = tryRead(join(reviewDir, "summary.md")) ?? "";
	checks.push(D("review-has-summary", "Review Rounds", "review/summary.md exists", summaryFile.length > 50, `${summaryFile.length} chars`));
	checks.push(D("summary-has-round-count", "Review Rounds", "summary lists round count", /\d+\s*round/i.test(summaryFile), /\d+\s*round/i.test(summaryFile) ? "found" : "missing"));
	checks.push(D("summary-has-findings-count", "Review Rounds", "summary lists total findings", /finding|issue/i.test(summaryFile), /finding|issue/i.test(summaryFile) ? "found" : "missing"));
	checks.push(D("summary-has-verdict", "Review Rounds", "summary has PASS/NEEDS FIXES verdict", /PASS|NEEDS FIXES|Meets Standards/i.test(summaryFile), /PASS|NEEDS FIXES|Meets Standards/i.test(summaryFile) ? "found" : "missing"));

	// Still check test-results.md for backward compat
	const review = tryRead(join(reviewDir, "test-results.md")) ?? "";
	checks.push(D("review-has-test-results", "Review Output", "review/test-results.md exists with tsc+vitest output", review.length > 50, `${review.length} chars`));
	checks.push(D("review-test-results-has-runs", "Review Output", "test-results shows tests were actually run", /RC:0|exit code.*0|passed|failed/i.test(review), /RC:0|exit code.*0|passed|failed/i.test(review) ? "found" : "missing"));

	// At least one round must show findings + fixes
	const anyRoundHasFixes = roundDirs.some(round => {
		for (const reviewer of reviewerNames) {
			const c = tryRead(join(reviewDir, round, `${reviewer}.md`)) ?? "";
			if (/fix|issue|concern|finding|suggestion/i.test(c)) return true;
		}
		return false;
	});
	checks.push(D("review-rounds-have-findings", "Review Rounds", "at least one reviewer found real issues", anyRoundHasFixes, anyRoundHasFixes ? "found issues" : "no issues found — suspicious"));

	// ════════════════════════════════════════════
	// INSIGHTS — real learnings?
	// ════════════════════════════════════════════

	const insights = tryRead(join(slugDir, "insights.md")) ?? "";
	checks.push(D("insights-research-highlights", "Insights", "insights has research highlights", /research|web|highlight/i.test(insights), /research|web|highlight/i.test(insights) ? "found" : "missing"));
	checks.push(D("insights-tradeoffs", "Insights", "insights has trade-off decisions", /trade.?off|decision|rationale/i.test(insights), /trade.?off|decision|rationale/i.test(insights) ? "found" : "missing"));
	checks.push(D("insights-patterns", "Insights", "insights has patterns discovered", /pattern|discover/i.test(insights), /pattern|discover/i.test(insights) ? "found" : "missing"));
	checks.push(D("insights-improvements", "Insights", "insights has process improvements", /improvement|process|next time|better/i.test(insights), /improvement|process|next time|better/i.test(insights) ? "found" : "missing"));
	checks.push(D("insights-is-substantial", "Insights", "insights is 1000+ chars", insights.length >= 1000, `${insights.length} chars`));

	// ════════════════════════════════════════════
	// COMPLETION — commit plan + doc manifest
	// ════════════════════════════════════════════

	const commitPlan = tryRead(join(slugDir, "complete", "commit-plan.md")) ?? "";
	checks.push(D("commit-plan-exists", "Completion", "commit-plan.md exists", commitPlan.length > 20, `${commitPlan.length} chars`));
	checks.push(D("commit-plan-has-messages", "Completion", "commit-plan has commit messages", /commit|message/i.test(commitPlan), /commit|message/i.test(commitPlan) ? "found" : "missing"));
	checks.push(D("commit-plan-has-files", "Completion", "commit-plan lists files per commit", /\.ts|\.tsx|\.json/i.test(commitPlan), /\.ts|\.tsx|\.json/i.test(commitPlan) ? "found" : "missing"));

	const docManifest = tryRead(join(slugDir, "complete", "doc-manifest.md")) ?? "";
	checks.push(D("doc-manifest-exists", "Completion", "doc-manifest.md exists", docManifest.length > 20, `${docManifest.length} chars`));
	checks.push(D("doc-manifest-has-changes", "Completion", "doc-manifest lists changed files", /file|update|create|change/i.test(docManifest), /file|update|create|change/i.test(docManifest) ? "found" : "missing"));

	// ════════════════════════════════════════════
	// LLM JUDGE — non-deterministic quality eval
	// ════════════════════════════════════════════

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
		return [{ id: "llm-no-artifacts", category: "LLM Judge", description: "LLM judge had artifacts to evaluate", passed: false, details: "No artifacts found", method: "llm" }];
	}

	const artifactBlock = Object.entries(artifacts).map(([k, v]) => `## ${k}\n${v}`).join("\n\n");

	const prompt = `You are a senior engineering manager reviewing a planning + implementation pipeline output.
For each question, answer YES or NO. Reply with ONLY a JSON object with these exact boolean keys:

{
  "plan_has_real_architecture": true/false,
  "plan_has_specific_files_listed": true/false,
  "plan_has_data_model_with_types": true/false,
  "plan_has_concrete_testing_strategy": true/false,
  "critiques_reference_specific_plan_text": true/false,
  "critiques_have_actionable_fixes": true/false,
  "critiques_caught_real_issues": true/false,
  "code_matches_plan_file_structure": true/false,
  "code_matches_plan_interfaces": true/false,
  "tests_are_meaningful_not_trivial": true/false,
  "tests_cover_error_cases": true/false,
  "tests_verify_scoring_behavior": true/false,
  "insights_have_specific_findings": true/false,
  "overall_would_you_merge_this": true/false,
  "reasoning": "brief explanation"
}

## Artifacts:

${artifactBlock}`;

	const result = await callLLMJudge(prompt, model, timeoutMs);
	const checks: Check[] = [];

	const keys = [
		"plan_has_real_architecture",
		"plan_has_specific_files_listed",
		"plan_has_data_model_with_types",
		"plan_has_concrete_testing_strategy",
		"critiques_reference_specific_plan_text",
		"critiques_have_actionable_fixes",
		"critiques_caught_real_issues",
		"code_matches_plan_file_structure",
		"code_matches_plan_interfaces",
		"tests_are_meaningful_not_trivial",
		"tests_cover_error_cases",
		"tests_verify_scoring_behavior",
		"insights_have_specific_findings",
		"overall_would_you_merge_this",
	];

	for (const key of keys) {
		const val = result[key];
		checks.push({
			id: `llm:${key}`,
			category: "LLM Judge",
			description: key.replace(/_/g, " "),
			passed: val === true,
			details: typeof val === "boolean" ? (val ? "YES" : "NO") : `no answer`,
			method: "llm",
		});
	}

	if (result.reasoning) {
		checks.push({ id: "llm:reasoning", category: "LLM Judge", description: "LLM provided reasoning", passed: true, details: (result.reasoning as string).slice(0, 200), method: "llm" });
	}

	return checks;
}

interface LLMJudgeResult { [key: string]: boolean | string; }

async function callLLMJudge(prompt: string, model: string, timeoutMs: number): Promise<LLMJudgeResult> {
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

		const timeout = setTimeout(() => { proc.kill(); resolve({}); }, timeoutMs);

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
									if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
								}
							}
						}
					} catch {}
				}

				const text = parts.join("");
				const jsonMatches = [...text.matchAll(/\{[\s\S]*?\}/g)];
				let bestMatch: any = null;
				let bestKeys = 0;
				for (const m of jsonMatches) {
					try {
						const parsed = JSON.parse(m[0]);
						const boolKeys = Object.values(parsed).filter(v => typeof v === "boolean").length;
						if (boolKeys > bestKeys) { bestKeys = boolKeys; bestMatch = parsed; }
					} catch {}
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
	} catch { return null; }
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatReport(report: PipelineReport): string {
	const lines: string[] = [];
	const w = 66;
	const bar = "═".repeat(w);
	lines.push(`\n╔${bar}╗`);
	lines.push(`║  CHECKLIST: ${report.passed}/${report.total} passed`.padEnd(w) + "║");
	lines.push(`╠${bar}╣`);

	let lastCat = "";
	for (const c of report.checks) {
		if (c.category !== lastCat) {
			lines.push(`║${" ".repeat(w)}║`);
			lines.push(`║  ── ${c.category}`.padEnd(w) + "║");
			lastCat = c.category;
		}
		const icon = c.passed ? "✓" : "✗";
		const desc = `${icon} ${c.description}`.slice(0, 46);
		const detail = c.details.slice(0, 16);
		lines.push(`║  ${desc.padEnd(47)}${detail.padEnd(17).slice(0, 17)}║`);
	}

	lines.push(`╠${bar}╣`);
	lines.push(`║  BY CATEGORY:`.padEnd(w) + "║");
	for (const [cat, { passed, total }] of Object.entries(report.byCategory)) {
		lines.push(`║    ${cat}: ${passed}/${total}`.padEnd(w) + "║");
	}
	lines.push(`╚${bar}╝`);
	return lines.join("\n");
}
