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
import { join, dirname } from "node:path";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;      // processed SKILL.md content (frontmatter + body, refs stripped)
	references: string[];  // paths to reference files
	children: ResolvedSkill[];
}

export interface ResolveResult {
	/** The full skill tree */
	root: ResolvedSkill;
	/** All skills in breadth-first order (root first, then children) */
	ordered: ResolvedSkill[];
	/** Names that couldn't be found */
	missing: string[];
	/** Names that formed a cycle */
	cycles: string[];
	/** The composed prompt — all skill contents + references joined */
	composed: string;
}

// Match `imports:` block in frontmatter
const IMPORTS_RE = /^imports:\s*\n((?:\s+- .+\n?)*)/m;
const IMPORT_LINE_RE = /^   - (.+)$/gm;

// Match `Read skill: <name>` in body
const READ_SKILL_RE = /^[ \t]*Read skill:\s*(.+?)\s*$/gm;

/**
 * Parse frontmatter imports from a SKILL.md file
 */
function parseImports(content: string): string[] {
	const importsBlock = content.match(IMPORTS_RE);
	if (!importsBlock) return [];
	const imports: string[] = [];
	let match: RegExpExecArray | null;
	const blockContent = importsBlock[1];
	while ((match = IMPORT_LINE_RE.exec(blockContent)) !== null) {
		imports.push(match[1].trim());
	}
	return imports;
}

/**
 * Parse `Read skill: <name>` references from body text
 */
function parseReadSkillRefs(content: string): string[] {
	const refs: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = READ_SKILL_RE.exec(content)) !== null) {
		refs.push(match[1].trim());
	}
	return refs;
}

/**
 * List reference files in the skill's references/ directory
 */
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

/**
 * Read all reference files and return their contents
 */
function readReferences(refPaths: string[]): string[] {
	return refPaths
		.map((p) => {
			try {
				return `--- Reference: ${p.split("/").slice(-2).join("/")} ---\n\n${readFileSync(p, "utf8")}`;
			} catch {
				return "";
			}
		})
		.filter(Boolean);
}

/**
 * Resolve a skill chain starting from the given skill.
 */
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
		if (!skillDir) {
			missing.push(name);
			return null;
		}

		const skillPath = join(skillDir, "SKILL.md");
		if (!existsSync(skillPath)) {
			missing.push(name);
			return null;
		}

		const raw = readFileSync(skillPath, "utf8");

		// Collect references from both mechanisms
		const frontmatterImports = parseImports(raw);
		const bodyRefs = parseReadSkillRefs(raw);

		// Deduplicate
		const allRefs = [...new Set([...frontmatterImports, ...bodyRefs])];

		// Strip "Read skill:" lines from content (keep frontmatter imports since they're metadata)
		const content = raw.replace(READ_SKILL_RE, "").trim();

		// Get reference files
		const refFilePaths = listReferenceFiles(skillDir);

		const children: ResolvedSkill[] = [];
		const skill: ResolvedSkill = {
			name,
			path: skillDir,
			content,
			references: refFilePaths,
			children,
		};
		ordered.push(skill); // parent before children

		for (const ref of allRefs) {
			const child = resolve(ref, new Set(visited), depth + 1);
			if (child) children.push(child);
		}

		return skill;
	}

	const root = resolve(skillName, new Set(), 0);
	if (!root) {
		throw new Error(`Root skill "${skillName}" not found in skillMap`);
	}

	// Compose: all skill contents + their references in order
	const parts: string[] = [];
	for (let i = 0; i < ordered.length; i++) {
		const s = ordered[i];
		parts.push(`═══════════════════════════════════════════════════\nSkill: ${s.name} (level ${i + 1})\n═══════════════════════════════════════════════════\n\n${s.content}`);

		// Append reference file contents
		const refContents = readReferences(s.references);
		if (refContents.length > 0) {
			parts.push(`\n\n--- References for ${s.name} ---\n\n${refContents.join("\n\n")}`);
		}
	}

	const composed = parts.join("\n\n");

	return { root, ordered, missing, cycles, composed };
}

/**
 * Build a skill map from a base directory.
 * Scans immediate subdirectories for SKILL.md files.
 */
export function buildSkillMap(baseDir: string): Map<string, string> {
	const map = new Map<string, string>();

	if (!existsSync(baseDir)) return map;

	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillPath = join(baseDir, entry.name, "SKILL.md");
		if (existsSync(skillPath)) {
			map.set(entry.name, join(baseDir, entry.name));
		}
	}

	return map;
}
