/**
 * Shared message bus for inter-agent communication.
 *
 * File-based message queue in .pi/messages/ — no server, no daemon.
 * Any pi process (main session, worktree agents, other terminals) can
 * read/write messages.
 *
 * Channels:
 *   - Each agent gets an inbox at .pi/messages/<name>/
 *   - Broadcast goes to .pi/messages/_broadcast/
 *   - Main session is "hub"
 *
 * Message format:
 *   {
 *     id: string,
 *     from: string,
 *     to: string | "_broadcast",
 *     body: string,
 *     timestamp: number,
 *     read: boolean
 *   }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface Message {
	id: string;
	from: string;
	to: string;
	body: string;
	timestamp: number;
	read: boolean;
}

export interface MessengerConfig {
	messagesDir: string;
	agentName: string;
	pollIntervalMs: number;
	maxMessageAge: number; // ms — prune messages older than this
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_POLL = 2000; // 2s

// ─── Message Bus ─────────────────────────────────────────────────────

export class MessageBus {
	private config: MessengerConfig;
	private watching = false;
	private watchTimer: ReturnType<typeof setInterval> | null = null;
	private handlers: Array<(msg: Message) => void> = [];

	constructor(config: Partial<MessengerConfig> & { messagesDir: string; agentName: string }) {
		this.config = {
			pollIntervalMs: DEFAULT_POLL,
			maxMessageAge: DEFAULT_MAX_AGE,
			...config,
		};
		this.ensureDir(this.inboxDir());
		this.ensureDir(this.config.messagesDir);
	}

	get agentName(): string {
		return this.config.agentName;
	}

	// ── Send ──

	send(to: string, body: string): Message {
		const msg: Message = {
			id: randomUUID(),
			from: this.config.agentName,
			to,
			body,
			timestamp: Date.now(),
			read: false,
		};

		const inbox = to === "_broadcast"
			? join(this.config.messagesDir, "_broadcast")
			: join(this.config.messagesDir, to);

		this.ensureDir(inbox);
		writeFileSync(join(inbox, `${msg.id}.json`), JSON.stringify(msg, null, 2));

		return msg;
	}

	broadcast(body: string): Message {
		return this.send("_broadcast", body);
	}

	// ── Receive ──

	readInbox(): Message[] {
		const inbox = this.inboxDir();
		if (!existsSync(inbox)) return [];

		const messages: Message[] = [];
		const files = readdirSync(inbox).filter((f) => f.endsWith(".json")).sort();

		for (const file of files) {
			try {
				const raw = readFileSync(join(inbox, file), "utf8");
				const msg = JSON.parse(raw) as Message;
				msg.read = true;
				messages.push(msg);
				// Update as read
				writeFileSync(join(inbox, file), JSON.stringify(msg, null, 2));
			} catch {
				// Corrupt file — skip
			}
		}

		return messages;
	}

	readUnread(): Message[] {
		const inbox = this.inboxDir();
		if (!existsSync(inbox)) return [];

		const messages: Message[] = [];
		const files = readdirSync(inbox).filter((f) => f.endsWith(".json")).sort();

		for (const file of files) {
			try {
				const raw = readFileSync(join(inbox, file), "utf8");
				const msg = JSON.parse(raw) as Message;
				if (!msg.read) {
					messages.push(msg);
				}
			} catch {}
		}

		// Mark them as read
		for (const msg of messages) {
			msg.read = true;
			writeFileSync(join(inbox, `${msg.id}.json`), JSON.stringify(msg, null, 2));
		}

		return messages;
	}

	// ── Polling ──

	startPolling(handler: (msg: Message) => void): void {
		if (this.watching) return;
		this.watching = true;
		this.handlers.push(handler);

		// Track last read timestamp to detect new messages
		let lastCount = this.countUnread();

		this.watchTimer = setInterval(() => {
			const currentCount = this.countUnread();
			if (currentCount > lastCount) {
				// Use readUnread which returns AND marks messages
				const unread = this.readUnread();
				for (const msg of unread) {
					for (const h of this.handlers) {
						try { h(msg); } catch { /* ignore */ }
					}
				}
			}
			lastCount = this.countUnread();
		}, this.config.pollIntervalMs);
	}

	stopPolling(): void {
		if (this.watchTimer) {
			clearInterval(this.watchTimer);
			this.watchTimer = null;
		}
		this.watching = false;
	}

	// ── Cleanup ──

	prune(): number {
		let pruned = 0;
		const now = Date.now();

		if (!existsSync(this.config.messagesDir)) return 0;

		// Scan ALL subdirectories (every agent's inbox + _broadcast)
		const dirs = readdirSync(this.config.messagesDir)
			.filter((f) => statSync(join(this.config.messagesDir, f)).isDirectory());

		for (const dir of dirs) {
			const dirPath = join(this.config.messagesDir, dir);
			const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
			for (const file of files) {
				try {
					const raw = readFileSync(join(dirPath, file), "utf8");
					const msg = JSON.parse(raw) as Message;
					if (now - msg.timestamp > this.config.maxMessageAge) {
						unlinkSync(join(dirPath, file));
						pruned++;
					}
				} catch {
					try { unlinkSync(join(dirPath, file)); pruned++; } catch {}
				}
			}
		}

		return pruned;
	}

	clearInbox(): void {
		const inbox = this.inboxDir();
		if (!existsSync(inbox)) return;
		const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try { unlinkSync(join(inbox, file)); } catch {}
		}
	}

	// ── List agents ──

	listAgents(): string[] {
		if (!existsSync(this.config.messagesDir)) return [];
		return readdirSync(this.config.messagesDir)
			.filter((f) => {
				const p = join(this.config.messagesDir, f);
				return statSync(p).isDirectory() && f !== "_broadcast";
			});
	}

	// ── Internals ──

	private inboxDir(): string {
		return join(this.config.messagesDir, this.config.agentName);
	}

	private ensureDir(dir: string): void {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	private countUnread(): number {
		const inbox = this.inboxDir();
		if (!existsSync(inbox)) return 0;
		let count = 0;
		const files = readdirSync(inbox).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			try {
				const raw = readFileSync(join(inbox, file), "utf8");
				const msg = JSON.parse(raw) as Message;
				if (!msg.read) count++;
			} catch {}
		}
		return count;
	}
}
