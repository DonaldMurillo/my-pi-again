/**
 * Pure helper functions for the isolation extension.
 * Extracted for testability — imported by both index.ts and tests.
 */

import { resolve, sep } from "node:path";
import { homedir } from "node:os";

// Expand ~ in paths before resolution
function expandTilde(p: string): string {
	return p.startsWith("~/") ? p.replace("~/", homedir() + "/") : p;
}

// ─── Safe bash patterns (read-only) ─────────────────────────────────

const SAFE_BASH_PATTERNS = [
	/^\s*cat\b/,
	/^\s*ls\b/,
	/^\s*find\b/,
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*wc\b/,
	/^\s*git\s+(log|diff|status|show|branch|tag|remote|init|add|commit|stash)/,
	/^\s*echo\b/,
	/^\s*node\s+--test\b/,
	/^\s*npm\s+(test|run|list)/,
	/^\s*npx\s+/,
	/^\s*pnpm\s+(test|run|list)/,
	/^\s*pnpm\s+(exec|dlx)\s+/,
	/^\s*which\b/,
	/^\s*type\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*pwd\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*curl\s+-/,
	/^\s*mkdir\s+-p\b/,
];

// Patterns that indicate file writing/deletion in bash
const DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/,
	/>\s*\//,
	/>\s*~/,
	/\bdd\b/,
	/\btee\b/,
	/\bsed\s+.*-i\b/,		// sed in-place edit
	/\bawk\s+.*-i\b/,		// awk in-place (gawk)
	/\bperl\s+-i\b/,		// perl in-place edit
	/\bchmod\b/,
	/\bchown\b/,
	/\bmv\b/,
	/\bcp\b/,
	/\binstall\b/,
	/\bln\s+-[sf]/,			// symlink force
	/\btruncate\b/,
	/\bgit\s+(push|merge|rebase|reset|checkout|stash\s+drop|clean|cherry-pick|revert|bisect)/,
];

