/**
 * Sync extensions from this repo to ~/.pi/agent/extensions/
 *
 * Usage:
 *   npx tsx scripts/sync.ts          # sync all extensions
 *   npx tsx scripts/sync.ts --dry-run  # preview without writing
 *
 * Copies each directory under extensions/ to ~/.pi/agent/extensions/<name>/
 */

import { cp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const extensionsSrc = join(root, "extensions");
const skillsSrc = join(root, "skills");
const piAgentRoot = join(homedir(), ".pi", "agent");
const extensionsDest = join(piAgentRoot, "extensions");
const skillsDest = join(piAgentRoot, "skills");

const dryRun = process.argv.includes("--dry-run");
const skipSmoke = process.argv.includes("--skip-smoke");

if (dryRun) console.log("[DRY RUN] No files will be written.\n");

async function syncExtensions() {
	if (!existsSync(extensionsSrc)) {
		console.error("No extensions/ directory found.");
		process.exit(1);
	}

	// ── Run smoke tests first ──
	if (!dryRun && !skipSmoke) {
		console.log("Running smoke tests...\n");
		const { execSync } = await import("node:child_process");
		try {
			execSync("npx tsx scripts/smoke-test.ts", { cwd: root, stdio: "inherit" });
		} catch {
			console.error("\n\x1b[31mSmoke tests failed — aborting sync.\x1b[0m");
			process.exit(1);
		}
		console.log("");
	}

	const entries = await readdir(extensionsSrc, { withFileTypes: true });
	const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));

	if (dirs.length === 0) {
		console.log("No extensions to sync.");
		return;
	}

	await mkdir(extensionsDest, { recursive: true });
	let synced = 0;

	for (const dir of dirs) {
		const src = join(extensionsSrc, dir.name);
		const dest = join(extensionsDest, dir.name);

	// Must have index.ts — except shared/ which is a library
		if (dir.name !== "shared" && !existsSync(join(src, "index.ts"))) {
			console.log(`  ⏭  ${dir.name} (no index.ts, skipping)`);
			continue;
		}

		if (dryRun) {
			console.log(`  ✓  ${dir.name} → ${dest}`);
			synced++;
			continue;
		}

		await rm(dest, { recursive: true, force: true });
		await mkdir(dest, { recursive: true });
		await cp(src, dest, { recursive: true, force: true });
		console.log(`  ✓  ${dir.name}`);
		synced++;
	}

	console.log(`\nSynced ${synced} extension${synced !== 1 ? "s" : ""} → ${extensionsDest}`);

	// Write a manifest for traceability
	if (!dryRun) {
		const manifest = {
			updatedAt: new Date().toISOString(),
			source: root,
			extensions: dirs.map((d) => d.name),
		};
		await writeFile(
			join(extensionsDest, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);
		console.log("  → manifest.json written");
	}

	// ── Sync skills ──
	if (existsSync(skillsSrc)) {
		const skillEntries = await readdir(skillsSrc, { withFileTypes: true });
		const skillDirs = skillEntries.filter(
			(e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(skillsSrc, e.name, "SKILL.md")),
		);

		if (skillDirs.length > 0) {
			await mkdir(skillsDest, { recursive: true });
			let skillSynced = 0;

			for (const dir of skillDirs) {
				const src = join(skillsSrc, dir.name);
				const dest = join(skillsDest, dir.name);

				if (dryRun) {
					console.log(`  ✓  skill/${dir.name} → ${dest}`);
					skillSynced++;
					continue;
				}

				await rm(dest, { recursive: true, force: true });
				await mkdir(dest, { recursive: true });
				await cp(src, dest, { recursive: true, force: true });
				console.log(`  ✓  skill/${dir.name}`);
				skillSynced++;
			}

			console.log(`\nSynced ${skillSynced} skill${skillSynced !== 1 ? "s" : ""} → ${skillsDest}`);
		} else {
			console.log("\nNo skills to sync.");
		}
	} else {
		console.log("\nNo skills/ directory found.");
	}
}

syncExtensions().catch((err) => {
	console.error("Sync failed:", err);
	process.exit(1);
});
