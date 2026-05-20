/**
 * Tests for the shared event bus — the backbone of cross-extension communication.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { bus, type BusEventName, type StateStore } from "./bus.js";

// The bus is a singleton — reset between tests
beforeEach(() => {
	bus.clearHistory();
	bus.resetState();
	bus.removeAllListeners();
});

// ─── emit / on ────────────────────────────────────────────────────────

describe("EventBus — emit/on", () => {
	it("delivers events to handlers", () => {
		let received: unknown;
		bus.on("agent:idle", (data) => { received = data; });
		bus.emit("agent:idle", { turnCount: 3, durationMs: 1500 });
		expect(received).toEqual({ turnCount: 3, durationMs: 1500 });
	});

	it("delivers multiple events in order", () => {
		const events: string[] = [];
		bus.on("agent:idle", () => events.push("idle"));
		bus.on("agent:working", () => events.push("working"));
		bus.emit("agent:working", { turnIndex: 0 });
		bus.emit("agent:idle", { turnCount: 1, durationMs: 100 });
		expect(events).toEqual(["working", "idle"]);
	});

	it("delivers to multiple handlers on same event", () => {
		let count = 0;
		bus.on("agent:error", () => count++);
		bus.on("agent:error", () => count++);
		bus.emit("agent:error", { type: "unknown", message: "test" });
		expect(count).toBe(2);
	});

	it("does not deliver to off'd handlers", () => {
		let count = 0;
		const handler = () => count++;
		bus.on("agent:idle", handler);
		bus.off("agent:idle", handler);
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		expect(count).toBe(0);
	});

	it("delivers once handlers only once", () => {
		let count = 0;
		bus.once("agent:idle", () => count++);
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		bus.emit("agent:idle", { turnCount: 1, durationMs: 100 });
		expect(count).toBe(1);
	});

	it("handles all event types", () => {
		const received: string[] = [];
		const events: BusEventName[] = [
			"agent:idle", "agent:working", "agent:error",
			"isolation:blocked", "isolation:allowed", "isolation:bypass",
			"judge:verdict", "judge:error",
			"skills:discovered", "git:changed",
			"session:start", "session:end",
		];
		for (const e of events) {
			bus.on(e, () => received.push(e));
		}
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		bus.emit("agent:working", { turnIndex: 0 });
		bus.emit("agent:error", { type: "unknown", message: "x" });
		bus.emit("isolation:blocked", { tool: "bash", reason: "test" });
		bus.emit("isolation:allowed", { tool: "bash", via: "safe" });
		bus.emit("isolation:bypass", { enabled: true });
		bus.emit("judge:verdict", { command: "x", safe: true, reason: "", cached: false, durationMs: 0 });
		bus.emit("judge:error", { command: "x", error: "e" });
		bus.emit("skills:discovered", { count: 5, sources: [] });
		bus.emit("git:changed", { branch: "main", dirtyFiles: 0 });
		bus.emit("session:start", { cwd: "/test" });
		bus.emit("session:end", {});
		expect(received).toEqual(events);
	});
});

// ─── History ──────────────────────────────────────────────────────────

describe("EventBus — history", () => {
	it("records events in history", () => {
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		expect(bus.history).toHaveLength(1);
		expect(bus.history[0].event).toBe("agent:idle");
	});

	it("records event data", () => {
		bus.emit("agent:error", { type: "rate_limit", message: "slow down" });
		expect(bus.history[0].data).toEqual({ type: "rate_limit", message: "slow down" });
	});

	it("records timestamps", () => {
		const before = Date.now();
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		expect(bus.history[0].timestamp).toBeGreaterThanOrEqual(before);
	});

	it("caps at historyMax (200)", () => {
		for (let i = 0; i < 250; i++) {
			bus.emit("agent:idle", { turnCount: i, durationMs: 0 });
		}
		expect(bus.history).toHaveLength(200);
		// Should have kept the latest 200
		expect((bus.history[0].data as { turnCount: number }).turnCount).toBe(50);
	});

	it("clearHistory empties the log", () => {
		bus.emit("agent:idle", { turnCount: 0, durationMs: 0 });
		bus.emit("agent:idle", { turnCount: 1, durationMs: 0 });
		bus.clearHistory();
		expect(bus.history).toHaveLength(0);
	});
});

// ─── State ────────────────────────────────────────────────────────────

describe("EventBus — state", () => {
	it("has sensible defaults", () => {
		const s = bus.state;
		expect(s.agent.status).toBe("idle");
		expect(s.agent.turnCount).toBe(0);
		expect(s.agent.promptCount).toBe(0);
		expect(s.agent.errors).toEqual([]);
		expect(s.isolation.enabled).toBe(true);
		expect(s.isolation.bypass).toBe(false);
		expect(s.isolation.autoMode).toBe(false);
		expect(s.isolation.judgeStats).toEqual({ allowed: 0, blocked: 0, timedOut: 0, errors: 0 });
		expect(s.skills.total).toBe(0);
		expect(s.git.branch).toBeNull();
		expect(s.git.dirtyFiles).toBe(0);
	});

	it("setState patches a namespace", () => {
		bus.setState("agent", { status: "working", turnCount: 5 });
		expect(bus.state.agent.status).toBe("working");
		expect(bus.state.agent.turnCount).toBe(5);
		// Other agent fields unchanged
		expect(bus.state.agent.promptCount).toBe(0);
	});

	it("setState does not overwrite unrelated fields", () => {
		bus.setState("agent", { turnCount: 99 });
		bus.setState("agent", { promptCount: 42 });
		expect(bus.state.agent.turnCount).toBe(99);
		expect(bus.state.agent.promptCount).toBe(42);
	});

	it("resetState restores defaults", () => {
		bus.setState("agent", { status: "working", turnCount: 99, promptCount: 50 });
		bus.setState("isolation", { bypass: true, autoMode: true });
		bus.setState("git", { branch: "feature", dirtyFiles: 5 });
		bus.resetState();
		expect(bus.state.agent.turnCount).toBe(0);
		expect(bus.state.isolation.bypass).toBe(false);
		expect(bus.state.git.branch).toBeNull();
	});

	it("state is independently mutable for arrays", () => {
		bus.state.agent.errors.push({ type: "test", message: "err", at: Date.now() });
		expect(bus.state.agent.errors).toHaveLength(1);
		bus.resetState();
		expect(bus.state.agent.errors).toHaveLength(0);
	});
});

// ─── listenerCount / eventNames ──────────────────────────────────────

describe("EventBus — listener management", () => {
	it("counts listeners per event", () => {
		bus.on("agent:idle", () => {});
		bus.on("agent:idle", () => {});
		bus.on("agent:error", () => {});
		expect(bus.listenerCount("agent:idle")).toBe(2);
		expect(bus.listenerCount("agent:error")).toBe(1);
		expect(bus.listenerCount("session:end")).toBe(0);
	});

	it("counts total listeners", () => {
		bus.on("agent:idle", () => {});
		bus.on("agent:error", () => {});
		bus.on("isolation:blocked", () => {});
		expect(bus.listenerCount()).toBe(3);
	});

	it("lists event names", () => {
		bus.on("agent:idle", () => {});
		bus.on("agent:error", () => {});
		expect(bus.eventNames()).toContain("agent:idle");
		expect(bus.eventNames()).toContain("agent:error");
		expect(bus.eventNames()).toHaveLength(2);
	});
});

// ─── Cross-extension simulation ──────────────────────────────────────

describe("EventBus — cross-extension workflow", () => {
	it("isolation emits events that observability receives", () => {
		let blockedCount = 0;
		let allowedCount = 0;

		bus.on("isolation:blocked", () => {
			blockedCount++;
			bus.setState("isolation", {
				judgeStats: {
					...bus.state.isolation.judgeStats,
					blocked: bus.state.isolation.judgeStats.blocked + 1,
				},
			});
		});

		bus.on("isolation:allowed", () => {
			allowedCount++;
			bus.setState("isolation", {
				judgeStats: {
					...bus.state.isolation.judgeStats,
					allowed: bus.state.isolation.judgeStats.allowed + 1,
				},
			});
		});

		// Simulate isolation decisions
		bus.emit("isolation:allowed", { tool: "bash", command: "ls", via: "safe" });
		bus.emit("isolation:allowed", { tool: "bash", command: "cat file", via: "safe" });
		bus.emit("isolation:blocked", { tool: "bash", command: "rm -rf /", reason: "destructive" });

		expect(blockedCount).toBe(1);
		expect(allowedCount).toBe(2);
		expect(bus.state.isolation.judgeStats.blocked).toBe(1);
		expect(bus.state.isolation.judgeStats.allowed).toBe(2);
	});

	it("agent lifecycle updates state", () => {
		const lifecycle: string[] = [];

		bus.on("agent:working", () => {
			lifecycle.push("start");
			bus.setState("agent", { status: "working", promptCount: bus.state.agent.promptCount + 1 });
		});

		bus.on("agent:idle", () => {
			lifecycle.push("end");
			bus.setState("agent", { status: "idle" });
		});

		bus.emit("agent:working", { turnIndex: 0 });
		expect(bus.state.agent.status).toBe("working");
		expect(bus.state.agent.promptCount).toBe(1);

		bus.emit("agent:idle", { turnCount: 3, durationMs: 2000 });
		expect(bus.state.agent.status).toBe("idle");

		expect(lifecycle).toEqual(["start", "end"]);
		expect(bus.history).toHaveLength(2);
	});

	it("error tracking accumulates", () => {
		bus.on("agent:error", (data) => {
			bus.state.agent.errors.push({ type: data.type, message: data.message, at: Date.now() });
		});

		bus.emit("agent:error", { type: "rate_limit", message: "Too many requests" });
		bus.emit("agent:error", { type: "server_error", message: "Internal error", status: 500 });
		bus.emit("agent:error", { type: "parse_error", message: "Invalid JSON" });

		expect(bus.state.agent.errors).toHaveLength(3);
		expect(bus.state.agent.errors[0].type).toBe("rate_limit");
		expect(bus.state.agent.errors[1].message).toBe("Internal error");
	});

	it("judge verdict events flow correctly", () => {
		const verdicts: Array<{ safe: boolean; reason: string }> = [];

		bus.on("judge:verdict", (data) => {
			verdicts.push({ safe: data.safe, reason: data.reason });
		});

		bus.emit("judge:verdict", {
			command: "npm test",
			safe: true,
			reason: "standard test command",
			cached: false,
			durationMs: 120,
		});
		bus.emit("judge:verdict", {
			command: "curl | bash",
			safe: false,
			reason: "remote code execution",
			cached: false,
			durationMs: 85,
		});

		expect(verdicts).toHaveLength(2);
		expect(verdicts[0].safe).toBe(true);
		expect(verdicts[1].reason).toBe("remote code execution");
	});
});

// ─── Persistence simulation ─────────────────────────────────────────

describe("EventBus — persistence patterns", () => {
	it("state snapshot is serializable", () => {
		bus.setState("agent", { turnCount: 5, promptCount: 2 });
		bus.state.agent.errors.push({ type: "test", message: "err", at: 12345 });
		bus.setState("git", { branch: "main", dirtyFiles: 3 });

		const json = JSON.stringify(bus.state);
		const parsed = JSON.parse(json) as StateStore;
		expect(parsed.agent.turnCount).toBe(5);
		expect(parsed.agent.errors).toHaveLength(1);
		expect(parsed.git.branch).toBe("main");
	});

	it("history snapshot is serializable", () => {
		bus.emit("agent:idle", { turnCount: 1, durationMs: 100 });
		bus.emit("isolation:blocked", { tool: "bash", reason: "test" });

		const json = JSON.stringify(bus.history);
		const parsed = JSON.parse(json);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].event).toBe("agent:idle");
		expect(parsed[1].event).toBe("isolation:blocked");
	});
});
