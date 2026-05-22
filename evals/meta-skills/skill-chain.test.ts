/**
 * Meta-Skills E2E Eval
 *
 * Tests that the skill-chain extension correctly resolves skill import chains
 * and that GLM-5.1 can follow the composed deep-* skill instructions to
 * produce the full pipeline artifact tree (matching metacollector's output).
 *
 * The eval task: "Implement an MCP server discovery extension for pi"
 *
 * Expected artifact tree (from metacollector reference):
 *   docs/plans/{slug}/
 *   ├── invariants.md
 *   ├── meta.md
 *   ├── prompt.md
 *   ├── research/ (8 files)
 *   ├── initial-plan.md
 *   ├── user-flow-spec.md
 *   ├── deepened-plan.md
 *   ├── critiques/ (4 files)
 *   ├── questions.md
 *   ├── final-plan.md
 *   ├── execution/ (2 files)
 *   └── src/ (implementation files that compile + pass tests)
 *
 * Run: npx vitest run evals/meta-skills/skill-chain.test.ts
 */

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import {
	existsSync, readFileSync, writeFileSync,
	mkdirSync, rmSync, readdirSync,
} from "node:fs";
import { buildSkillMap, resolveChain, resolveAll } from "../../extensions/skill-chain/resolver";
import { scorePipeline, formatScore, type ScoreConfig } from "./scoring";

// ─── RPC client ─────────────────────────────────────────────────────

interface JsonLine { [key: string]: unknown; type: string; }

class RpcClient {
	private proc: ChildProcess;
	private buffer = "";
	private pending: Array<{ resolve: (line: JsonLine) => void; predicate: (line: JsonLine) => boolean }> = [];
	private lines: JsonLine[] = [];

	constructor(cwd: string, model?: string) {
		const args = ["--mode", "rpc", "--no-session"];
		if (model) args.push("--model", model);
		this.proc = spawn("pi", args, {
			cwd, stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout!.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			this.drain();
		});
	}

	private drain() {
		while (true) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				this.lines.push(obj);
				for (let i = this.pending.length - 1; i >= 0; i--) {
					if (this.pending[i].predicate(obj)) {
						this.pending[i].resolve(obj);
						this.pending.splice(i, 1);
					}
				}
			} catch { /* ignore */ }
		}
	}

	async prompt(message: string, timeoutMs = 3_600_000): Promise<JsonLine[]> {
		this.proc.stdin!.write(JSON.stringify({ type: "prompt", message }) + "\n");
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			const endIdx = this.lines.findIndex((l) => l.type === "agent_end");
			if (endIdx >= 0) return this.lines.splice(0, endIdx + 1);
			await new Promise((r) => setTimeout(r, 200));
		}
		return this.lines.splice(0);
	}

	getTextResponse(events: JsonLine[]): string {
		const parts: string[] = [];
		for (const e of events) {
			if (e.type === "message_update") {
				const msg = (e as any).message;
				if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
					for (const block of msg.content) {
						if (block.type === "text" && typeof block.text === "string") {
							parts.push(block.text);
						}
					}
				}
			}
		}
		return parts.join(" ");
	}

	kill() { this.proc.kill(); }
}

// ─── Test fixtures ──────────────────────────────────────────────────

const SKILLS_DIR = resolve(__dirname, "skills");
const SLUG = "mcp-discovery";

function freshProject(suffix: string): string {
	const dir = join(process.cwd(), ".tmp", `mcp-eval-${suffix}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });

	// Minimal pi project with skill-chain configured
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "mcp-discovery-eval",
		version: "1.0.0",
		private: true,
		devDependencies: {
			typescript: "^5.0.0",
			vitest: "^4.0.0",
			"@types/node": "^22.0.0",
		},
	}, null, 2));

	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
		compilerOptions: {
			target: "ES2022",
			module: "ES2022",
			moduleResolution: "bundler",
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			outDir: "dist",
			rootDir: "src",
		},
		include: ["src"],
	}, null, 2));

	// Configure skill-chain extension with deep-* skills
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "skill-chain.json"), JSON.stringify({
		skillDirs: [SKILLS_DIR],
		autoResolve: ["deep-auto"],
	}, null, 2));

	// vitest config for the eval project
	writeFileSync(join(dir, "vitest.config.ts"), `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'tests/**/*.test.ts'] },
});
`);

	// Create src directory for the extension output
	mkdirSync(join(dir, "src"), { recursive: true });

	return dir;
}

/**
 * Build a pipeline directive for testing. This directive tells GLM to follow
 * the deep-* skills EXACTLY, producing the same artifact tree that metacollector
 * produces (28+ files across 9 phases).
 */
function buildTestPipelineDirective(skillDirs: string[]): string {
	const skillsRoot = skillDirs[0] || "skills";

	return `# Deep Pipeline Directive

