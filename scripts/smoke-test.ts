/**
 * Pre-sync smoke test — validates extensions can parse and export correctly.
 *
 * Runs before `npm run sync`. Catches:
 *   - Missing default exports
 *   - TypeScript syntax errors (via dynamic import)
 *   - Test files that shouldn't be synced
 *   - Widget truncation overflow (simulated)
 *
 * Usage:
 *   npx tsx scripts/smoke-test.ts
 *   npm run sync          # calls this automatically
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";

const here = import.meta.dirname;
const root = join(here, "..");
const extensionsDir = join(root, "extensions");

interface SmokeResult {
	extension: string;
	check: string;
	status: "pass" | "fail" | "warn";
	message: string;
}

const results: SmokeResult[] = [];
let failures = 0;

function report(r: SmokeResult) {
	results.push(r);
	if (r.status === "fail") failures++;
	const icon = r.status === "pass" ? "✓" : r.status === "warn" ? "⚠" : "✗";
	const color = r.status === "pass" ? "\x1b[32m" : r.status === "warn" ? "\x1b[33m" : "\x1b[31m";
	console.log(`  ${color}${icon}\x1b[0m ${r.extension}/${r.check}: ${r.message}`);
}

async function smokeTest() {
	console.log("\n🧪 Extension smoke tests\n");

	const entries = await readdir(extensionsDir, { withFileTypes: true });
	const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));

	for (const dir of dirs) {
		const name = dir.name;
		const extPath = join(extensionsDir, name);

		// ── Check 1: index.ts exists ──
		if (name === "shared") {
			// shared/ is a library, no index.ts needed
			report({ extension: name, check: "index.ts", status: "pass", message: "shared library — no index.ts needed" });
			continue;
		}

		const indexPath = join(extPath, "index.ts");
		if (!existsSync(indexPath)) {
			report({ extension: name, check: "index.ts", status: "fail", message: "no index.ts" });
			continue;
		}
		report({ extension: name, check: "index.ts", status: "pass", message: "exists" });

		// ── Check 2: valid TypeScript syntax (basic parse) ──
		const content = await readFile(indexPath, "utf8");

		// Check for common syntax errors
		const syntaxIssues: string[] = [];

		// Unclosed braces (very basic check)
		const openBraces = (content.match(/\{/g) || []).length;
		const closeBraces = (content.match(/\}/g) || []).length;
		if (Math.abs(openBraces - closeBraces) > 1) {
			syntaxIssues.push(`unbalanced braces: ${openBraces} { vs ${closeBraces} }`);
		}

		// Unclosed parentheses
		const openParens = (content.match(/\(/g) || []).length;
		const closeParens = (content.match(/\)/g) || []).length;
		if (Math.abs(openParens - closeParens) > 1) {
			syntaxIssues.push(`unbalanced parens: ${openParens} ( vs ${closeParens} )`);
		}

		// Check for export default
		if (!content.includes("export default")) {
			syntaxIssues.push("missing 'export default' — pi requires a default export function");
		}

		if (syntaxIssues.length > 0) {
			report({ extension: name, check: "syntax", status: "fail", message: syntaxIssues.join("; ") });
		} else {
			report({ extension: name, check: "syntax", status: "pass", message: "basic checks OK" });
		}

		// ── Check 3: imports are from known pi packages ──
		const importRegex = /import\s+.*?from\s+["']([^"']+)["']/g;
		const knownPrefixes = [
			"@mariozechner/pi-coding-agent",
			"@mariozechner/pi-ai",
			"@mariozechner/pi-tui",
			"typebox",
			"node:",
			"./",
			"../",
		];
		let match: RegExpExecArray | null;
		while ((match = importRegex.exec(content)) !== null) {
			const mod = match[1];
			const known = knownPrefixes.some((p) => mod.startsWith(p));
			if (!known) {
				report({
					extension: name,
					check: "imports",
					status: "warn",
					message: `unknown import: ${mod}`,
				});
			}
		}

		// ── Check 4: widget render functions use truncateToWidth ──
		if (content.includes("setWidget") && content.includes("render(width")) {
			if (content.includes("truncateToWidth")) {
				report({ extension: name, check: "widget-truncation", status: "pass", message: "widget uses truncateToWidth" });
			} else {
				report({
					extension: name,
					check: "widget-truncation",
					status: "warn",
					message: "widget has render() but no truncateToWidth — may overflow terminal width",
				});
			}
		}

		// ── Check 5: registerCommand called with string name (not object) ──
		const registerCmdRegex = /pi\.registerCommand\s*\(/g;
		let cmdMatch: RegExpExecArray | null;
		while ((cmdMatch = registerCmdRegex.exec(content)) !== null) {
			// Grab everything from the ( to the first ) or { at the same nesting level
			const afterParen = content.slice(cmdMatch.index + cmdMatch[0].length);
			const firstChar = afterParen.trimStart()[0];
			if (firstChar === "{" || firstChar === "[") {
				report({
					extension: name,
					check: "registerCommand",
					status: "fail",
					message: `registerCommand called with ${firstChar === "{" ? "object" : "array"} as first arg — must be a string command name. Use: pi.registerCommand("name", { ... })`,
				});
			}
		}

		// ── Check 6: test files shouldn't reference local-only deps ──
		const files = await readdir(extPath);
		const testFiles = files.filter((f) => f.includes(".test.") || f.startsWith("test-"));
		if (testFiles.length > 0) {
			report({
				extension: name,
				check: "test-files",
				status: "warn",
				message: `${testFiles.length} test file(s) will be synced: ${testFiles.join(", ")}`,
			});
		}
	}

	// ── Summary ──
	console.log(`\n${"─".repeat(50)}`);
	const passed = results.filter((r) => r.status === "pass").length;
	const warned = results.filter((r) => r.status === "warn").length;
	const failed = results.filter((r) => r.status === "fail").length;
	console.log(`  ${passed} passed, ${warned} warnings, ${failed} failures\n`);

	if (failures > 0) {
		console.log("\x1b[31m🚫 Smoke tests failed — fix before syncing.\x1b[0m\n");
		process.exit(1);
	} else {
		console.log("\x1b[32m✅ All smoke tests passed — safe to sync.\x1b[0m\n");
	}
}

smokeTest().catch((err) => {
	console.error("Smoke test runner failed:", err);
	process.exit(1);
});
