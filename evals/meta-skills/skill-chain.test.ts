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
import { checkPipeline, formatReport, type CheckConfig } from "./scoring";

// ─── RPC client ─────────────────────────────────────────────────────

interface JsonLine { [key: string]: unknown; type: string; }

class RpcClient {
	private proc: ChildProcess;
	private buffer = "";
	private pending: Array<{ resolve: (line: JsonLine) => void; predicate: (line: JsonLine) => boolean }> = [];
	private lines: JsonLine[] = [];
	private textParts: string[] = [];
	private done = false;

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
				if (obj.type === "message_update") {
					const msg = (obj as any).message;
					if (msg?.role === "assistant" && Array.isArray(msg?.content)) {
						for (const block of msg.content) {
							if (block.type === "text" && typeof block.text === "string") {
								this.textParts.push(block.text);
							}
						}
					}
				} else if (obj.type === "agent_end") {
					this.done = true;
				}
				if (obj.type !== "message_update") {
					this.lines.push(obj);
				}
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
			if (this.done) return this.lines.splice(0);
			await new Promise((r) => setTimeout(r, 200));
		}
		return this.lines.splice(0);
	}

	getTextResponse(_events: JsonLine[]): string {
		return this.textParts.join(" ");
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

// No buildTestPipelineDirective — the extension's resources_discover hook
// generates the pipeline directive automatically from the skill files.

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

			// Check the baseline output
			const baselineReport = await checkPipeline(dir, { runBuild: false });
			console.log(formatReport(baselineReport));

			// Log summary
			console.log(`\n=== BASELINE SUMMARY ===`);
			console.log(`Response: ${text.length} chars`);
			console.log(`Checklist: ${baselineReport.passed}/${baselineReport.total}`);

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

		// The skill-chain extension will auto-generate a pipeline directive
		// via its resources_discover hook when it sees .pi/skill-chain.json.
		// No need to write a manual INSTRUCTIONS.md — the extension handles it.

		const client = new RpcClient(dir, MODEL);

		try {
			const prompt = TASK_DESCRIPTION +
				" Write all implementation code in src/. " +
				"Follow the active pipeline directive. " +
				"Use TaskCreate to create tasks for each phase, then work through them with TaskNext. " +
				"Read each skill file when you start its task.";

			const events = await client.prompt(prompt);
			const text = client.getTextResponse(events);
			console.log("Full pipeline response:", text.length, "chars");

			// Discover the slug — GLM generates it from the task description
			const plansDir = join(dir, "docs", "plans");
			const slugDirs = existsSync(plansDir)
				? readdirSync(plansDir, { withFileTypes: true })
					.filter(d => d.isDirectory())
					.map(d => d.name)
				: [];
			console.log("Slug directories:", slugDirs);
			expect(slugDirs.length, "Expected at least one slug directory under docs/plans/").toBeGreaterThanOrEqual(1);
			const slug = slugDirs[0];
			const slugDir = join(plansDir, slug);
			console.log("Using slug:", slug);

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
			expect(checkFile("invariants", "docs", "plans", slug, "invariants.md")).toBe(true);
			expect(checkFile("meta", "docs", "plans", slug, "meta.md")).toBe(true);
			expect(checkFile("prompt", "docs", "plans", slug, "prompt.md")).toBe(true);

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
				expect(checkFile(f, "docs", "plans", slug, "research", f)).toBe(true);
			}

			// Plan documents
			console.log("\n=== Plan Documents ===");
			expect(checkFile("initial-plan", "docs", "plans", slug, "initial-plan.md")).toBe(true);
			expect(checkFile("user-flow-spec", "docs", "plans", slug, "user-flow-spec.md")).toBe(true);
			expect(checkFile("deepened-plan", "docs", "plans", slug, "deepened-plan.md")).toBe(true);

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
			// Log critique substance (don't hard-assert — checklist covers this)
			for (const f of critiqueFiles) {
				const fullPath = join(slugDir, "critiques", f);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf8");
					const severityCount = (content.match(/High|Medium|Low/gi) || []).length;
					console.log(`  Critique substance: ${f} has ${severityCount} severity-tagged items`);
				}
			}

			// Q&A and Final Plan
			console.log("\n=== Q&A and Final Plan ===");
			expect(checkFile("questions", "docs", "plans", slug, "questions.md")).toBe(true);
			expect(checkFile("final-plan", "docs", "plans", slug, "final-plan.md")).toBe(true);

			// Execution tracking
			console.log("\n=== Execution ===");
			expect(checkFile("task-breakdown", "docs", "plans", slug, "execution", "task-breakdown.md")).toBe(true);
			expect(checkFile("task-log", "docs", "plans", slug, "execution", "task-log.md")).toBe(true);

			// Review results must exist with real test output
			console.log("\n=== Review Results ===");
			expect(checkFile("test-results", "docs", "plans", slug, "review", "test-results.md")).toBe(true);
			const reviewPath = join(slugDir, "review", "test-results.md");
			if (existsSync(reviewPath)) {
				const reviewContent = readFileSync(reviewPath, "utf8");
				expect(reviewContent, "Review must contain real test results").toMatch(/pass|fail|PASS|FAIL/i);
			}

			// Insights must exist
			console.log("\n=== Insights ===");
			expect(checkFile("insights", "docs", "plans", slug, "insights.md")).toBe(true);

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

			expect(checkFile("commit-plan", "docs", "plans", slug, "complete", "commit-plan.md")).toBe(true);
			expect(checkFile("doc-manifest", "docs", "plans", slug, "complete", "doc-manifest.md")).toBe(true);

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
			// Checklist (deterministic + LLM judge)
			// ════════════════════════════════════════════
			const pipelineReport = await checkPipeline(dir, {
				slug,
				llmJudge: { model: MODEL, timeoutMs: 120_000 },
			});
			console.log(formatReport(pipelineReport));

		} finally {
			client.kill();
		}
	});
});