You are running a fully autonomous deep-* pipeline. Execute it NOW.

## CRITICAL: Follow skills EXACTLY

Each skill file contains precise instructions for what files to create, what
content they must contain, and what directory structure to use. Read each skill
carefully and follow its instructions word-for-word. Do NOT improvise or skip
steps.

## Pipeline Phases

Execute these phases IN ORDER. For each phase, read the skill file, then follow
its instructions to create ALL required files on disk.

| # | Phase | Skill File | What It Produces |
|---|-------|------------|------------------|
| 1 | Plan | ${skillsRoot}/deep-plan/SKILL.md | Research (8 files), Initial Plan, Flow Spec, Deepened Plan, Critiques (4 files), Q&A, Final Plan, Task Graph |
| 2 | Execute | ${skillsRoot}/deep-execute/SKILL.md | Task Breakdown, Task Log, Implementation code |
| 3 | Review | ${skillsRoot}/deep-review/SKILL.md | Test results, review findings |
| 4 | Complete | ${skillsRoot}/deep-complete/SKILL.md | Commit plan, doc manifest, insights |

## Directory Structure (MANDATORY)

All planning artifacts go in: docs/plans/${SLUG}/

You MUST create this structure (this is what a real pipeline produces):

docs/plans/${SLUG}/
  invariants.md
  meta.md                       (phase tracking table with Status columns)
  prompt.md                     (verbatim task description with timestamp)
  research/
    locate-codebase.md
    locate-docs.md
    locate-git-history.md
    locate-patterns.md
    research-architecture.md
    research-domain.md
    research-patterns.md
    research-web.md
  initial-plan.md               (Goal, Architecture, Key Decisions, Changes, Data Model, UI Changes, Testing Strategy, Web Research Insights, Open Questions)
  user-flow-spec.md             (actors, happy path flows, error flows, edge cases, test matrix)
  deepened-plan.md              (concrete file paths, function signatures, error handling, rollback)
  critiques/
    critique-swe.md             (strengths, concerns table with severity/issue/suggestion)
    critique-security.md
    critique-perf.md
    critique-ux.md
  questions.md                  (auto-resolved Q&A with decision rationale)
  final-plan.md                 (canonical plan: summary, Q&A resolutions, architecture, data model, new files, modified files, flows, testing strategy, implementation order)
  execution/
    task-breakdown.md           (dependency graph, batch assignments, task details)
    task-log.md                 (task status tracking — REAL status, not aspirational)
  review/
    test-results.md             (REAL output from running tsc --noEmit and vitest run)
  complete/
    commit-plan.md              (structured commit plan with files and messages)
    doc-manifest.md             (documentation changes)
  insights.md                  (web research highlights, deferred suggestions, patterns, trade-offs)

## Key Rules

1. ALL research content comes from reading the project directory and web knowledge.
   Since this is a GREENFIELD project (no existing codebase), focus research on:
   - What MCP (Model Context Protocol) is and how it works
   - How pi extensions work (read any README or docs in the project)
   - Best practices for tool discovery/search systems
   - How similar projects structure their code

2. Number your research files exactly as shown (research-architecture.md, etc.)
   even if you have to be creative about what "architecture" means for a greenfield project.

3. The meta.md file MUST contain a phase tracking table with Status columns.

4. The prompt.md file MUST contain the verbatim task with a YAML frontmatter timestamp.

5. Update meta.md after completing each phase.

6. ALL src/ files MUST compile with tsc --noEmit and pass vitest run.