// Commands that are allowed without path checking (non-destructive, no file writes)
const ALLOWED_COMMAND_PATTERNS = [
	...SAFE_BASH_PATTERNS,
	/^\s*sed\b(?!.*-i)/,		// sed without -i (stdout only)
	/^\s*awk\b(?!.*-i)/,		// awk without -i
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*cut\b/,
	/^\s*tr\b/,
	/^\s*xargs\b/,
	/^\s*pipe\b/,
	/^\s*jq\b/,
	/^\s*yq\b/,
	/^\s*diff\b/,
	/^\s*tree\b/,
	/^\s*wc\b/,
	/^\s*basename\b/,
	/^\s*dirname\b/,
	/^\s*realpath\b/,
	/^\s*readlink\b/,
	/^\s*seq\b/,
	/^\s*date\b/,
	/^\s*sleep\b/,
	/^\s*true\b/,
	/^\s*false\b/,
	/^\s*test\b/,
	/^\s*\[\s/,
	/^\s*printf\b/,
];

// Interpreted languages that can do anything — always restricted
// Note: npm/npx/pnpm are NOT here — they're package managers handled by SAFE_BASH_PATTERNS
const INTERPRETER_PATTERNS = [
	/^\s*node\b/,
	/^\s*python[23]?\b/,
	/^\s*bun\b(?!\s+run\b)/,	// bun run is fine, bare bun or bun -e is restricted
	/^\s*deno\b/,
	/^\s*ruby\b/,
	/^\s*perl\b/,
	/^\s*php\b/,
	/^\s*lua\b/,
];

// Paths that are ALWAYS blocked, even within cwd. Cannot be overridden.
// These would break the system or cause irrecoverable damage.
const HARDFORBIDDEN_PATHS = [
	/\b\.git\b/,				// git repo integrity
	/\b\.gitignore$/,		// project config
	/\b\.ssh\//,				// SSH keys
	/\bSystem\/Library\b/,	// macOS system
	/\b\/usr\//,				// Unix system
	/\b\/bin\//,				// system binaries
	/\b\/sbin\//,
	/\b\/etc\//,
	/\b\/var\//,
	/\b\/System\//,
	/\b\/Applications\//,
	/\b\/Library\//,
	/\b\/Users\/dom\/Library\//,
	/\b\.pi\/agent\/extensions\/index\.ts$/,	// don't nuke own extensions
];

// ─── Path helpers ───────────────────────────────────────────────────

export function isHardForbidden(filePath: string): boolean {
	const expanded = expandTilde(filePath);
	const resolved = resolve(expanded);
	return HARDFORBIDDEN_PATHS.some((p) => p.test(resolved));
}

export function isWithinBase(filePath: string, base: string): boolean {
	const expanded = expandTilde(filePath);
	const resolved = resolve(base, expanded);
	const resolvedBase = resolve(base);
	return resolved === resolvedBase
		|| resolved.startsWith(resolvedBase + sep)
		|| resolved.startsWith(resolvedBase + "/");
}

export function isWithinAllowed(filePath: string, allowed: string[]): boolean {
	const expanded = expandTilde(filePath);
	for (const allowPath of allowed) {
		const resolved = resolve(expanded);
		const resolvedAllow = resolve(allowPath);
		if (resolved === resolvedAllow
			|| resolved.startsWith(resolvedAllow + sep)
			|| resolved.startsWith(resolvedAllow + "/")) {
			return true;
		}
	}
	return false;
}

export function isHomeDirectory(filePath: string): boolean {
	const expanded = expandTilde(filePath);
	const home = homedir();
	const resolved = resolve(expanded);
	return resolved === home
		|| resolved.startsWith(home + sep)
		|| resolved.startsWith(home + "/");
}

export function isBashCommandRestricted(command: string): boolean {
	// Interpreted languages (node, python, bun, etc.) can do anything — always restrict
	if (INTERPRETER_PATTERNS.some((p) => p.test(command))) {
		return true;
	}
	// If explicitly destructive, always restricted
	if (DESTRUCTIVE_BASH_PATTERNS.some((p) => p.test(command))) {
		return true;
	}
	// If explicitly allowed (read-only), not restricted
	if (ALLOWED_COMMAND_PATTERNS.some((p) => p.test(command))) {
		return false;
	}
	// Unknown commands: restricted by default (safe-by-default)
	return true;
}

export function extractPathsFromBash(command: string): string[] {
	const paths: string[] = [];

	// Redirect targets: > file, >> file
	const redirectMatches = command.matchAll(/>>?\s*(["']?)([^\s;|&"']+)\1/g);
	for (const m of redirectMatches) {
		paths.push(m[2]);
	}

	// Detect recursive delete flag
	const isRecursiveDelete = /\brm\b/.test(command) && /-[rfRp]+/.test(command);

	// Commands where ONLY the last argument is the destination (cp, mv, ln, install)
	const lastArgCommands = /^\s*(?:cp|mv|ln|install)\b/;
	if (lastArgCommands.test(command)) {
		const tokens = command.trim().split(/\s+/);
		const lastToken = tokens[tokens.length - 1];
		if (lastToken && !lastToken.startsWith("-")) {
			paths.push(expandTilde(lastToken));
		}
	}

	// Commands where all arguments are targets (rm, chmod, chown, truncate)
	const allArgCommands = /^\s*(?:rm|chmod|chown|truncate)\b/;
	if (allArgCommands.test(command)) {
		const matches = command.matchAll(/(?:rm|chmod|chown|truncate)\s+(?:-[a-zA-Z]+\s+)*([^\s;|&>]+)/g);
		for (const m of matches) {
			if (m[1] && !m[1].startsWith("-")) {
				const expanded = expandTilde(m[1]);
				if (isRecursiveDelete) {
					paths.push("__RECURSIVE__:" + expanded);
				} else {
					paths.push(expanded);
				}
			}
		}
	}

	// sed -i, perl -i — target file
	const inplacePatterns = [
		/sed\s+[^']*-i\s*(?:[^\s]*\s+)?(?:--\s+)?([^\s;|&>]+)/g,
		/perl\s+-i\s+(?:[^\s]*\s+)*([^\s;|&>]+)/g,
	];
	for (const pattern of inplacePatterns) {
		const matches = command.matchAll(pattern);
		for (const m of matches) {
			if (m[1] && !m[1].startsWith("-")) {
				paths.push(expandTilde(m[1]));
			}
		}
	}

	return paths;
}
