/**
 * Messenger extension — inter-agent communication via file-based message queue.
 *
 * Provides:
 *   - `messenger` tool — agent can send/receive/broadcast messages
 *   - /messenger command — user can inspect messages and agents
 *   - File-based queue in .pi/messages/ — works across processes
 *   - Auto-polling for new messages (worktree agents check inbox)
 *   - Integrates with worktree extension for cross-agent coordination
 *
 * Usage:
 *   Agent: messenger({ action: "send", to: "feature-auth", body: "auth is done, you can start" })
 *   Agent: messenger({ action: "broadcast", body: "Heads up, switching to main" })
 *   Agent: messenger({ action: "inbox" })
 *   Agent: messenger({ action: "agents" })
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { MessageBus, type Message } from "./message-bus.js";
import { join } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI): void {
	let bus: MessageBus | null = null;

	function getBus(ctx: ExtensionContext): MessageBus {
		if (!bus) {
			bus = new MessageBus({
				messagesDir: join(ctx.cwd, ".pi", "messages"),
				agentName: "hub",
			});
		}
		return bus;
	}

	// ── Tool: messenger ─────────────────────────────────────────────────

	pi.registerTool({
		name: "messenger",
		label: "Messenger",
		description:
			"Send messages between agents (main session, worktree agents, other terminals). " +
			"Actions: send (message to specific agent), broadcast (to all), inbox (read your messages), " +
			"agents (list known agents), clear (clear inbox). " +
			"Use this to coordinate work across parallel agents.",
		parameters: Type.Object({
			action: StringEnum(["send", "broadcast", "inbox", "agents", "clear"] as const, {
				description: "Action to perform",
			}),
			to: Type.Optional(Type.String({
				description: "Recipient agent name (for send)",
			})),
			body: Type.Optional(Type.String({
				description: "Message body (for send/broadcast)",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const b = getBus(ctx);

			switch (params.action) {
				case "send": {
					const to = params.to?.trim();
					const body = params.body?.trim();
					if (!to) return err("to is required for send");
					if (!body) return err("body is required for send");
					const msg = b.send(to, body);
					return ok(`Message sent to "${to}" (id: ${msg.id})`);
				}

				case "broadcast": {
					const body = params.body?.trim();
					if (!body) return err("body is required for broadcast");
					const msg = b.broadcast(body);
					return ok(`Broadcast sent (id: ${msg.id})`);
				}

				case "inbox": {
					const messages = b.readInbox();
					if (messages.length === 0) {
						return ok("No messages in inbox.");
					}
					const lines = messages.map((m) => {
						const ago = ((Date.now() - m.timestamp) / 1000).toFixed(0);
						const read = m.read ? "read" : "unread";
						return `[${read}] from:${m.from} (${ago}s ago) — ${m.body}`;
					});
					return ok(`# Inbox (${messages.length})\n\n${lines.join("\n")}`);
				}

				case "agents": {
					const agents = b.listAgents();
					if (agents.length === 0) {
						return ok("No agents registered yet. Agents appear once they send/receive a message.");
					}
					return ok(`# Known Agents\n\n${agents.map((a) => `- ${a}`).join("\n")}`);
				}

				case "clear": {
					b.clearInbox();
					return ok("Inbox cleared.");
				}

				default:
					return err(`Unknown action: ${params.action}`);
			}
		},
	});

	// ── Command: /messenger ─────────────────────────────────────────────

	pi.registerCommand("messenger", {
		description: "Inspect messenger: /messenger [inbox|agents|clear]",
		handler: async (args, ctx) => {
			const b = getBus(ctx);
			const sub = args.trim().toLowerCase();

			if (sub === "clear") {
				b.clearInbox();
				ctx.ui.notify("Inbox cleared", "info");
				return;
			}

			if (sub === "agents") {
				const agents = b.listAgents();
				ctx.ui.notify(agents.length ? `Agents: ${agents.join(", ")}` : "No agents registered", "info");
				return;
			}

			// Default: show inbox
			const messages = b.readInbox();
			if (messages.length === 0) {
				ctx.ui.notify("No messages", "info");
				return;
			}

			const lines = messages.map((m) => {
				const ago = ((Date.now() - m.timestamp) / 1000).toFixed(0);
				return `${m.read ? "✓" : "●"} ${m.from} → ${m.to} (${ago}s) — ${m.body}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Prune old messages on session start ─────────────────────────────

	pi.on("session_start", async (_e, ctx) => {
		bus = null; // reset for new cwd
		const b = getBus(ctx);
		const pruned = b.prune();
		if (pruned > 0) {
			ctx.ui.notify(`Pruned ${pruned} old messages`, "info");
		}
	});
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const };
}
