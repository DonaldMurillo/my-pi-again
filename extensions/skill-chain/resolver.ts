/**
 * Skill Chain Resolver
 *
 * Resolves skill references from three mechanisms:
 *   1. `imports:` in YAML frontmatter (e.g., `imports: [compaction-resilience]`)
 *   2. `Read skill: <name>` in body text
 *   3. `references/` directory (extra context files, not chained skills)
 *
 * Handles cycle detection and missing references gracefully.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

export interface ResolvedSkill {
	name: string;
	path: string;        // absolute path to skill directory
	content: string;     // processed SKILL.md content
	references: string[];// absolute paths to reference files
	children: ResolvedSkill[];
}

export interface ResolveResult {
	root: ResolvedSkill;
	ordered: ResolvedSkill[];  // breadth-first: root first, then children
	missing: string[];
	cycles: string[];
}

// ─── Parsing ────────────────────────────────────────────────────────

const IMPORTS_BLOCK_RE = /^imports:\s*\n((?:\s+- .+\n?)*)/m;
const IMPORT_LINE_RE = /^   - (.+)$/gm;
const READ_SKILL_RE = /^[ \t]*Read skill:\s*(.+?)\s*$/gm;

function parseImports(content: string): string[] {
	const match = content.match(IMPORTS_BLOCK_RE);
	if (!match) return [];
	const imports: string[] = [];
	let line: RegExpExecArray | null;
	while ((line = IMPORT_LINE_RE.exec(match[1])) !== null) {
		imports.push(line[1].trim());
	}
	return imports;
}

function parseReadSkillRefs(content: string): string[] {
	const refs: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = READ_SKILL_RE.exec(content)) !== null) {
		refs.push(match[1].trim());
	}
	return refs;
}

function listReferenceFiles(skillDir: string): string[] {
	const refsDir = join(skillDir, "references");
	if (!existsSync(refsDir)) return [];
	try {
		return readdirSync(refsDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => join(refsDir, f));
	} catch {
		return [];
	}
}

// ─── Resolution ─────────────────────────────────────────────────────

export function resolveChain(
	skillName: string,
	skillMap: Map<string, string>,
	maxDepth = 10,
): ResolveResult {
	const ordered: ResolvedSkill[] = [];
	const missing: string[] = [];
	const cycles: string[] = [];

	function resolve(name: string, visited: Set<string>, depth: number): ResolvedSkill | null {
		if (depth > maxDepth) return null;
		if (visited.has(name)) {
			cycles.push(name);
			return null;
		}
		visited.add(name);

		const skillDir = skillMap.get(name);
		if (!skillDir) { missing.push(name); return null; }

		const skillPath = join(skillDir, "SKILL.md");
		if (!existsSync(skillPath)) { missing.push(name); return null; }

		const raw = readFileSync(skillPath, "utf8");
		const frontmatterImports = parseImports(raw);
		const bodyRefs = parseReadSkillRefs(raw);
		const allRefs = [...new Set([...frontmatterImports, ...bodyRefs])];

		const content = raw.replace(READ_SKILL_RE, "").trim();
		const refFilePaths = listReferenceFiles(skillDir);

		const children: ResolvedSkill[] = [];
		const skill: ResolvedSkill = { name, path: skillDir, content, references: refFilePaths, children };
		ordered.push(skill);

		for (const ref of allRefs) {
			const child = resolve(ref, new Set(visited), depth + 1);
			if (child) children.push(child);
		}

		return skill;
	}

	const root = resolve(skillName, new Set(), 0);
	if (!root) throw new Error(`Root skill "${skillName}" not found in skillMap`);
	return { root, ordered, missing, cycles };
}

/**
 * Resolve multiple entry points and return the deduplicated set of
 * skill directories (for returning as skillPaths to pi).
 */
export function resolveAll(
	entryPoints: string[],
	skillMap: Map<string, string>,
): { skillPaths: string[]; missing: string[]; cycles: string[] } {
	const seen = new Set<string>();
	const allPaths: string[] = [];
	const allMissing: string[] = [];
	const allCycles: string[] = [];

	for (const entry of entryPoints) {
		try {
			const result = resolveChain(entry, skillMap);
			for (const skill of result.ordered) {
				if (!seen.has(skill.path)) {
					seen.add(skill.path);
					allPaths.push(skill.path);
				}
			}
			allMissing.push(...result.missing);
			allCycles.push(...result.cycles);
		} catch {
			allMissing.push(entry);
		}
	}

	return { skillPaths: allPaths, missing: [...new Set(allMissing)], cycles: [...new Set(allCycles)] };
}

// ─── Discovery ──────────────────────────────────────────────────────

/**
 * Build a skill map from one or more directories.
 * Scans immediate subdirectories for SKILL.md files.
 */
export function buildSkillMap(dirs: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (map.has(entry.name)) continue; // first dir wins
			const skillPath = join(dir, entry.name, "SKILL.md");
			if (existsSync(skillPath)) {
				map.set(entry.name, join(dir, entry.name));
			}
		}
	}
	return map;
}
