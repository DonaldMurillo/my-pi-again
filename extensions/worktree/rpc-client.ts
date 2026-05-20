/**
 * RPC client for a persistent pi subprocess.
 *
 * Spawns `pi --mode rpc` in a target directory and provides
 * bidirectional communication: send prompts, stream events,
 * handle extension UI requests.
 *
 * Used by the worktree extension to run isolated agents in
 * git worktrees while the main session coordinates.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	error?: string;
	data?: unknown;
}

export interface AgentMessage {
	role: string;
	content: Array<{ type: string; text?: string; thinking?: string; [key: string]: unknown }>;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { total: number; [key: string]: unknown };
	};
	stopReason?: string;
}

export type EventHandler = (event: RpcEvent) => void;
export type UIRequestHandler = (request: RpcEvent & { method: string; id: string }) => Promise<unknown>;

export interface AgentStatus {
	state: "starting" | "idle" | "working" | "error" | "dead";
	lastPromptAt: number | null;
	lastResponseAt: number | null;
	turnCount: number;
	totalCost: number;
	error: string | null;
}

// ─── Client ──────────────────────────────────────────────────────────

export class RpcClient {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private pendingResponses = new Map<string, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 0;
	private eventHandlers: EventHandler[] = [];
	private uiRequestHandler: UIRequestHandler | null = null;
	private _status: AgentStatus;
	private dead = false;

	constructor(
		public readonly worktreePath: string,
		public readonly branch: string,
		public readonly purpose: string,
	) {
		this._status = {
			state: "starting",
			lastPromptAt: null,
			lastResponseAt: null,
			turnCount: 0,
			totalCost: 0,
			error: null,
		};
	}

	get status(): Readonly<AgentStatus> {
		return this._status;
	}

	get pid(): number | undefined {
		return this.proc?.pid;
	}

	// ── Lifecycle ──

	async start(): Promise<void> {
		if (this.proc || this.dead) return;

		// Create a named session for this worktree agent
		const sessionDir = join(homedir(), ".pi", "worktree-sessions");
		if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

		const proc = spawn("pi", [
			"--mode", "rpc",
			"--session-dir", sessionDir,
		], {
			cwd: this.worktreePath,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.proc = proc;

		proc.stdout!.on("data", (chunk: Buffer | string) => {
			this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
			this.drainBuffer();
		});

		proc.stderr!.on("data", (chunk: Buffer | string) => {
			// Ignore stderr noise
		});

		proc.on("exit", (code) => {
			this._status = { ...this._status, state: "dead", error: code ? `Exit code ${code}` : null };
			this.proc = null;
			this.dead = true;
			// Reject all pending
			for (const [, p] of this.pendingResponses) {
				p.reject(new Error("Process exited"));
			}
			this.pendingResponses.clear();
		});

		proc.on("error", (err) => {
			this._status = { ...this._status, state: "error", error: err.message };
			this.dead = true;
		});

		// Set session name
		await this.sendCommand("set_session_name", { name: `wt:${this.branch}` });

		this._status = { ...this._status, state: "idle" };
	}

	private drainBuffer(): void {
		while (true) {
			const nl = this.buffer.indexOf("\n");
			if (nl === -1) break;

			let line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;

			try {
				const event = JSON.parse(line) as RpcEvent;
				this.handleEvent(event);
			} catch {
				// Ignore parse errors
			}
		}
	}

	private handleEvent(event: RpcEvent): void {
		// Handle responses
		if (event.type === "response" && event.id) {
			const pending = this.pendingResponses.get(event.id as string);
			if (pending) {
				this.pendingResponses.delete(event.id as string);
				(event as RpcResponse).success ? pending.resolve(event as RpcResponse) : pending.reject(new Error((event as RpcResponse).error ?? "Unknown error"));
			}
			return;
		}

		// Handle extension UI requests
		if (event.type === "extension_ui_request" && event.id && event.method) {
			this.handleUIRequest(event as RpcEvent & { method: string; id: string });
			return;
		}

		// Update status based on event type
		switch (event.type) {
			case "agent_start":
				this._status = { ...this._status, state: "working", lastPromptAt: Date.now() };
				break;
			case "agent_end": {
				const msgs = (event as { messages: AgentMessage[] }).messages ?? [];
				const lastAssistant = msgs.filter((m) => m.role === "assistant").pop();
				if (lastAssistant?.usage?.cost?.total) {
					this._status = { ...this._status, totalCost: this._status.totalCost + lastAssistant.usage.cost.total };
				}
				this._status = { ...this._status, state: "idle", lastResponseAt: Date.now() };
				break;
			}
			case "turn_end":
				this._status = { ...this._status, turnCount: this._status.turnCount + 1 };
				break;
			case "extension_error":
				this._status = { ...this._status, error: (event as { error: string }).error ?? "Extension error" };
				break;
		}

		// Forward to handlers
		for (const handler of this.eventHandlers) {
			try { handler(event); } catch { /* ignore */ }
		}
	}

	private async handleUIRequest(request: RpcEvent & { method: string; id: string }): Promise<void> {
		if (!this.uiRequestHandler) {
			// Auto-respond with defaults
			const defaults: Record<string, unknown> = {
				confirm: { confirmed: false },
				select: { cancelled: true },
				input: { cancelled: true },
				editor: { cancelled: true },
			};
			this.send({ type: "extension_ui_response", id: request.id, ...(defaults[request.method] ?? { cancelled: true }) });
			return;
		}

		try {
			const result = await this.uiRequestHandler(request);
			this.send({ type: "extension_ui_response", id: request.id, ...result });
		} catch {
			this.send({ type: "extension_ui_response", id: request.id, cancelled: true });
		}
	}

	// ── Commands ──

	async prompt(message: string): Promise<RpcResponse> {
		this._status = { ...this._status, state: "working" };
		const resp = await this.sendCommand("prompt", { message });
		if (!resp.success) return resp;

		// Wait for agent_end before resolving so the caller gets the full response
		await new Promise<void>((resolve) => {
			const unsub = this.onEvent((event) => {
				if (event.type === "agent_end") {
					unsub();
					resolve();
				}
			});
		});

		return resp;
	}

	async steer(message: string): Promise<RpcResponse> {
		return this.sendCommand("steer", { message });
	}

	async followUp(message: string): Promise<RpcResponse> {
		return this.sendCommand("follow_up", { message });
	}

	async abort(): Promise<RpcResponse> {
		return this.sendCommand("abort", {});
	}

	async getState(): Promise<RpcResponse> {
		return this.sendCommand("get_state", {});
	}

	async getLastAssistantText(): Promise<string | null> {
		const resp = await this.sendCommand("get_last_assistant_text", {});
		return (resp.data as { text: string | null })?.text ?? null;
	}

	// ── Event subscription ──

	onEvent(handler: EventHandler): () => void {
		this.eventHandlers.push(handler);
		return () => {
			const idx = this.eventHandlers.indexOf(handler);
			if (idx >= 0) this.eventHandlers.splice(idx, 1);
		};
	}

	setUIRequestHandler(handler: UIRequestHandler): void {
		this.uiRequestHandler = handler;
	}

	// ── Transport ──

	private sendCommand(command: string, params: Record<string, unknown>): Promise<RpcResponse> {
		return new Promise((resolve, reject) => {
			if (!this.proc || this.dead) {
				reject(new Error("Agent process is not running"));
				return;
			}
			const id = String(++this.nextId);
			this.pendingResponses.set(id, { resolve, reject });
			this.send({ type: command, id, ...params });

			// Timeout after 5 minutes
			setTimeout(() => {
				if (this.pendingResponses.has(id)) {
					this.pendingResponses.delete(id);
					reject(new Error("Command timed out"));
				}
			}, 300_000);
		});
	}

	private send(obj: Record<string, unknown>): void {
		if (!this.proc?.stdin?.writable) return;
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}

	// ── Cleanup ──

	kill(): void {
		if (this.proc && !this.dead) {
			try {
				this.proc.kill("SIGTERM");
			} catch { /* already dead */ }
		}
		this.dead = true;
		this._status = { ...this._status, state: "dead" };
	}
}
