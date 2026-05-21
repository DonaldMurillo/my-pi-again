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
const piAgentRoot = join(homedir(), ".pi", "agent");
const extensionsDest = join(piAgentRoot, "extensions");

const dryRun = process.argv.includes("--dry-run");

if (dryRun) console.log("[DRY RUN] No files will be written.\n");

async function syncExtensions() {
	if (!existsSync(extensionsSrc)) {
		console.error("No extensions/ directory found.");
		process.exit(1);
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
}

syncExtensions().catch((err) => {
	console.error("Sync failed:", err);
	process.exit(1);
});
