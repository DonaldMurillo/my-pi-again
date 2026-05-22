/**
 * Skill Chain Extension for Pi
 *
 * Resolves skill import chains from configured skill directories.
 * When autoResolve is set, injects a lightweight pipeline directive that
 * tells the model to create tasks for each phase and load skills on demand
 * — instead of loading all skill content into context at once.
 *
 * Configuration: `.pi/skill-chain.json`
 *
 * Commands:
 *   /skill-chain          — show resolved skill chains
 *   /skill-chain scan     — rescan
 *   /skill-chain resolve <name> — show chain for a specific skill
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { buildSkillMap, resolveChain, resolveAll } from "./resolver";

// ─── Config ─────────────────────────────────────────────────────────

interface SkillChainConfig {
	/** Directories to scan for skills */
	skillDirs: string[];
	/** Entry points to auto-resolve on session start */
	autoResolve?: string[];
}

const DEFAULT_CONFIG: SkillChainConfig = {
	skillDirs: [],
};

function expandTilde(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function loadConfig(cwd: string): SkillChainConfig {
	for (const p of [join(cwd, ".pi", "skill-chain.json"), join(homedir(), ".pi", "agent", "skill-chain.json")]) {
		if (!existsSync(p)) continue;
		try {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			return {
				skillDirs: Array.isArray(raw.skillDirs) ? raw.skillDirs : [],
				autoResolve: Array.isArray(raw.autoResolve) ? raw.autoResolve : undefined,
			};
		} catch { /* skip */ }
	}
	return { ...DEFAULT_CONFIG };
}

function resolveDirs(dirs: string[], cwd: string): string[] {
	return dirs.map((d) => {
		const expanded = expandTilde(d);
		return d.startsWith("~") || d.startsWith("/") ? expanded : resolve(cwd, expanded);
	});
}

// ─── Pipeline Directive ────────────────────────────────────────────

/**
 * The phases of the deep-* pipeline, in order.
 * Each phase references which skill to load when working on it.
 */
const PIPELINE_PHASES = [
	{ phase: "Preflight", skill: "deep-auto", system: "preflight" },
	{ phase: "Planning", skill: "deep-plan", system: "plan" },
	{ phase: "Execution", skill: "deep-execute", system: "execute" },
	{ phase: "Review", skill: "deep-review", system: "review" },
	{ phase: "Completion", skill: "deep-complete", system: "complete" },
];

/**
 * Generate a lightweight pipeline directive that tells the model to:
 * 1. Create persistent tasks for each pipeline phase
 * 2. Work through them one at a time
 * 3. Load the relevant skill file per task (on-demand, not all at once)
 * 4. Create the required artifacts on disk
 */
function buildPipelineDirective(state: ChainState): string | null {
	if (!state.config.autoResolve || state.config.autoResolve.length === 0) {
		return null;
	}

	const entryPoints = state.config.autoResolve;
	const skillsRoot = state.config.skillDirs[0] || "skills";

	const phaseRows = PIPELINE_PHASES.map((p, i) =>
		`| ${i + 1} | ${p.phase} | ${p.skill} | ${state.skillMap.has(p.skill) ? "✓" : "✗"} |`
	).join("\n");

	return `---
name: active-pipeline
description: >
   ACTIVE PIPELINE. Create tasks for each phase, load skills on demand, execute sequentially.
   Do NOT load all skills into context at once. One skill per task.
---

# Active Pipeline: ${entryPoints.join(", ")}

You are executing a multi-phase pipeline. DO NOT load all skills at once — your context cannot hold them.
Instead, create persistent tasks and load one skill per task.

## Pipeline Phases

| # | Phase | Skill to Load | Available |
|---|-------|---------------|-----------|
${phaseRows}

## How to Execute

### Step 1: Generate slug and create the task list

Generate a kebab-case slug from the user's request. Then use TaskCreate to create a task for each phase:

    TaskCreate({ subject: "Preflight — infrastructure checks", description: "Read skill file: ${skillsRoot}/deep-auto/SKILL.md. Run preflight checks.", labels: ["pipeline", "skill:deep-auto"] })
    TaskCreate({ subject: "Planning — research, plan, spec, critiques, final plan", description: "Read skill file: ${skillsRoot}/deep-plan/SKILL.md. Follow ALL phases: research/ (8 files), initial-plan.md, user-flow-spec.md, deepened-plan.md, critiques/ (4 files), questions.md, final-plan.md. Create EVERY file the skill specifies.", labels: ["pipeline", "skill:deep-plan"] })
    TaskCreate({ subject: "Execution — task breakdown + implementation", description: "Read skill file: ${skillsRoot}/deep-execute/SKILL.md. Create execution/task-breakdown.md, execution/task-log.md. Implement code.", labels: ["pipeline", "skill:deep-execute"] })
    TaskCreate({ subject: "Review — full test suite + fix cycles", description: "Read skill file: ${skillsRoot}/deep-review/SKILL.md. Run full test suite, spawn reviewers, triage, fix, verify.", labels: ["pipeline", "skill:deep-review"] })
    TaskCreate({ subject: "Completion — commit plan, docs, insights", description: "Read skill file: ${skillsRoot}/deep-complete/SKILL.md. Create complete/commit-plan.md, complete/doc-manifest.md, insights.md.", labels: ["pipeline", "skill:deep-complete"] })

### Step 2: Pick up the first task with TaskNext()

    TaskNext()  // returns the highest-priority actionable task

### Step 3: For each task — read the skill file, execute, mark done

1. Read the skill file referenced in the task description
2. Follow that skill's instructions to complete the phase
3. Create all files the skill specifies on disk
4. Mark the task completed: TaskUpdate({ taskId, status: "completed" })
5. Call TaskNext() to get the next task

### Step 4: Create pipeline tracking docs

Before starting Phase 1, create:
- docs/plans/{slug}/meta.md — phase tracking table
- docs/plans/{slug}/prompt.md — user's verbatim request

Update meta.md as each phase completes.

## Required Artifacts

By the end of the pipeline, these MUST exist on disk:

  docs/plans/{slug}/
    invariants.md
    meta.md              — phase tracking table
    prompt.md            — original task with timestamp
    research/            — 8 research files (locate-codebase, locate-docs, locate-git-history, locate-patterns, research-architecture, research-domain, research-patterns, research-web)
    initial-plan.md      — Goal, Architecture, Changes, Data Model, Testing Strategy
    user-flow-spec.md    — actors, flows, error cases, test matrix
    deepened-plan.md     — concrete and actionable version of initial plan
    critiques/           — critique-swe.md, critique-security.md, critique-perf.md, critique-ux.md
    questions.md         — auto-resolved Q&A with decisions
    final-plan.md        — canonical plan incorporating all resolutions
    execution/
      task-breakdown.md  — dependency graph, batch assignments
      task-log.md        — task status tracking
    complete/
      commit-plan.md     — structured commits
      doc-manifest.md    — documentation changes
    insights.md          — learnings, trade-offs, patterns

  src/ — implementation files that compile and pass tests

## Key Rules

- **One skill per task** — read only the skill file for the current task, not all skills
- **Write to disk** — use the write tool to create actual files
- **Update meta.md** — track progress after each phase
- **Do not skip phases** — complete each one before moving on
- **Use TaskNext/TaskUpdate** — the task system persists across context compaction
`;
}

// ─── State ──────────────────────────────────────────────────────────

interface ChainState {
	config: SkillChainConfig;
	skillMap: Map<string, string>;
	resolvedPaths: string[];
	missing: string[];
	cycles: string[];
}

// ─── Extension ──────────────────────────────────────────────────────

export default function registerSkillChain(pi: ExtensionAPI): void {
	const state: ChainState = {
		config: DEFAULT_CONFIG,
		skillMap: new Map(),
		resolvedPaths: [],
		missing: [],
		cycles: [],
	};

	function scan(cwd: string) {
		state.config = loadConfig(cwd);
		const resolvedDirs = resolveDirs(state.config.skillDirs, cwd);
		state.skillMap = buildSkillMap(resolvedDirs);
		state.resolvedPaths = [];
		state.missing = [];
		state.cycles = [];

		// If autoResolve is set, resolve those entry points
		if (state.config.autoResolve && state.config.autoResolve.length > 0) {
			const result = resolveAll(state.config.autoResolve, state.skillMap);
			state.resolvedPaths = result.skillPaths;
			state.missing = result.missing;
			state.cycles = result.cycles;
		} else {
			// No auto-resolve — just make all discovered skills available
			// (they'll be chain-resolved individually when triggered)
			state.resolvedPaths = Array.from(state.skillMap.values());
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		scan(ctx.cwd);
		if (state.skillMap.size > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`[skill-chain] Discovered ${state.skillMap.size} skills in ${state.config.skillDirs.length} directories`,
				"info",
			);
		}
	});

	pi.on("resources_discover", async (_event, _ctx) => {
		// When autoResolve is set, return ONLY the pipeline directive —
		// the model loads individual skills on demand per task via the read tool.
		// This avoids loading all 16 skills into context at once.
		if (state.config.autoResolve && state.config.autoResolve.length > 0) {
			const pipelineDir = join(_ctx.cwd, ".pi", "_pipeline-active");
			const pipelineSkill = buildPipelineDirective(state);
			if (pipelineSkill) {
				try {
					const { mkdirSync, writeFileSync } = require("node:fs");
					mkdirSync(pipelineDir, { recursive: true });
					writeFileSync(join(pipelineDir, "SKILL.md"), pipelineSkill);
					return { skillPaths: [pipelineDir] };
				} catch { /* best effort */ }
			}
		}
		// No autoResolve — make all discovered skills available directly
		if (state.resolvedPaths.length > 0) {
			return { skillPaths: state.resolvedPaths };
		}
		return {};
	});

	pi.registerCommand("skill-chain", {
		description: "Manage skill chains — resolve, scan, and inspect skill import graphs",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "list";

			switch (sub) {
				case "list":
				case "status": {
					const lines = [
						`Skill Chain: ${state.skillMap.size} skills discovered`,
						`Resolved: ${state.resolvedPaths.length} skill paths`,
						`Directories: ${state.config.skillDirs.join(", ") || "(none)"}`,
					];
					if (state.config.autoResolve) {
						lines.push(`Auto-resolve: ${state.config.autoResolve.join(", ")}`);
					}
					if (state.missing.length > 0) {
						lines.push(`Missing: ${state.missing.join(", ")}`);
					}
					if (state.cycles.length > 0) {
						lines.push(`Cycles: ${state.cycles.join(", ")}`);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}

				case "scan":
				case "refresh": {
					scan(ctx.cwd);
					ctx.ui.notify(
						`Scanned ${state.config.skillDirs.length} directories → ${state.skillMap.size} skills, ${state.resolvedPaths.length} resolved paths`,
						"info",
					);
					break;
				}

				case "resolve": {
					const skillName = parts[1];
					if (!skillName) {
						ctx.ui.notify("Usage: /skill-chain resolve <skill-name>", "info");
						break;
					}
					try {
						const result = resolveChain(skillName, state.skillMap);
						const names = result.ordered.map((s, i) => `  ${i + 1}. ${s.name} (${s.references.length} refs)`);
						const output = [
							`Chain for "${skillName}":`,
							...names,
							`Missing: ${result.missing.length > 0 ? result.missing.join(", ") : "none"}`,
							`Cycles: ${result.cycles.length > 0 ? result.cycles.join(", ") : "none"}`,
						].join("\n");
						ctx.ui.notify(output, "info");
					} catch (e: any) {
						ctx.ui.notify(`Error: ${e.message}`, "error");
					}
					break;
				}

				default:
					ctx.ui.notify("Usage: /skill-chain <list|scan|resolve>", "info");
			}
		},
	});
}