7. Do NOT skip phases. Do NOT skip files. Every file listed above must exist.

## CRITICAL: IMPLEMENTATION MUST BE REAL CODE

When you reach the Execution phase:
- You MUST use the write tool to create actual TypeScript files in src/
- You MUST NOT just describe what files would contain — write them
- You MUST NOT mark tasks as done without creating the actual files on disk
- The task-log should reflect REALITY, not aspiration
- After writing each file, verify it exists by reading it back
- This is a STANDALONE project: all implementation code goes in src/ (NOT extensions/)

Files you MUST create with the write tool:
- src/index.ts — the extension entry point exporting a default function
- src/types.ts — TypeScript interfaces (MCPServerConfig, MCPTool, etc.)
- src/config.ts — config loading from .pi/mcp-servers.json
- src/search.ts — tool search/discovery logic
- src/search.test.ts — vitest tests for search functionality

## CRITICAL: CRITIQUES MUST BE SUBSTANTIVE

Each critique file MUST:
- Reference specific sections of deepened-plan.md by name
- List at least 5 concerns with severity (High/Medium/Low)
- For each concern: quote the specific plan text, explain the risk, suggest a concrete fix
- Include a "Missing from plan" section for things the plan overlooks

Generic advice like "add error handling" or "consider caching" is NOT a critique.
A real critique says: "The plan's searchTools function on line 45 of deepened-plan.md does not
handle the case where inputSchema is undefined — this will cause a runtime TypeError when
building the tool index. Fix: add a null guard: inputSchema ?? { type: 'object' }"

## CRITICAL: REVIEW MUST ACTUALLY RUN

When you reach the Review phase:
- You MUST run "npm install" then "npx tsc --noEmit" and capture the output
- You MUST run "npx vitest run" and capture the output
- Write the REAL test results to the review output, not aspirational ones
- If tests fail, fix the code and re-run until they pass
- The task-log must show REAL pass/fail status, not fictional timestamps

## CRITICAL: INSIGHTS MUST EXIST

Create insights.md with:
- Web Research Highlights: 3-5 specific findings from research with URLs/sources
- Patterns Discovered: new patterns that emerged during implementation
- Trade-off Decisions: key decisions with rationale (table format)
- Process Improvements: what the pipeline could do better next time

## Implementation File Structure

This is a standalone TypeScript project with this setup:
- package.json already exists with typescript + vitest dependencies
- tsconfig.json already exists targeting ES2022
- src/ directory already exists

Your implementation files go in src/:
- src/index.ts — Export default function that registers tools
- src/types.ts — Interfaces and types
- src/config.ts — Configuration loading
- src/search.ts — Search/discovery logic  
- src/search.test.ts — Tests using vitest

## First Action

