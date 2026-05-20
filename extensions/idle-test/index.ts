/**
 * /idle-test — Live test battery to empirically identify reliable
 * "agent is done responding" signals.
 *
 * Hooks into every event, logs timing + ctx.isIdle() + ctx.signal + ctx.hasPendingMessages()
 * After the conversation, run /idle-test to dump the full log.
 *
 * Goal: find the most reliable signal that the agent has finished
 * responding and is truly idle.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface LogEntry {
	timestamp: number;
	offset: number;
	event: string;
	details: string;
	isIdle?: boolean;
	hasSignal: boolean;
	hasPending?: boolean;
}

const log: LogEntry[] = [];
const startTime = Date.now();
let turnCount = 0;
let messageCount = 0;
let toolCallCount = 0;

function snap(ctx: ExtensionContext): Pick<LogEntry, "isIdle" | "hasSignal" | "hasPending"> {
	return {
		isIdle: ctx.isIdle(),
		hasSignal: ctx.signal !== undefined,
		hasPending: ctx.hasPendingMessages(),
	};
}

function entry(event: string, details: string, ctx?: ExtensionContext): void {
	log.push({
		timestamp: Date.now(),
		offset: Date.now() - startTime,
		event,
		details,
		...(ctx ? snap(ctx) : { hasSignal: false }),
	});
}

export default function (pi: ExtensionAPI): void {
	// ── Session events ──
	pi.on("session_start", async (_e, ctx) => entry("session_start", "", ctx));
	pi.on("session_shutdown", async (_e, ctx) => entry("session_shutdown", "", ctx));
	pi.on("session_start", async (_e, ctx) => entry("session_start", "", ctx));
	pi.on("session_shutdown", async (_e, ctx) => entry("session_shutdown", "", ctx));
	// ── Agent lifecycle ──
	pi.on("agent_start", async (_e, ctx) => entry("agent_start", "", ctx));
	pi.on("agent_end", async (e, ctx) => {
		const msgCount = e.messages?.length ?? 0;
		entry("agent_end", `messages=${msgCount}`, ctx);
	});
	pi.on("before_agent_start", async (_e, ctx) => entry("before_agent_start", "", ctx));

	// ── Turn lifecycle ──
	pi.on("turn_start", async (e, ctx) => {
		turnCount++;
		entry("turn_start", `turn=${e.turnIndex}`, ctx);
	});
	pi.on("turn_end", async (e, ctx) => {
		const toolCount = e.toolResults?.length ?? 0;
		entry("turn_end", `turn=${e.turnIndex} tools=${toolCount}`, ctx);
	});

	// ── Message lifecycle ──
	pi.on("message_start", async (e, ctx) => {
		messageCount++;
		entry("message_start", `role=${e.message.role}`, ctx);
	});
	pi.on("message_update", async (_e, ctx) => {
		// Only log every 10th update to avoid noise
		if (messageCount % 10 === 0) {
			entry("message_update", `[sampling]`, ctx);
		}
	});
	pi.on("message_end", async (e, ctx) => {
		entry("message_end", `role=${e.message.role}`, ctx);
	});

	// ── Tool lifecycle ──
	pi.on("tool_call", async (e, ctx) => {
		toolCallCount++;
		entry("tool_call", `${e.toolName} #${toolCallCount}`, ctx);
	});
	pi.on("tool_result", async (e, ctx) => {
		entry("tool_result", `${e.toolName}`, ctx);
	});

	// ── Resource discovery ──
	pi.on("resources_discover", async (e, _ctx) => {
		entry("resources_discover", `cwd=${e.cwd}`);
	});

	// ── Command to dump results ──
	pi.registerCommand("idle-test", {
		description: "Dump idle detection test log",
		handler: async (_args, ctx) => {
			if (log.length === 0) {
				ctx.ui.notify("No events logged yet. Have a conversation first!", "warning");
				return;
			}

			const lines: string[] = [];
			lines.push("═══ IDLE DETECTION TEST LOG ═══");
			lines.push(`Turns: ${turnCount}  Messages: ${messageCount}  Tool calls: ${toolCallCount}`);
			lines.push(`Total events: ${log.length}`);
			lines.push("");

			// Header
			lines.push(
				"offset(ms)".padEnd(12) +
				"event".padEnd(18) +
				"idle".padEnd(7) +
				"signal".padEnd(8) +
				"pending".padEnd(9) +
				"details",
			);
			lines.push("─".repeat(80));

			for (const e of log) {
				const idle = e.isIdle === true ? "✓" : e.isIdle === false ? "✗" : "-";
				const signal = e.hasSignal ? "yes" : "no";
				const pending = e.hasPending === true ? "yes" : e.hasPending === false ? "no" : "-";
				lines.push(
					String(e.offset).padEnd(12) +
					e.event.padEnd(18) +
					idle.padEnd(7) +
					signal.padEnd(8) +
					pending.padEnd(9) +
					e.details,
				);
			}

			lines.push("");
			lines.push("═══ ANALYSIS ═══");
			lines.push("");

			// Find agent_end events and check state
		const agentEnds = log.filter((e) => e.event === "agent_end");
		lines.push("");
		lines.push(`agent_end events: ${agentEnds.length}`);
		for (const a of agentEnds) {
			lines.push(`  +${a.offset}ms  idle=${a.isIdle}  signal=${a.hasSignal}  pending=${a.hasPending}  ${a.details}`);
		}

		// Find all moments where isIdle was true
			const idleMoments = log.filter((e) => e.isIdle === true);
			lines.push(`isIdle=true moments: ${idleMoments.length}`);
			for (const m of idleMoments) {
				lines.push(`  +${m.offset}ms  ${m.event}  ${m.details}`);
			}

			// Find turn_end events and check state
			const turnEnds = log.filter((e) => e.event === "turn_end");
			lines.push("");
			lines.push(`turn_end events: ${turnEnds.length}`);
			for (const t of turnEnds) {
				lines.push(`  +${t.offset}ms  idle=${t.isIdle}  signal=${t.hasSignal}  pending=${t.hasPending}  ${t.details}`);
			}

			// Find last message_end with role=assistant and check state
			const assistantEnds = log.filter((e) => e.event === "message_end" && e.details.includes("assistant"));
			lines.push("");
			lines.push(`assistant message_end events: ${assistantEnds.length}`);
			for (const a of assistantEnds) {
				lines.push(`  +${a.offset}ms  idle=${a.isIdle}  signal=${a.hasSignal}  pending=${a.hasPending}`);
			}

			// Check: does turn_end always fire after the last tool_result?
			const toolResults = log.filter((e) => e.event === "tool_result");
			if (toolResults.length > 0 && turnEnds.length > 0) {
				const lastToolResult = toolResults[toolResults.length - 1];
				const lastTurnEnd = turnEnds[turnEnds.length - 1];
				const gap = lastTurnEnd.offset - lastToolResult.offset;
				lines.push("");
				lines.push(`Last tool_result → last turn_end gap: ${gap}ms`);
			}

			// Check: signal state at various points
			const withSignal = log.filter((e) => e.hasSignal);
			const withoutSignal = log.filter((e) => !e.hasSignal);
			lines.push("");
			lines.push(`Events WITH signal: ${withSignal.length}  WITHOUT signal: ${withoutSignal.length}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
