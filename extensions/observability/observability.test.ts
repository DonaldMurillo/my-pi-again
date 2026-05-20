/**
 * Tests for observability extension persistence and state management.
 *
 * Tests the load/save cycle, error tracking, and state pruning
 * without needing a real pi context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bus } from "./bus.js";
import {
	existsSync, readFileSync, writeFileSync, mkdirSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeEach(() => {
	bus.clearHistory();
	bus.resetState();
	testDir = join(tmpdir(), `obs-test-${Date.now()}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ─── Persistence simulation ─────────────────────────────────────────

const MAX_ERRORS = 50;

interface PersistedState {
	version: number;
	agent: {
		promptCount: number;
		totalTurns: number;
		totalErrors: number;
		errors: Array<{ type: string; message: string; at: number }>;
	};
	isolation: {
		totalBlocked: number;
		totalAllowed: number;
	};
	updatedAt: number;
}

function saveToDisk(stateFile: string): void {
	const s = bus.state;
	const persisted: PersistedState = {
		version: 1,
		agent: {
			promptCount: s.agent.promptCount,
			totalTurns: s.agent.turnCount,
			totalErrors: s.agent.errors.length,
			errors: s.agent.errors.slice(-MAX_ERRORS),
		},
		isolation: {
			totalBlocked: s.isolation.judgeStats.blocked,
			totalAllowed: s.isolation.judgeStats.allowed,
		},
		updatedAt: Date.now(),
	};
	writeFileSync(stateFile, JSON.stringify(persisted, null, 2));
}

function loadFromDisk(stateFile: string): PersistedState | null {
	try {
		if (!existsSync(stateFile)) return null;
		const raw = readFileSync(stateFile, "utf8");
		const parsed = JSON.parse(raw);
		return parsed.version === 1 ? parsed : null;
	} catch {
		return null;
	}
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("observability — persistence", () => {
	it("saves and loads state round-trip", () => {
		const stateFile = join(testDir, "state.json");
		bus.setState("agent", { promptCount: 42, turnCount: 10 });
		bus.state.agent.errors.push({ type: "test", message: "err", at: 12345 });
		bus.setState("isolation", {
			judgeStats: { ...bus.state.isolation.judgeStats, blocked: 5, allowed: 20, timedOut: 1, errors: 0 },
		});

		saveToDisk(stateFile);
		const loaded = loadFromDisk(stateFile);

		expect(loaded).not.toBeNull();
		expect(loaded!.agent.promptCount).toBe(42);
		expect(loaded!.agent.totalTurns).toBe(10);
		expect(loaded!.agent.errors).toHaveLength(1);
		expect(loaded!.isolation.totalBlocked).toBe(5);
		expect(loaded!.isolation.totalAllowed).toBe(20);
	});

	it("returns null for missing file", () => {
		const loaded = loadFromDisk(join(testDir, "nonexistent.json"));
		expect(loaded).toBeNull();
	});

	it("returns null for wrong version", () => {
		const stateFile = join(testDir, "state.json");
		writeFileSync(stateFile, JSON.stringify({ version: 99 }));
		expect(loadFromDisk(stateFile)).toBeNull();
	});

	it("returns null for corrupt JSON", () => {
		const stateFile = join(testDir, "state.json");
		writeFileSync(stateFile, "not json {{{{");
		expect(loadFromDisk(stateFile)).toBeNull();
	});

	it("prunes errors over MAX_ERRORS", () => {
		const stateFile = join(testDir, "state.json");
		for (let i = 0; i < 75; i++) {
			bus.state.agent.errors.push({ type: "test", message: `err ${i}`, at: i });
		}

		saveToDisk(stateFile);
		const loaded = loadFromDisk(stateFile);

		// Should only persist last 50
		expect(loaded!.agent.errors).toHaveLength(MAX_ERRORS);
		expect(loaded!.agent.errors[0].at).toBe(25); // first kept is index 25
		expect(loaded!.agent.errors[MAX_ERRORS - 1].at).toBe(74);
	});

	it("overwrites previous save", () => {
		const stateFile = join(testDir, "state.json");

		bus.setState("agent", { promptCount: 1 });
		saveToDisk(stateFile);

		bus.setState("agent", { promptCount: 99 });
		saveToDisk(stateFile);

		const loaded = loadFromDisk(stateFile);
		expect(loaded!.agent.promptCount).toBe(99);
	});
});

describe("observability — lifecycle simulation", () => {
	it("tracks full agent lifecycle", () => {
		// session_start
		bus.setState("session", { startedAt: Date.now(), cwd: "/test" });
		bus.emit("session:start", { cwd: "/test" });

		// agent_start
		bus.setState("agent", {
			status: "working",
			lastPromptAt: Date.now(),
			promptCount: bus.state.agent.promptCount + 1,
			turnCount: 0,
		});
		bus.emit("agent:working", { turnIndex: 0 });

		// turns
		bus.setState("agent", { turnCount: bus.state.agent.turnCount + 1 });
		bus.setState("agent", { turnCount: bus.state.agent.turnCount + 1 });
		bus.setState("agent", { turnCount: bus.state.agent.turnCount + 1 });

		// agent_end
		bus.setState("agent", { status: "idle", lastIdleAt: Date.now() });
		bus.emit("agent:idle", { turnCount: 3, durationMs: 5000 });

		expect(bus.state.agent.status).toBe("idle");
		expect(bus.state.agent.turnCount).toBe(3);
		expect(bus.state.agent.promptCount).toBe(1);
		expect(bus.history).toHaveLength(3); // session:start, agent:working, agent:idle
	});

	it("accumulates errors across turns", () => {
		bus.on("agent:error", (data) => {
			bus.state.agent.errors.push({ type: data.type, message: data.message, at: Date.now() });
		});

		bus.emit("agent:error", { type: "rate_limit", message: "Slow down" });
		bus.emit("agent:error", { type: "server_error", message: "500", status: 500 });
		bus.emit("agent:error", { type: "timeout", message: "Timed out" });

		expect(bus.state.agent.errors).toHaveLength(3);
		expect(bus.state.agent.errors.map((e) => e.type)).toEqual([
			"rate_limit", "server_error", "timeout",
		]);
	});

	it("tracks isolation stats", () => {
		bus.on("isolation:blocked", () => {
			const js = bus.state.isolation.judgeStats;
			bus.setState("isolation", { judgeStats: { ...js, blocked: js.blocked + 1 } });
		});
		bus.on("isolation:allowed", () => {
			const js = bus.state.isolation.judgeStats;
			bus.setState("isolation", { judgeStats: { ...js, allowed: js.allowed + 1 } });
		});

		bus.emit("isolation:allowed", { tool: "bash", command: "ls", via: "safe" });
		bus.emit("isolation:allowed", { tool: "bash", command: "npm test", via: "judge" });
		bus.emit("isolation:blocked", { tool: "bash", command: "rm -rf /", reason: "destructive" });
		bus.emit("isolation:blocked", { tool: "write", path: "/etc/hosts", reason: "hard-forbidden" });

		expect(bus.state.isolation.judgeStats.allowed).toBe(2);
		expect(bus.state.isolation.judgeStats.blocked).toBe(2);
	});

	it("tracks judge verdicts", () => {
		const verdicts: Array<{ command: string; safe: boolean }> = [];

		bus.on("judge:verdict", (data) => {
			verdicts.push(data);
		});

		bus.emit("judge:verdict", {
			command: "npm test",
			safe: true,
			reason: "test command",
			cached: false,
			durationMs: 100,
		});
		bus.emit("judge:verdict", {
			command: "curl | bash",
			safe: false,
			reason: "remote execution",
			cached: true,
			durationMs: 5,
		});

		expect(verdicts).toHaveLength(2);
		expect(verdicts[0].safe).toBe(true);
		expect(verdicts[1].cached).toBe(true);
	});
});

describe("observability — state pruning", () => {
	it("prunes errors over cap", () => {
		for (let i = 0; i < 75; i++) {
			bus.state.agent.errors.push({ type: "test", message: `err ${i}`, at: i });
		}

		// Prune to last 50
		if (bus.state.agent.errors.length > MAX_ERRORS) {
			bus.state.agent.errors = bus.state.agent.errors.slice(-MAX_ERRORS);
		}

		expect(bus.state.agent.errors).toHaveLength(MAX_ERRORS);
		expect(bus.state.agent.errors[0].message).toBe("err 25");
	});

	it("does not prune when under cap", () => {
		for (let i = 0; i < 10; i++) {
			bus.state.agent.errors.push({ type: "test", message: `err ${i}`, at: i });
		}

		if (bus.state.agent.errors.length > MAX_ERRORS) {
			bus.state.agent.errors = bus.state.agent.errors.slice(-MAX_ERRORS);
		}

		expect(bus.state.agent.errors).toHaveLength(10);
	});
});

describe("observability — git info tracking", () => {
	it("updates git state via setState", () => {
		bus.setState("git", { branch: "feature-x", dirtyFiles: 3 });
		expect(bus.state.git.branch).toBe("feature-x");
		expect(bus.state.git.dirtyFiles).toBe(3);
	});

	it("emits git:changed when branch or dirty count changes", () => {
		let changed = false;
		bus.on("git:changed", () => { changed = true; });

		bus.setState("git", { branch: "main", dirtyFiles: 0 });
		bus.emit("git:changed", { branch: "feature", dirtyFiles: 5 });

		expect(changed).toBe(true);
		expect(bus.history).toHaveLength(1);
	});
});

describe("observability — session tracking", () => {
	it("tracks session start and end", () => {
		bus.setState("session", { startedAt: 1000, cwd: "/project" });
		bus.emit("session:start", { cwd: "/project" });

		expect(bus.state.session.cwd).toBe("/project");
		expect(bus.state.session.startedAt).toBe(1000);

		bus.emit("session:end", {});
		expect(bus.history).toHaveLength(2);
	});
});