Read ${skillsRoot}/deep-plan/SKILL.md and follow its instructions starting from
Step 0 (Initialize). Create docs/plans/${SLUG}/ and begin the pipeline.
`;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 1: Resolver unit tests
// ═══════════════════════════════════════════════════════════════════════

describe("Skill Chain Resolver", () => {

	it("discovers all 16 skills in the skills directory", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		expect(map.size).toBe(16);
	});

	it("resolves deep-plan through product-vision to intellectual-honesty", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		const result = resolveChain("deep-plan", map);
		const names = result.ordered.map(s => s.name);

		expect(names).toContain("deep-plan");
		expect(names).toContain("compaction-resilience");
		expect(names).toContain("product-vision");
		expect(names).toContain("intellectual-honesty");
	});

	it("resolves deep-auto chain", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		const result = resolveChain("deep-auto", map);
		expect(result.ordered.length).toBeGreaterThanOrEqual(2);
		expect(result.ordered[0].name).toBe("deep-auto");
	});

	it("resolves deep-reflection through feedback-reinforcement and intellectual-honesty", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		const result = resolveChain("deep-reflection", map);
		const names = result.ordered.map(s => s.name);

		expect(names).toContain("deep-reflection");
		expect(names).toContain("feedback-reinforcement");
		expect(names).toContain("intellectual-honesty");
	});

	it("includes reference files", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		const result = resolveChain("deep-auto", map);

		expect(result.ordered.some(s => s.references.length > 0)).toBe(true);
	});

	it("handles cycles gracefully", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		// compaction-resilience imports itself
		const result = resolveChain("compaction-resilience", map);
		expect(result.ordered.length).toBeGreaterThanOrEqual(1);
	});

	it("handles missing references", () => {
		const partialMap = new Map<string, string>();
		const map = buildSkillMap([SKILLS_DIR]);
		partialMap.set("deep-auto", map.get("deep-auto")!);

		const result = resolveChain("deep-auto", partialMap);
		expect(result.ordered).toHaveLength(1);
		expect(result.missing.length).toBeGreaterThan(0);
	});

	it("resolveAll deduplicates across multiple entry points", () => {
		const map = buildSkillMap([SKILLS_DIR]);
		const result = resolveAll(["deep-plan", "deep-execute"], map);

		// Both import compaction-resilience — should appear only once
		const paths = result.skillPaths;
		const uniquePaths = new Set(paths);
		expect(paths.length).toBe(uniquePaths.size);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Part 2: E2E — GLM follows deep-* pipeline
// ═══════════════════════════════════════════════════════════════════════

const MODEL = "zai/glm-5.1";

const TASK_DESCRIPTION =
	"Implement an MCP server configuration extension for pi called 'mcp-discovery'. " +
	"It reads MCP server configs from `.pi/mcp-servers.json` and instead of loading " +
	"all tools at startup, provides a `search_mcp_tools` tool for incremental discovery. " +
	"Also provides `list_mcp_servers` and a `/mcp` command.";

// ═══════════════════════════════════════════════════════════════════════
// Part 2a: Baseline — GLM with NO pipeline (control)
// ═══════════════════════════════════════════════════════════════════════

describe("E2E: GLM baseline (no pipeline)", { timeout: 3_600_000, sequential: true }, () => {

	it("produces working code without pipeline skills", async () => {
		const dir = freshProject("glm-5.1-baseline");

		const client = new RpcClient(dir, MODEL);

		try {
			const prompt =
				"Implement an MCP server configuration extension for pi called 'mcp-discovery'. " +
				"It reads MCP server configs from `.pi/mcp-servers.json` and instead of loading " +
				"all tools at startup, provides a `search_mcp_tools` tool for incremental discovery. " +
				"Also provides `list_mcp_servers` and a `/mcp` command. " +
				"Write all files in src/. Tests must pass.";

			const events = await client.prompt(prompt);
			const text = client.getTextResponse(events);
			console.log("Baseline response:", text.length, "chars");

			// Check what was produced
			const slugDir = join(dir, "docs", "plans", SLUG);

			const planFiles = [
				"meta.md", "prompt.md", "initial-plan.md", "user-flow-spec.md",
				"deepened-plan.md", "questions.md", "final-plan.md",
				"research/locate-codebase.md", "research/research-web.md",
				"critiques/critique-swe.md", "execution/task-breakdown.md",
			];
			const srcFiles = ["src/index.ts", "src/types.ts", "src/config.ts", "src/search.ts", "src/search.test.ts"];

			console.log("\n=== Baseline Plan Artifacts ===");
			let planCount = 0;
			for (const f of planFiles) {
				const fullPath = join(dir, "docs", "plans", SLUG, ...f.split("/"));
				const exists = existsSync(fullPath);
				if (exists) {
					const content = readFileSync(fullPath, "utf8");
					console.log(`  FOUND: ${f} (${content.length} chars)`);
					planCount++;
				} else {
					console.log(`  MISSING: ${f}`);
				}
			}
			console.log(`Plan artifacts: ${planCount}/${planFiles.length}`);

			console.log("\n=== Baseline Src Files ===");
			let srcCount = 0;
			for (const f of srcFiles) {
				const fullPath = join(dir, f);
				const exists = existsSync(fullPath);
				if (exists) {
					const content = readFileSync(fullPath, "utf8");
					console.log(`  FOUND: ${f} (${content.length} chars)`);
					srcCount++;
				} else {
					console.log(`  MISSING: ${f}`);
				}
			}
			console.log(`Src files: ${srcCount}/${srcFiles.length}`);

			// Check all files in project
			console.log("\n=== All Files ===");
			const allFiles = findFiles(dir);
			allFiles.forEach(f => console.log(`  ${f}`));

			// Try to compile
			let tscOk = false;
			let testOk = false;
			if (existsSync(join(dir, "src", "index.ts"))) {
				const installResult = spawn("npm", ["install"], { cwd: dir, stdio: "pipe" });
				await new Promise<void>((resolve, reject) => {
					installResult.on("close", (code) => code === 0 ? resolve() : reject(new Error(`npm install failed: ${code}`)));
				});

				const tscResult = spawn("npx", ["tsc", "--noEmit"], { cwd: dir, stdio: "pipe" });
				let tscError = "";
				tscResult.stderr?.on("data", (d: Buffer) => tscError += d.toString());
				tscResult.stdout?.on("data", (d: Buffer) => tscError += d.toString());
				const tscExit = await new Promise<number>((resolve) => tscResult.on("close", resolve));
				tscOk = tscExit === 0;
				console.log(`\ntsc: ${tscOk ? "PASS" : "FAIL"}`);
				if (!tscOk) console.log("tsc errors:", tscError.slice(-500));

				const testResult = spawn("npx", ["vitest", "run", "--reporter=verbose"], { cwd: dir, stdio: "pipe" });
				let testOutput = "";
				testResult.stdout?.on("data", (d: Buffer) => testOutput += d.toString());
				testResult.stderr?.on("data", (d: Buffer) => testOutput += d.toString());
				const testExit = await new Promise<number>((resolve) => testResult.on("close", resolve));
				testOk = testExit === 0;
				console.log(`vitest: ${testOk ? "PASS" : "FAIL"}`);
				if (!testOk) console.log("test output:", testOutput.slice(-500));
			}

			// Score the baseline output
			const baselineScore = await scorePipeline(dir, { runBuild: false });
			console.log(formatScore(baselineScore));

			// Log summary for comparison (don't assert — this is a control group)
			console.log(`\n=== BASELINE SUMMARY ===`);
			console.log(`Response: ${text.length} chars`);
			console.log(`Score: ${baselineScore.grade} (${(baselineScore.total / baselineScore.maxTotal * 100).toFixed(0)}%)`);
			console.log(baselineScore.summary);

		} finally {
			client.kill();
		}
	});
});

function findFiles(dir: string, prefix = ""): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...findFiles(join(dir, entry.name), path));
		} else {
			files.push(path);
		}
	}
	return files;
}

describe("E2E: GLM follows deep-* pipeline", { timeout: 3_600_000, sequential: true }, () => {

	it("produces full pipeline artifact tree + working code", async () => {
		const dir = freshProject("glm-5.1");

		// Build the pipeline directive
		const skillDirs = [SKILLS_DIR];
		const pipelineDirective = buildTestPipelineDirective(skillDirs);

		// Write the directive as INSTRUCTIONS.md
		writeFileSync(join(dir, "INSTRUCTIONS.md"), pipelineDirective);

		const client = new RpcClient(dir, MODEL);

		try {
			const prompt =
				"Read INSTRUCTIONS.md and follow all instructions exactly. " +
				"Then execute the full pipeline for this task: " + TASK_DESCRIPTION;

			const events = await client.prompt(prompt);
			const text = client.getTextResponse(events);
			console.log("Full pipeline response:", text.length, "chars");

			const slugDir = join(dir, "docs", "plans", SLUG);

			// ── Helper: check file exists with minimum size ──
			function checkFile(description: string, ...pathParts: string[]) {
				const fullPath = join(dir, ...pathParts);
				const exists = existsSync(fullPath);
				if (!exists) {
					console.log(`  MISSING: ${description} (${pathParts.join("/")})`);
					return false;
				}
				const content = readFileSync(fullPath, "utf8");
				const ok = content.length > 20;
				console.log(`  ${ok ? "OK" : "EMPTY"}: ${description} (${content.length} chars)`);
				return ok;
			}

			// ════════════════════════════════════════════
			// Phase 1: Plan Artifacts
			// ════════════════════════════════════════════
			console.log("\n=== Plan Artifacts ===");

			// Root files
			expect(checkFile("invariants", "docs", "plans", SLUG, "invariants.md")).toBe(true);
			expect(checkFile("meta", "docs", "plans", SLUG, "meta.md")).toBe(true);
			expect(checkFile("prompt", "docs", "plans", SLUG, "prompt.md")).toBe(true);

			// meta.md must have phase tracking table
			const metaContent = readFileSync(join(slugDir, "meta.md"), "utf8");
			expect(metaContent).toMatch(/Phase.*Status|Status.*Phase/i);

			// prompt.md must have task reference
			const promptContent = readFileSync(join(slugDir, "prompt.md"), "utf8");
			expect(promptContent).toMatch(/mcp-discovery|MCP/i);

			// Research (8 files)
			console.log("\n=== Research Files ===");
			const researchFiles = [
				"locate-codebase.md",
				"locate-docs.md",
				"locate-git-history.md",
				"locate-patterns.md",
				"research-architecture.md",
				"research-domain.md",
				"research-patterns.md",
				"research-web.md",
			];
			for (const f of researchFiles) {
				expect(checkFile(f, "docs", "plans", SLUG, "research", f)).toBe(true);
			}

			// Plan documents
			console.log("\n=== Plan Documents ===");
			expect(checkFile("initial-plan", "docs", "plans", SLUG, "initial-plan.md")).toBe(true);
			expect(checkFile("user-flow-spec", "docs", "plans", SLUG, "user-flow-spec.md")).toBe(true);
			expect(checkFile("deepened-plan", "docs", "plans", SLUG, "deepened-plan.md")).toBe(true);

			// initial-plan must have key sections
			const planContent = readFileSync(join(slugDir, "initial-plan.md"), "utf8");
			expect(planContent).toMatch(/Goal/i);
			expect(planContent).toMatch(/Architecture/i);
			expect(planContent).toMatch(/Changes|Testing/i);

			// Critiques (4 files)
			console.log("\n=== Critiques ===");
			const critiqueFiles = [
				"critique-swe.md",
				"critique-security.md",
				"critique-perf.md",
				"critique-ux.md",
			];
			// Critiques must be substantive (at least 5 concerns each)
			for (const f of critiqueFiles) {
				const fullPath = join(slugDir, "critiques", f);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf8");
					const severityCount = (content.match(/High|Medium|Low/gi) || []).length;
					console.log(`  Critique substance: ${f} has ${severityCount} severity-tagged items`);
					expect(severityCount, `${f} is too shallow — needs at least 5 concerns with severity`).toBeGreaterThanOrEqual(5);
				}
			}

			// Q&A and Final Plan
			console.log("\n=== Q&A and Final Plan ===");
			expect(checkFile("questions", "docs", "plans", SLUG, "questions.md")).toBe(true);
			expect(checkFile("final-plan", "docs", "plans", SLUG, "final-plan.md")).toBe(true);

			// Execution tracking
			console.log("\n=== Execution ===");
			expect(checkFile("task-breakdown", "docs", "plans", SLUG, "execution", "task-breakdown.md")).toBe(true);
			expect(checkFile("task-log", "docs", "plans", SLUG, "execution", "task-log.md")).toBe(true);

			// Review results must exist with real test output
			console.log("\n=== Review Results ===");
			expect(checkFile("test-results", "docs", "plans", SLUG, "review", "test-results.md")).toBe(true);
			const reviewPath = join(slugDir, "review", "test-results.md");
			if (existsSync(reviewPath)) {
				const reviewContent = readFileSync(reviewPath, "utf8");
				expect(reviewContent, "Review must contain real test results").toMatch(/pass|fail|PASS|FAIL/i);
			}

			// Insights must exist
			console.log("\n=== Insights ===");
			expect(checkFile("insights", "docs", "plans", SLUG, "insights.md")).toBe(true);

			// ════════════════════════════════════════════
			// Phase 2: Implementation Files
			// ════════════════════════════════════════════
			console.log("\n=== Implementation Files ===");

			const requiredSrcFiles = [
				"src/index.ts",
				"src/types.ts",
				"src/config.ts",
				"src/search.ts",
				"src/search.test.ts",
			];

			for (const file of requiredSrcFiles) {
				const fullPath = join(dir, file);
				const exists = existsSync(fullPath);
				if (!exists) {
					console.log(`  MISSING: ${file}`);
				} else {
					const content = readFileSync(fullPath, "utf8");
					console.log(`  ${content.length > 50 ? "OK" : "EMPTY"}: ${file} (${content.length} chars)`);
				}
				expect(exists, `Missing file: ${file}`).toBe(true);
				if (exists) {
					const content = readFileSync(fullPath, "utf8");
					expect(content.length, `Empty file: ${file}`).toBeGreaterThan(50);
				}
			}

			// ════════════════════════════════════════════
			// Phase 3: Compile + Test
			// ════════════════════════════════════════════
			console.log("\n=== Build & Test ===");

			// npm install
			const installResult = spawn("npm", ["install"], { cwd: dir, stdio: "pipe" });
			await new Promise<void>((resolve, reject) => {
				installResult.on("close", (code) => code === 0 ? resolve() : reject(new Error(`npm install failed: ${code}`)));
			});

			// TypeScript compiles
			const tscResult = spawn("npx", ["tsc", "--noEmit"], { cwd: dir, stdio: "pipe" });
			let tscError = "";
			tscResult.stderr?.on("data", (d: Buffer) => tscError += d.toString());
			tscResult.stdout?.on("data", (d: Buffer) => tscError += d.toString());
			const tscExit = await new Promise<number>((resolve) => tscResult.on("close", resolve));
			console.log("tsc exit:", tscExit);
			if (tscExit !== 0) console.log("tsc errors:", tscError);
			expect(tscExit, `TypeScript errors:\n${tscError}`).toBe(0);

			// Tests pass
			const testResult = spawn("npx", ["vitest", "run", "--reporter=verbose"], { cwd: dir, stdio: "pipe" });
			let testOutput = "";
			testResult.stdout?.on("data", (d: Buffer) => testOutput += d.toString());
			testResult.stderr?.on("data", (d: Buffer) => testOutput += d.toString());
			const testExit = await new Promise<number>((resolve) => testResult.on("close", resolve));
			console.log("test exit:", testExit);
			if (testExit !== 0) console.log("test output:", testOutput.slice(-2000));
			expect(testExit, `Test failures:\n${testOutput.slice(-2000)}`).toBe(0);

			// Content checks on src/index.ts
			const indexContent = readFileSync(join(dir, "src/index.ts"), "utf8");
			expect(indexContent).toMatch(/search_mcp_tools|list_mcp_servers/);

			// ════════════════════════════════════════════
			// Phase 4: Completion Artifacts
			// ════════════════════════════════════════════
			console.log("\n=== Completion Artifacts ===");

			expect(checkFile("commit-plan", "docs", "plans", SLUG, "complete", "commit-plan.md")).toBe(true);
			expect(checkFile("doc-manifest", "docs", "plans", SLUG, "complete", "doc-manifest.md")).toBe(true);

			// Summary count
			const allPlanFiles = [
				"invariants.md", "meta.md", "prompt.md",
				...researchFiles.map(f => `research/${f}`),
				"initial-plan.md", "user-flow-spec.md", "deepened-plan.md",
				...critiqueFiles.map(f => `critiques/${f}`),
				"questions.md", "final-plan.md",
				"execution/task-breakdown.md", "execution/task-log.md",
				"review/test-results.md",
				"insights.md",
				"complete/commit-plan.md", "complete/doc-manifest.md",
			];

			const existingCount = allPlanFiles.filter(f => existsSync(join(slugDir, f.split("/").join("/")))).length;
			console.log(`\n=== SUMMARY: ${existingCount}/${allPlanFiles.length} plan artifacts found ===`);

			// ════════════════════════════════════════════
			// Scorecard (deterministic + LLM judge)
			// ════════════════════════════════════════════
			const pipelineScore = await scorePipeline(dir, {
				llmJudge: { model: MODEL, timeoutMs: 120_000 },
			});
			console.log(formatScore(pipelineScore));

		} finally {
			client.kill();
		}
	});
});
