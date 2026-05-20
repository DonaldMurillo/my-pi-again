/**
 * Shared event bus and state store — no pi dependencies.
 *
 * Other extensions import this directly:
 *   import { bus } from "../observability/bus.js";
 *
 * Singleton — shared across all extensions that import this file.
 */

import { EventEmitter } from "node:events";

// ─── Event types ─────────────────────────────────────────────────────

export interface BusEvents {
	// Agent lifecycle
	"agent:idle": { turnCount: number; durationMs: number };
	"agent:working": { turnIndex: number };
	"agent:error": { type: "rate_limit" | "server_error" | "timeout" | "parse_error" | "unknown"; status?: number; message: string; provider?: string; model?: string };

	// Isolation
	"isolation:blocked": { tool: string; command?: string; path?: string; reason: string };
	"isolation:allowed": { tool: string; command?: string; path?: string; via: "safe" | "cwd" | "hatch" | "judge" };
	"isolation:bypass": { enabled: boolean };
	"judge:verdict": { command: string; safe: boolean; reason: string; cached: boolean; durationMs: number };
	"judge:error": { command: string; error: string };

	// Skills
	"skills:discovered": { count: number; sources: Array<{ label: string; count: number }> };

	// Git
	"git:changed": { branch: string; dirtyFiles: number };

	// Session
	"session:start": { cwd: string };
	"session:end": {};
}

export type BusEventName = keyof BusEvents;
export type BusEventHandler<E extends BusEventName> = (data: BusEvents[E]) => void;

// ─── State store ─────────────────────────────────────────────────────

export interface StateStore {
	agent: {
		status: "idle" | "working";
		turnCount: number;
		lastPromptAt: number | null;
		lastIdleAt: number | null;
		promptCount: number;
		errors: Array<{ type: string; message: string; at: number }>;
	};
	isolation: {
		enabled: boolean;
		bypass: boolean;
		autoMode: boolean;
		judgeStats: { allowed: number; blocked: number; timedOut: number; errors: number };
		lastBlocked: { tool: string; reason: string; at: number } | null;
	};
	skills: {
		total: number;
		sources: Array<{ label: string; count: number }>;
	};
	git: {
		branch: string | null;
		dirtyFiles: number;
	};
	session: {
		startedAt: number;
		cwd: string;
	};
}

function defaultState(): StateStore {
	return {
		agent: { status: "idle", turnCount: 0, lastPromptAt: null, lastIdleAt: null, promptCount: 0, errors: [] },
		isolation: { enabled: true, bypass: false, autoMode: false, judgeStats: { allowed: 0, blocked: 0, timedOut: 0, errors: 0 }, lastBlocked: null },
		skills: { total: 0, sources: [] },
		git: { branch: null, dirtyFiles: 0 },
		session: { startedAt: Date.now(), cwd: "" },
	};
}

// ─── Event history ───────────────────────────────────────────────────

export interface HistoryEntry {
	timestamp: number;
	event: string;
	data: unknown;
}

// ─── Bus ──────────────────────────────────────────────────────────────

class EventBus {
	private emitter = new EventEmitter();
	private _state: StateStore = defaultState();
	private _history: HistoryEntry[] = [];
	private historyMax = 200;

	constructor() {
		this.emitter.setMaxListeners(50);
	}

	emit<E extends BusEventName>(event: E, data: BusEvents[E]): void {
		this._history.push({ timestamp: Date.now(), event, data });
		if (this._history.length > this.historyMax) this._history = this._history.slice(-this.historyMax);
		this.emitter.emit(event, data);
	}

	on<E extends BusEventName>(event: E, handler: BusEventHandler<E>): void {
		this.emitter.on(event, handler);
	}

	off<E extends BusEventName>(event: E, handler: BusEventHandler<E>): void {
		this.emitter.off(event, handler);
	}

	once<E extends BusEventName>(event: E, handler: BusEventHandler<E>): void {
		this.emitter.once(event, handler);
	}

	get state(): StateStore { return this._state; }

	setState<K extends keyof StateStore>(namespace: K, patch: Partial<StateStore[K]>): void {
		this._state[namespace] = { ...this._state[namespace], ...patch };
	}

	resetState(): void { this._state = defaultState(); }

	get history(): ReadonlyArray<HistoryEntry> { return this._history; }
	clearHistory(): void { this._history = []; }

	listenerCount(event?: string): number {
		if (event) return this.emitter.listenerCount(event);
		let total = 0;
		for (const e of this.emitter.eventNames()) total += this.emitter.listenerCount(e as string);
		return total;
	}

	eventNames(): string[] { return this.emitter.eventNames() as string[]; }
}

export const bus = new EventBus();
