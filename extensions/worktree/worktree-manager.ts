/**
 * Worktree manager — git worktree CRUD + agent pool.
 *
 * Manages git worktrees and their associated RPC agents.
 * Tracks metadata (purpose, owner, status) in .pi/worktrees.json.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { RpcClient } from "./rpc-client.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface WorktreeInfo {
	branch: string;
	path: string;
	isCurrent: boolean;
	isMain: boolean;
}

export interface ManagedWorktree {
	branch: string;
	path: string;
	purpose: string;
	createdAt: number;
	agentPid?: number;
}

interface WorktreeMetadata {
	version: number;
	worktrees: ManagedWorktree[];
}

// ─── Git helpers ─────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
}

function gitOrNull(cmd: string, cwd: string): string | null {
	try { return git(cmd, cwd); } catch { return null; }
}

export function getRepoRoot(cwd: string): string | null {
	return gitOrNull("git rev-parse --show-toplevel 2>/dev/null", cwd);
}

export function listWorktrees(cwd: string): WorktreeInfo[] {
	const raw = gitOrNull("git worktree list --porcelain 2>/dev/null", cwd);
	if (!raw) return [];

	const entries: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) entries.push(current as WorktreeInfo);
			current = { path: line.slice(9) };
		} else if (line.startsWith("HEAD ")) {
			// skip
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "detached") {
			current.branch = "(detached)";
		} else if (line === "bare") {
			current.isMain = true;
		}
	}
	if (current.path) entries.push(current as WorktreeInfo);

	// Mark current
	const cwdResolved = resolve(cwd);
	for (const e of entries) {
		e.isCurrent = resolve(e.path) === cwdResolved;
		e.isMain = e.isMain ?? false;
	}

	return entries;
}

// ─── Metadata persistence ────────────────────────────────────────────

function metadataPath(repoRoot: string): string {
	return join(repoRoot, ".pi", "worktrees.json");
}

function loadMetadata(repoRoot: string): WorktreeMetadata {
	const path = metadataPath(repoRoot);
	if (!existsSync(path)) return { version: 1, worktrees: [] };
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as WorktreeMetadata;
	} catch {
		return { version: 1, worktrees: [] };
	}
}

function saveMetadata(repoRoot: string, meta: WorktreeMetadata): void {
	const dir = join(repoRoot, ".pi");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(metadataPath(repoRoot), JSON.stringify(meta, null, 2));
}

// ─── Worktree operations ─────────────────────────────────────────────

export function createWorktree(
	cwd: string,
	branch: string,
	purpose: string,
): { path: string; branch: string; created: boolean } {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) throw new Error("Not inside a git repository");

	// Check if branch exists
	const branchExists = gitOrNull(`git rev-parse --verify ${branch} 2>/dev/null`, cwd) !== null;

	// Create worktree — default parent dir is sibling of repo root
	const parentDir = join(repoRoot, "..");
	const wtPath = join(parentDir, `${basename(repoRoot)}-${branch}`);

	if (existsSync(wtPath)) {
		throw new Error(`Path already exists: ${wtPath}`);
	}

	if (branchExists) {
		git(`git worktree add "${wtPath}" "${branch}"`, cwd);
	} else {
		git(`git worktree add -b "${branch}" "${wtPath}"`, cwd);
	}

	// Save metadata
	const meta = loadMetadata(repoRoot);
	meta.worktrees.push({
		branch,
		path: wtPath,
		purpose,
		createdAt: Date.now(),
	});
	saveMetadata(repoRoot, meta);

	return { path: wtPath, branch, created: !branchExists };
}

export function removeWorktree(cwd: string, branch: string): void {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) throw new Error("Not inside a git repository");

	const meta = loadMetadata(repoRoot);
	const entry = meta.worktrees.find((w) => w.branch === branch);
	if (!entry) throw new Error(`No managed worktree for branch "${branch}"`);

	// Remove git worktree
	try {
		git(`git worktree remove "${entry.path}" --force 2>/dev/null`, cwd);
	} catch {
		// Force remove if dirty
		try { rmSync(entry.path, { recursive: true, force: true }); } catch { /* ignore */ }
		git("git worktree prune", cwd);
	}

	// Remove from metadata
	meta.worktrees = meta.worktrees.filter((w) => w.branch !== branch);
	saveMetadata(repoRoot, meta);
}

export function getManagedWorktrees(cwd: string): ManagedWorktree[] {
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) return [];
	return loadMetadata(repoRoot).worktrees;
}

// ─── Agent pool ──────────────────────────────────────────────────────

const agents = new Map<string, RpcClient>();

export function getAgent(branch: string): RpcClient | undefined {
	return agents.get(branch);
}

export function getAllAgents(): ReadonlyMap<string, RpcClient> {
	return agents;
}

export async function spawnAgent(
	cwd: string,
	branch: string,
	purpose: string,
): Promise<RpcClient> {
	// Kill existing agent for this branch
	const existing = agents.get(branch);
	if (existing) {
		existing.kill();
		agents.delete(branch);
	}

	// Find or create worktree
	const repoRoot = getRepoRoot(cwd);
	if (!repoRoot) throw new Error("Not inside a git repository");

	const meta = loadMetadata(repoRoot);
	let entry = meta.worktrees.find((w) => w.branch === branch);

	if (!entry) {
		// Auto-create worktree
		const result = createWorktree(cwd, branch, purpose);
		entry = meta.worktrees.find((w) => w.branch === branch)!;
	}

	// Spawn RPC client in worktree
	const client = new RpcClient(entry.path, branch, purpose);

	client.onEvent((event) => {
		if (event.type === "agent_end") {
			// Update metadata with pid
			const m = loadMetadata(repoRoot);
			const wt = m.worktrees.find((w) => w.branch === branch);
			if (wt) {
				wt.agentPid = client.pid;
				saveMetadata(repoRoot, m);
			}
		}
	});

	await client.start();

	// Auto-respond to UI requests (no interactive prompts in worktree agents)
	client.setUIRequestHandler(async (req) => {
		// Default: confirm=true, select=first, input=empty
		if (req.method === "confirm") return { confirmed: true };
		if (req.method === "select") {
			const opts = (req as { options?: Array<{ value: string }> }).options;
			return opts?.length ? { value: opts[0].value } : { cancelled: true };
		}
		if (req.method === "input") return { value: "" };
		if (req.method === "editor") return { cancelled: true };
		return { cancelled: true };
	});

	agents.set(branch, client);

	// Update metadata
	const m2 = loadMetadata(repoRoot);
	const wt2 = m2.worktrees.find((w) => w.branch === branch);
	if (wt2) {
		wt2.agentPid = client.pid;
		saveMetadata(repoRoot, m2);
	}

	return client;
}

export function killAgent(branch: string): void {
	const agent = agents.get(branch);
	if (agent) {
		agent.kill();
		agents.delete(branch);
	}
}

export function killAllAgents(): void {
	for (const [, agent] of agents) {
		agent.kill();
	}
	agents.clear();
}
