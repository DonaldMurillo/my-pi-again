/**
 * Tasks extension — persistent task management for pi agents.
 *
 * Provides:
 *   - Claude Code-compatible tools: TodoWrite, TaskCreate, TaskUpdate, TaskGet, TaskList
 *   - Extended tools: TaskSearch, TaskNext, TaskDecompose, TaskArchive
 *   - /tasks command — interactive TUI task board
 *   - File-based JSON storage under .pi/tasks/
 *   - Auto-gitignore (never committed)
 *   - Event bus integration (task:created, task:completed, etc.)
 *   - Soft worktree integration (auto-assign, orphan cleanup)
 *   - Soft messenger integration (assign/complete/unblock notifications)
 *   - Session recovery (resume in-progress tasks on restart)
 *   - Verification hooks (auto-verify acceptance criteria)
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	appendFileSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { matchesKey } from "@mariozechner/pi-tui";

// ─── ULID ────────────────────────────────────────────────────────────

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let _lastUlidTime = 0;
let _lastUlidRandom = Array.from({ length: 10 }, () => Math.floor(Math.random() * 32));

function ulid(): string {
	const now = Date.now();
	if (now <= _lastUlidTime) {
		for (let i = 9; i >= 0; i--) {
			_lastUlidRandom[i]++;
			if (_lastUlidRandom[i] < 32) break;
			_lastUlidRandom[i] = 0;
		}
	} else {
		_lastUlidTime = now;
		_lastUlidRandom = Array.from({ length: 10 }, () => Math.floor(Math.random() * 32));
	}

	let timePart = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		timePart = ULID_CHARS[t % 32] + timePart;
		t = Math.floor(t / 32);
	}

	let randomPart = "";
	for (let i = 0; i < 10; i++) {
		randomPart += ULID_CHARS[_lastUlidRandom[i]];
	}

	return timePart + randomPart;
}

// ─── Types ───────────────────────────────────────────────────────────

type TaskStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "blocked"
	| "review"
	| "deleted";

type Priority = "critical" | "high" | "medium" | "low";
type Effort = "xs" | "s" | "m" | "l" | "xl";

interface AcceptanceCriterion {
	criterion: string;
	verified: boolean;
	verifiedAt?: number;
}

interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	owner?: string;

	blocks: string[];
	blockedBy: string[];

	priority: Priority;
	effort?: Effort;
	labels: string[];
	parentTaskId?: string;
	subtasks?: string[];

	acceptanceCriteria?: AcceptanceCriterion[];
	verifyCommand?: string;

	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	timeSpentSeconds?: number;

	sessionId?: string;
	contextFile?: string;

	branch?: string;
	pr?: number;

	metadata: Record<string, unknown>;
	template?: string;
	source?: "claude-code" | "pi" | "github-issue" | "user" | "auto";
}

interface TaskStore {
	version: number;
	projectId: string;
	tasks: Record<string, Task>;
	updatedAt: number;
}

// ─── Storage ─────────────────────────────────────────────────────────

function getTasksDir(cwd: string): string {
	return join(cwd, ".pi", "tasks");
}

function getTasksFile(cwd: string): string {
	return join(getTasksDir(cwd), "tasks.json");
}

function ensureTasksDir(cwd: string): string {
	const dir = getTasksDir(cwd);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });

		// .gitignore inside tasks dir — ignore everything
		writeFileSync(join(dir, ".gitignore"), "*\n");

		// Also add to project root .gitignore as safety net
		const rootGitignore = join(cwd, ".gitignore");
		const tasksEntry = ".pi/tasks/";
		if (existsSync(rootGitignore)) {
			const content = readFileSync(rootGitignore, "utf8");
			if (!content.includes(tasksEntry)) {
				appendFileSync(rootGitignore, `\n${tasksEntry}\n`);
			}
		} else {
			writeFileSync(rootGitignore, `${tasksEntry}\n`);
		}
	}
	return dir;
}

function loadStore(cwd: string): TaskStore {
	const file = getTasksFile(cwd);
	if (!existsSync(file)) {
		return {
			version: 1,
			projectId: cwd.split("/").pop() || "unknown",
			tasks: {},
			updatedAt: Date.now(),
		};
	}
	return JSON.parse(readFileSync(file, "utf8"));
}

function saveStore(cwd: string, store: TaskStore): void {
	ensureTasksDir(cwd);
	store.updatedAt = Date.now();
	writeFileSync(getTasksFile(cwd), JSON.stringify(store, null, "\t") + "\n");
}

// ─── Priority ordering ──────────────────────────────────────────────

const PRIORITY_ORDER: Record<Priority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

const EFFORT_ORDER: Record<Effort, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };

// ─── Soft dependency helpers ─────────────────────────────────────────

function emitEvent(event: string, data: Record<string, unknown>): void {
	try {
		const bus = require("../observability/bus.js");
		if (bus?.default?.emit) bus.default.emit(event, data);
	} catch { /* observability not loaded */ }
}

function getMessenger(cwd: string): any | null {
	try {
		const { MessageBus } = require("../messenger/message-bus.js");
		return new MessageBus({ messagesDir: join(cwd, ".pi", "messages"), agentName: "tasks" });
	} catch { return null; }
}

function getWorktreeManager(): any | null {
	try {
		return require("../worktree/worktree-manager.js");
	} catch { return null; }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatTask(task: Task, verbose = false): string {
	const statusIcons: Record<TaskStatus, string> = {
		pending: "○",
		in_progress: "●",
		completed: "✓",
		blocked: "⊘",
		review: "◎",
		deleted: "✗",
	};

	const priorityIcons: Record<Priority, string> = {
		critical: "🔥",
		high: "↑",
		medium: "→",
		low: "↓",
	};

	const lines: string[] = [
		`${statusIcons[task.status]} ${priorityIcons[task.priority]} [${task.id.slice(0, 8)}] ${task.subject}`,
	];

	if (verbose) {
		if (task.description) lines.push(`  ${task.description}`);
		if (task.owner) lines.push(`  Owner: ${task.owner}`);
		if (task.labels.length) lines.push(`  Labels: ${task.labels.join(", ")}`);
		if (task.blockedBy.length) lines.push(`  Blocked by: ${task.blockedBy.map((id) => id.slice(0, 8)).join(", ")}`);
		if (task.blocks.length) lines.push(`  Blocks: ${task.blocks.map((id) => id.slice(0, 8)).join(", ")}`);
		if (task.effort) lines.push(`  Effort: ${task.effort}`);
		if (task.branch) lines.push(`  Branch: ${task.branch}`);
		if (task.parentTaskId) lines.push(`  Parent: ${task.parentTaskId.slice(0, 8)}`);
		if (task.subtasks?.length) lines.push(`  Subtasks: ${task.subtasks.map((id) => id.slice(0, 8)).join(", ")}`);
		if (task.acceptanceCriteria?.length) {
			lines.push("  Acceptance criteria:");
			for (const ac of task.acceptanceCriteria) {
				lines.push(`    ${ac.verified ? "✓" : "○"} ${ac.criterion}`);
			}
		}
		if (task.verifyCommand) lines.push(`  Verify: ${task.verifyCommand}`);
		if (task.timeSpentSeconds) {
			const m = Math.floor(task.timeSpentSeconds / 60);
			const s = task.timeSpentSeconds % 60;
			lines.push(`  Time: ${m}m ${s}s`);
		}
	}

	return lines.join("\n");
}

function findNextTask(store: TaskStore, owner?: string, labels?: string[]): Task | null {
	const tasks = Object.values(store.tasks)
		.filter((t) => t.status === "pending")
		.filter((t) => !owner || t.owner === owner)
		.filter((t) => !labels || labels.every((l) => t.labels.includes(l)))
		.filter((t) => t.blockedBy.every((id) => store.tasks[id]?.status === "completed"))
		.sort((a, b) => {
			const pa = PRIORITY_ORDER[a.priority];
			const pb = PRIORITY_ORDER[b.priority];
			if (pa !== pb) return pa - pb;
			return a.createdAt - b.createdAt;
		});

	return tasks[0] || null;
}

/** Find the currently in-progress task (if any). */
function findInProgress(store: TaskStore, owner?: string): Task | null {
	const tasks = Object.values(store.tasks)
		.filter((t) => t.status === "in_progress")
		.filter((t) => !owner || t.owner === owner);
	return tasks[0] || null;
}

/** Send messenger notification about task events. */
function notifyAssignment(cwd: string, task: Task): void {
	const bus = getMessenger(cwd);
	if (!bus || !task.owner) return;

	const match = task.owner.match(/^worktree:(.+)$/);
	if (!match) return;

	const branch = match[1];
	bus.send(branch, [
		`📋 Assigned task [${task.id.slice(0, 8)}]: ${task.subject}`,
		task.description ? `   ${task.description}` : "",
		`   Priority: ${task.priority}`,
		task.acceptanceCriteria?.length
			? `   Acceptance criteria:\n${task.acceptanceCriteria.map((ac) => `     - ${ac.criterion}`).join("\n")}`
			: "",
		`   Mark completed: TaskUpdate({ taskId: "${task.id}", status: "completed" })`,
	].filter(Boolean).join("\n"));
}

function notifyCompletion(cwd: string, task: Task): void {
	const bus = getMessenger(cwd);
	if (!bus) return;

	bus.broadcast(`✅ Task [${task.id.slice(0, 8)}] "${task.subject}" completed${task.owner ? ` by ${task.owner}` : ""}.`);
}

function notifyUnblock(cwd: string, unblockedTask: Task, completedTaskId: string): void {
	const bus = getMessenger(cwd);
	if (!bus) return;

	const match = unblockedTask.owner?.match(/^worktree:(.+)$/);
	if (match) {
		bus.send(match[1], [
			`🔓 Unblocked! Task [${completedTaskId.slice(0, 8)}] is complete.`,
			`   You can now start: [${unblockedTask.id.slice(0, 8)}] ${unblockedTask.subject}`,
		].join("\n"));
	}
}

// ─── TUI: Task Board Overlay ─────────────────────────────────────────

interface BoardState {
	tasks: Task[];
	selectedIdx: number;
	scrollOffset: number;
	filter: "all" | TaskStatus;
	expanded: Set<string>; // expanded task IDs for verbose view
}

function renderTaskBoard(
	theme: Theme,
	state: BoardState,
	width: number,
	height: number,
): string[] {
	const lines: string[] = [];

	// Filter tasks
	let filtered = state.tasks;
	if (state.filter !== "all") {
		filtered = filtered.filter((t) => t.status === state.filter);
	}

	// Header
	const filterLabels: Record<string, string> = {
		all: "All",
		pending: "Pending",
		in_progress: "In Progress",
		blocked: "Blocked",
		review: "Review",
		completed: "Completed",
	};

	const header = theme.bold(` Task Board — ${filterLabels[state.filter]} (${filtered.length}) `);
	lines.push(theme.fg("accent", header));

	// Status counts
	const counts: Record<string, number> = { all: state.tasks.length };
	for (const t of state.tasks) {
		counts[t.status] = (counts[t.status] || 0) + 1;
	}

	const countParts = ["all", "in_progress", "blocked", "pending", "review", "completed"]
		.filter((s) => counts[s])
		.map((s) => `${filterLabels[s] || s}: ${counts[s]}`)
		.join("  ");
	lines.push(theme.fg("dim", countParts));

	// Separator
	lines.push(theme.fg("border", "─".repeat(width)));

	// Task list
	const startRow = 3;
	const visibleHeight = height - startRow - 2; // reserve 2 for footer
	let row = startRow;

	const visibleTasks = filtered.slice(state.scrollOffset, state.scrollOffset + visibleHeight);

	for (let i = 0; i < visibleTasks.length; i++) {
		const task = visibleTasks[i];
		const globalIdx = state.scrollOffset + i;
		const isSelected = globalIdx === state.selectedIdx;
		const isExpanded = state.expanded.has(task.id);

		// Status icon
		const statusIcons: Record<TaskStatus, string> = {
			pending: "○", in_progress: "●", completed: "✓",
			blocked: "⊘", review: "◎", deleted: "✗",
		};
		const priorityIcons: Record<Priority, string> = {
			critical: "🔥", high: "↑", medium: "→", low: "↓",
		};

		const icon = statusIcons[task.status];
		const pri = priorityIcons[task.priority];
		const id = task.id.slice(0, 8);
		let line = `${icon} ${pri} [${id}] ${task.subject}`;

		if (isSelected) {
			line = theme.bg("selectedBg", theme.fg("selectedFg", line));
		} else if (task.status === "completed") {
			line = theme.fg("dim", line);
		}

		lines.push(line);
		row++;

		// Expanded details
		if (isExpanded) {
			const details: string[] = [];
			if (task.description) details.push(`  ${task.description}`);
			if (task.owner) details.push(`  Owner: ${task.owner}`);
			if (task.labels.length) details.push(`  Labels: ${task.labels.join(", ")}`);
			if (task.branch) details.push(`  Branch: ${task.branch}`);
			if (task.effort) details.push(`  Effort: ${task.effort}`);
			if (task.blockedBy.length) details.push(`  Blocked by: ${task.blockedBy.map((b) => b.slice(0, 8)).join(", ")}`);

			for (const d of details) {
				if (row >= height - 2) break;
				lines.push(theme.fg("dim", isSelected ? theme.bg("selectedBg", d) : d));
				row++;
			}
		}

		if (row >= height - 2) break;
	}

	// Pad to height - 2
	while (lines.length < height - 2) {
		lines.push("");
	}

	// Footer
	lines.push(theme.fg("border", "─".repeat(width)));
	const footer = " ↑↓/jk:nav  Enter:expand  f:filter  n:next  a:archive  q:close ";
	lines.push(theme.fg("dim", footer));

	return lines;
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {

	// ── Inject tool docs into system prompt ──

	pi.on("before_agent_start", async (event) => {
		event.systemPrompt += `

## tasks extension

You have task management tools for persistent, structured task tracking. Tasks survive session
restarts and compaction. You MUST use these tools actively to track your work — do NOT ask the user
to manage tasks manually.

### When to create tasks
- At the start of any multi-step task: use TodoWrite or TaskCreate to plan the steps
- When you identify subtasks or dependencies: use TaskCreate with parentTaskId, blocks, blockedBy
- When starting a new feature or bug fix: create a task before writing code
- When delegating to a worktree agent: create a task with owner: "worktree:<branch>"

### When to update tasks
- When you start working on a task: TaskUpdate({ taskId, status: "in_progress" })
- When you finish a task: TaskUpdate({ taskId, status: "completed" })
- When blocked on something: TaskUpdate({ taskId, status: "blocked" })
- When handing off to review: TaskUpdate({ taskId, status: "review" })

### When to check tasks
- On session start: TaskList({}) to see what's pending from last session
- Before asking "what should I work on?": TaskNext({})
- Before claiming work is done: verify all tasks are completed with TaskList({})

### Tool reference
- \`TodoWrite({ todos: [...] })\` — replace full task list (Claude Code compatible)
- \`TaskCreate({ subject, priority, labels, ... })\` — create task with full schema
- \`TaskUpdate({ taskId, status, ... })\` — update any task field
- \`TaskGet({ taskId })\` — get full task details
- \`TaskList({ status, owner, labels, sort })\` — list with filters
- \`TaskNext({})\` — get next actionable task (respects deps)
- \`TaskSearch({ query })\` — search by text
- \`TaskDecompose({ taskId })\` — break task into subtasks via LLM
- \`TaskArchive({ status })\` — archive completed tasks
`;
	});

	// ── Session recovery ──

	pi.on("session_start", async (_event, ctx) => {
		const store = loadStore(ctx.cwd);
		const inProgress = Object.values(store.tasks).filter(
			(t) => t.status === "in_progress",
		);

		if (inProgress.length > 0) {
			const list = inProgress
				.map((t) => `  - [${t.id.slice(0, 8)}] ${t.subject}`)
				.join("\n");
			ctx.ui.notify(
				`Resuming ${inProgress.length} in-progress task(s):\n${list}`,
				"info",
			);
		}
	});

	// ── Stop hook: warn if incomplete tasks ──

	pi.on("stop", async (_event, ctx) => {
		const store = loadStore(ctx.cwd);
		const active = Object.values(store.tasks).filter(
			(t) => t.status === "in_progress" || t.status === "blocked",
		);
		if (active.length > 0) {
			const list = active
				.slice(0, 5)
				.map((t) => `  - [${t.id.slice(0, 8)}] ${t.subject} (${t.status})`)
				.join("\n");
			ctx.ui.notify(
				`⚠ ${active.length} task(s) still active:\n${list}`,
				"warning",
			);
		}
	});

	// ── Verification hook ──

	pi.on("before_tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		// Find the in-progress task with a verifyCommand
		const store = loadStore(ctx.cwd);
		const task = findInProgress(store);
		if (!task?.verifyCommand || !task.acceptanceCriteria?.length) return;

		const bashCommand = event.args?.command ?? event.args?.[0] ?? "";
		if (typeof bashCommand !== "string") return;

		// If the bash command matches (or contains) the verify command, auto-verify
		if (bashCommand.includes(task.verifyCommand) || task.verifyCommand.includes(bashCommand)) {
			const now = Date.now();
			let allVerified = true;
			for (const ac of task.acceptanceCriteria) {
				if (!ac.verified) {
					ac.verified = true;
					ac.verifiedAt = now;
				}
			}

			// Check if all criteria are now verified
			allVerified = task.acceptanceCriteria.every((ac) => ac.verified);
			task.updatedAt = now;

			saveStore(ctx.cwd, store);

			if (allVerified) {
				event.systemPrompt += `\n\n[TASKS] All acceptance criteria verified for task [${task.id.slice(0, 8)}] "${task.subject}". Consider marking it completed with TaskUpdate.`;
			}
		}
	});

	// ── Persistent task widget + status ──


	function refreshWidget(ctx: ExtensionContext): void {
		const store = loadStore(ctx.cwd);
		const tasks = Object.values(store.tasks).filter((t) => t.status !== "deleted");
		const hasTodos = todos.length > 0;
		const hasTasks = tasks.length > 0;

		if (!hasTodos && !hasTasks) {
			ctx.ui.setWidget("tasks", undefined);
			ctx.ui.setWidget("todos", undefined);
			ctx.ui.setStatus("tasks", undefined);
			return;
		}

		// ── Footer status ──
		const parts: string[] = [];
		if (hasTodos) {
			const a = todos.filter((t) => t.status !== "completed").length;
			const d = todos.filter((t) => t.status === "completed").length;
			parts.push(`todo:${a}`);
			if (d) parts.push(`done:${d}`);
		}
		if (hasTasks) {
			const ip = tasks.filter((t) => t.status === "in_progress").length;
			const p = tasks.filter((t) => t.status === "pending").length;
			const b = tasks.filter((t) => t.status === "blocked").length;
			const c = tasks.filter((t) => t.status === "completed").length;
			if (ip) parts.push(`in-progress:${ip}`);
			if (b) parts.push(`blocked:${b}`);
			if (p) parts.push(`pending:${p}`);
			if (c) parts.push(`done:${c}`);
		}
		ctx.ui.setStatus("tasks", `📋 ${parts.join(" ")}`);

		// ── Todos widget (warm colors — warning/amber) ──
		if (hasTodos) {
			const activeTodos = todos.filter((t) => t.status !== "completed");
			const doneTodos = todos.filter((t) => t.status === "completed");

			ctx.ui.setWidget("todos", (_tui: any, theme: Theme) => {
				const themed: string[] = [];
				themed.push(theme.fg("warning", theme.bold("todos")));
				for (let i = 0; i < Math.min(activeTodos.length, 3); i++) {
					const t = activeTodos[i];
					const icon = t.status === "in_progress" ? "●" : "○";
					let line = `${icon} ${t.content}`;
					if (t.activeForm && t.status === "in_progress") line += `  (${t.activeForm})`;
					themed.push(t.status === "in_progress" ? theme.fg("warning", line) : theme.fg("muted", line));
				}
				for (let i = 0; i < Math.min(doneTodos.length, 2); i++) {
					themed.push(theme.fg("dim", theme.strikethrough(`✓ ${doneTodos[i].content}`)));
				}
				return {
					render(_width: number): string[] { return themed; },
					invalidate() {},
				};
			});
		} else {
			ctx.ui.setWidget("todos", undefined);
		}

		// ── Tasks widget (cool colors — accent/blue) ──
		if (hasTasks) {
			const inProgress = tasks.filter((t) => t.status === "in_progress")
				.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
			const blocked = tasks.filter((t) => t.status === "blocked")
				.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
			const pending = tasks.filter((t) => t.status === "pending")
				.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
			const completed = tasks.filter((t) => t.status === "completed")
				.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

			ctx.ui.setWidget("tasks", (_tui: any, theme: Theme) => {
				const themed: string[] = [];
				themed.push(theme.fg("accent", theme.bold("tasks")));
				let count = 0;
				for (const t of [...inProgress, ...blocked, ...pending]) {
					if (count >= 3) break;
					const pri = { critical: "🔥", high: "↑", medium: "→", low: "↓" }[t.priority];
					const icon = { in_progress: "●", blocked: "⊘", pending: "○", review: "◎" }[t.status as string];
					let line = `${icon} ${pri} ${t.subject}`;
					if (t.activeForm && t.status === "in_progress") line += `  (${t.activeForm})`;
					if (t.status === "in_progress") themed.push(theme.fg("accent", line));
					else if (t.status === "blocked") themed.push(theme.fg("error", line));
					else themed.push(theme.fg("text", line));
					count++;
				}
				for (const t of completed) {
					if (count >= 5) break;
					themed.push(theme.fg("dim", `✓ ${t.subject}`));
					count++;
				}
				return {
					render(_width: number): string[] { return themed; },
					invalidate() {},
				};
			});
		} else {
			ctx.ui.setWidget("tasks", undefined);
		}
	}

	// Refresh widget on task tool results
	const TASK_TOOLS = new Set([
		"TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
		"TaskSearch", "TaskNext", "TaskDecompose", "TaskArchive",
	]);

	pi.on("tool_result", async (event, ctx) => {
		if (TASK_TOOLS.has(event.toolName)) {
			refreshWidget(ctx);
		}
	});

	// Refresh on session start
	pi.on("session_start", async (_event, ctx) => {
		refreshWidget(ctx);
	});

	// ═══════════════════════════════════════════════════════════════════
	//  TOOLS
	// ═══════════════════════════════════════════════════════════════════


	// ── In-memory todos (TodoWrite) — NOT persisted ──

	let todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> = [];

	// ── Tool: TodoWrite ────────────────────────────────────────────────

	pi.registerTool({
		name: "TodoWrite",
		label: "TodoWrite",
		description:
			"Replace the current in-memory todo list. Items not in the new list are " +
			"removed. This is transient — does NOT persist to disk. For persistent tasks use TaskCreate.",
		parameters: Type.Object({
			todos: Type.Array(
				Type.Object({
					content: Type.String({ description: "Task description/subject" }),
					status: StringEnum(["pending", "in_progress", "completed"] as const, {
						description: "Task status",
					}),
					activeForm: Type.Optional(
						Type.String({ description: "Spinner text e.g. 'Running tests'" }),
					),
				}),
			),
		}),
		promptSnippet: "Write or update the todo list",
		promptGuidelines: [
			"Use TodoWrite to replace the in-memory todo list. This is ephemeral — cleared on session end.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			todos = params.todos.map((t) => ({
				content: t.content,
				status: t.status as "pending" | "in_progress" | "completed",
				activeForm: t.activeForm,
			}));

			const active = todos.filter((t) => t.status !== "completed").length;

			return {
				content: [{
					type: "text" as const,
					text: `Updated ${todos.length} todos. ${active} active.`,
				}],
			};
		},
	});

	// ── Tool: TaskCreate ───────────────────────────────────────────────

	pi.registerTool({
		name: "TaskCreate",
		label: "TaskCreate",
		description: "Create a new task with full schema support. Returns the created task.",
		parameters: Type.Object({
			subject: Type.String({ description: "Brief task title" }),
			description: Type.Optional(Type.String({ description: "What to do (markdown)", default: "" })),
			activeForm: Type.Optional(Type.String({ description: "Spinner text e.g. 'Running tests'" })),
			priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const, { default: "medium" })),
			effort: Type.Optional(StringEnum(["xs", "s", "m", "l", "xl"] as const)),
			labels: Type.Optional(Type.Array(Type.String()), { default: [] }),
			parentTaskId: Type.Optional(Type.String({ description: "Parent task ID for subtasks" })),
			blocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
			blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs blocking this task" })),
			acceptanceCriteria: Type.Optional(
				Type.Array(Type.Object({
					criterion: Type.String(),
					verified: Type.Boolean({ default: false }),
				})),
			),
			verifyCommand: Type.Optional(Type.String({ description: "Shell command to verify completion" })),
			branch: Type.Optional(Type.String({ description: "Associated git branch" })),
			owner: Type.Optional(Type.String({ description: '"main" | "worktree:<branch>" | agent name' })),
			metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		promptSnippet: "Create a new task",
		promptGuidelines: [
			"Use TaskCreate to create structured tasks with priorities, labels, dependencies, and acceptance criteria.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const store = loadStore(cwd);
			const now = Date.now();
			const id = ulid();

			const criteria: AcceptanceCriterion[] | undefined =
				params.acceptanceCriteria?.map((ac) => ({
					criterion: ac.criterion,
					verified: ac.verified ?? false,
				}));

			// Check blockers
			let status: TaskStatus = "pending";
			if (params.blockedBy?.length) {
				const allComplete = params.blockedBy.every(
					(bid) => store.tasks[bid]?.status === "completed",
				);
				if (!allComplete) status = "blocked";
			}

			const task: Task = {
				id,
				subject: params.subject,
				description: params.description ?? "",
				activeForm: params.activeForm,
				status,
				owner: params.owner,
				priority: params.priority ?? "medium",
				effort: params.effort,
				labels: params.labels ?? [],
				parentTaskId: params.parentTaskId,
				blocks: params.blocks ?? [],
				blockedBy: params.blockedBy ?? [],
				acceptanceCriteria: criteria,
				verifyCommand: params.verifyCommand,
				branch: params.branch,
				createdAt: now,
				updatedAt: now,
				metadata: params.metadata ?? {},
				source: "pi",
			};

			// Link parent → child
			if (params.parentTaskId && store.tasks[params.parentTaskId]) {
				const parent = store.tasks[params.parentTaskId];
				if (!parent.subtasks) parent.subtasks = [];
				parent.subtasks.push(id);
				parent.updatedAt = now;
			}

			// Link blocks/blockedBy bidirectionally
			for (const blockId of task.blocks) {
				const blocked = store.tasks[blockId];
				if (blocked && !blocked.blockedBy.includes(id)) {
					blocked.blockedBy.push(id);
					blocked.updatedAt = now;
				}
			}
			for (const blockerId of task.blockedBy) {
				const blocker = store.tasks[blockerId];
				if (blocker && !blocker.blocks.includes(id)) {
					blocker.blocks.push(id);
					blocker.updatedAt = now;
				}
			}

			store.tasks[id] = task;
			saveStore(cwd, store);

			emitEvent("task:created", { taskId: id, source: "pi", subject: task.subject });

			// Notify if assigned to a worktree agent
			if (task.owner) {
				notifyAssignment(cwd, task);
			}

			return {
				content: [{
					type: "text" as const,
					text: `Created task ${id.slice(0, 8)}: ${task.subject}\nStatus: ${status}${status === "blocked" ? " (blocked by incomplete dependencies)" : ""}\nPriority: ${task.priority}`,
				}],
				details: { taskId: id, task },
			};
		},
	});

	// ── Tool: TaskUpdate ───────────────────────────────────────────────

	pi.registerTool({
		name: "TaskUpdate",
		label: "TaskUpdate",
		description: "Update a task by ID. Supports status transitions, priority, labels, dependencies.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to update" }),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			status: Type.Optional(
				StringEnum(["pending", "in_progress", "completed", "blocked", "review", "deleted"] as const),
			),
			owner: Type.Optional(Type.String()),
			priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
			effort: Type.Optional(StringEnum(["xs", "s", "m", "l", "xl"] as const)),
			labels: Type.Optional(
				Type.Object({
					add: Type.Optional(Type.Array(Type.String())),
					remove: Type.Optional(Type.Array(Type.String())),
				}),
			),
			addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to add to blocks list" })),
			addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to add to blockedBy list" })),
			acceptanceCriteria: Type.Optional(
				Type.Array(Type.Object({
					index: Type.Number({ description: "0-based index of the criterion" }),
					verified: Type.Boolean(),
				})),
			),
			branch: Type.Optional(Type.String()),
			pr: Type.Optional(Type.Number()),
			metadata: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Merge into metadata. Null values delete keys.",
				}),
			),
		}),
		promptSnippet: "Update an existing task",
		promptGuidelines: [
			"Use TaskUpdate to change task status, add labels, link dependencies, or modify any task field.",
		],

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const store = loadStore(cwd);
			const task = store.tasks[params.taskId];

			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Task not found: ${params.taskId}` }],
					isError: true,
				};
			}

			const now = Date.now();
			const changes: string[] = [];

			// Simple fields
			if (params.subject !== undefined) { task.subject = params.subject; changes.push("subject"); }
			if (params.description !== undefined) { task.description = params.description; changes.push("description"); }
			if (params.activeForm !== undefined) { task.activeForm = params.activeForm; changes.push("activeForm"); }
			if (params.owner !== undefined) { task.owner = params.owner; changes.push("owner"); }
			if (params.priority !== undefined) { task.priority = params.priority; changes.push("priority"); }
			if (params.effort !== undefined) { task.effort = params.effort; changes.push("effort"); }
			if (params.branch !== undefined) { task.branch = params.branch; changes.push("branch"); }
			if (params.pr !== undefined) { task.pr = params.pr; changes.push("pr"); }

			// Status transitions
			if (params.status !== undefined) {
				const oldStatus = task.status;
				task.status = params.status;

				if (params.status === "in_progress" && oldStatus !== "in_progress") {
					task.startedAt = now;

					// Auto-block check: can't start if blocked
					if (task.blockedBy.some((id) => store.tasks[id]?.status !== "completed")) {
						task.status = "blocked";
						emitEvent("task:blocked", { taskId: task.id, blockedBy: task.blockedBy });
						changes.push("status→blocked (has incomplete blockers)");
					} else {
						changes.push("status");
					}
				}

				if (["completed", "deleted"].includes(params.status) && !["completed", "deleted"].includes(oldStatus)) {
					task.completedAt = now;
					if (task.startedAt) {
						task.timeSpentSeconds = Math.round((now - task.startedAt) / 1000);
					}
					emitEvent("task:completed", { taskId: task.id, timeSpentSeconds: task.timeSpentSeconds });
					notifyCompletion(cwd, task);
				}
				if (!changes.some((c) => c.startsWith("status"))) {
					changes.push("status");
				}
			}

			// Labels
			if (params.labels) {
				if (params.labels.add) {
					for (const l of params.labels.add) {
						if (!task.labels.includes(l)) task.labels.push(l);
					}
				}
				if (params.labels.remove) {
					task.labels = task.labels.filter((l) => !params.labels!.remove!.includes(l));
				}
				changes.push("labels");
			}

			// Dependencies
			if (params.addBlocks) {
				for (const blockId of params.addBlocks) {
					if (!task.blocks.includes(blockId)) task.blocks.push(blockId);
					const blocked = store.tasks[blockId];
					if (blocked && !blocked.blockedBy.includes(task.id)) {
						blocked.blockedBy.push(task.id);
						blocked.updatedAt = now;
					}
				}
				changes.push("blocks");
			}
			if (params.addBlockedBy) {
				for (const blockerId of params.addBlockedBy) {
					if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
					const blocker = store.tasks[blockerId];
					if (blocker && !blocker.blocks.includes(task.id)) {
						blocker.blocks.push(task.id);
						blocker.updatedAt = now;
					}
				}
				if (
					task.status === "pending" &&
					task.blockedBy.some((id) => store.tasks[id]?.status !== "completed")
				) {
					task.status = "blocked";
					emitEvent("task:blocked", { taskId: task.id, blockedBy: task.blockedBy });
				}
				changes.push("blockedBy");
			}

			// Acceptance criteria
			if (params.acceptanceCriteria) {
				if (!task.acceptanceCriteria) task.acceptanceCriteria = [];
				for (const ac of params.acceptanceCriteria) {
					if (task.acceptanceCriteria[ac.index]) {
						task.acceptanceCriteria[ac.index].verified = ac.verified;
						if (ac.verified) task.acceptanceCriteria[ac.index].verifiedAt = now;
					}
				}
				changes.push("acceptanceCriteria");
			}

			// Metadata
			if (params.metadata) {
				for (const [key, value] of Object.entries(params.metadata)) {
					if (value === null) delete task.metadata[key];
					else task.metadata[key] = value;
				}
				changes.push("metadata");
			}

			// Owner assignment — send messenger notification
			if (params.owner && params.owner !== task.owner) {
				notifyAssignment(cwd, task);
			}

			task.updatedAt = now;

			// Auto-unblock: completing a task may unblock dependents
			if (params.status === "completed") {
				for (const blockedId of task.blocks) {
					const blocked = store.tasks[blockedId];
					if (
						blocked?.status === "blocked" &&
						blocked.blockedBy.every((id) => store.tasks[id]?.status === "completed")
					) {
						blocked.status = "pending";
						blocked.updatedAt = now;
						emitEvent("task:unblocked", { taskId: blocked.id });
						notifyUnblock(cwd, blocked, task.id);
					}
				}
			}

			saveStore(cwd, store);
			emitEvent("task:updated", { taskId: task.id, changes });

			return {
				content: [{
					type: "text" as const,
					text: `Updated ${task.id.slice(0, 8)}: ${changes.join(", ")}`,
				}],
			};
		},
	});

	// ── Tool: TaskGet ──────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskGet",
		label: "TaskGet",
		description: "Get full task details by ID.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID" }),
		}),
		promptSnippet: "Get task details",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = loadStore(ctx.cwd);
			const task = store.tasks[params.taskId];

			if (!task) {
				return {
					content: [{ type: "text" as const, text: `Task not found: ${params.taskId}` }],
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: formatTask(task, true) }],
				details: { task },
			};
		},
	});

	// ── Tool: TaskList ─────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskList",
		label: "TaskList",
		description: "List tasks with optional filters.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.Array(StringEnum(["pending", "in_progress", "completed", "blocked", "review", "deleted"] as const)),
			),
			owner: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
			priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
			parentTaskId: Type.Optional(
				Type.String({ description: "Filter by parent. 'null' for top-level only." }),
			),
			limit: Type.Optional(Type.Number({ default: 50 })),
			sort: Type.Optional(
				StringEnum(["created", "priority", "effort", "updated"] as const, { default: "priority" }),
			),
		}),
		promptSnippet: "List tasks with filters",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = loadStore(ctx.cwd);

			let tasks = Object.values(store.tasks);

			if (params.status) tasks = tasks.filter((t) => params.status!.includes(t.status));
			if (params.owner) tasks = tasks.filter((t) => t.owner === params.owner);
			if (params.labels) tasks = tasks.filter((t) => params.labels!.every((l) => t.labels.includes(l)));
			if (params.priority) tasks = tasks.filter((t) => t.priority === params.priority);
			if (params.parentTaskId === "null") tasks = tasks.filter((t) => !t.parentTaskId);
			else if (params.parentTaskId) tasks = tasks.filter((t) => t.parentTaskId === params.parentTaskId);

			const sortFn: Record<string, (a: Task, b: Task) => number> = {
				created: (a, b) => a.createdAt - b.createdAt,
				priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt,
				effort: (a, b) => (EFFORT_ORDER[a.effort ?? "m"] ?? 2) - (EFFORT_ORDER[b.effort ?? "m"] ?? 2),
				updated: (a, b) => b.updatedAt - a.updatedAt,
			};
			tasks.sort(sortFn[params.sort ?? "priority"] ?? sortFn.priority);

			if (params.limit) tasks = tasks.slice(0, params.limit);

			if (tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No tasks found matching filters." }],
				};
			}

			return {
				content: [{
					type: "text" as const,
					text: `Found ${tasks.length} task(s):\n\n${tasks.map((t) => formatTask(t)).join("\n")}`,
				}],
				details: {
					count: tasks.length,
					tasks: tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
				},
			};
		},
	});

	// ── Tool: TaskSearch ───────────────────────────────────────────────

	pi.registerTool({
		name: "TaskSearch",
		label: "TaskSearch",
		description: "Search tasks by text query (subject, description, labels).",
		parameters: Type.Object({
			query: Type.String({ description: "Search text" }),
			status: Type.Optional(
				Type.Array(StringEnum(["pending", "in_progress", "completed", "blocked", "review", "deleted"] as const)),
			),
			limit: Type.Optional(Type.Number({ default: 20 })),
		}),
		promptSnippet: "Search tasks by text",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = loadStore(ctx.cwd);
			const q = params.query.toLowerCase();

			let tasks = Object.values(store.tasks).filter((t) =>
				t.subject.toLowerCase().includes(q) ||
				t.description.toLowerCase().includes(q) ||
				t.labels.some((l) => l.toLowerCase().includes(q)),
			);

			if (params.status) tasks = tasks.filter((t) => params.status!.includes(t.status));
			tasks.sort((a, b) => b.updatedAt - a.updatedAt);
			tasks = tasks.slice(0, params.limit ?? 20);

			if (tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No tasks matching "${params.query}"` }],
				};
			}

			return {
				content: [{
					type: "text" as const,
					text: `Found ${tasks.length} task(s) for "${params.query}":\n\n${tasks.map((t) => formatTask(t, true)).join("\n\n")}`,
				}],
			};
		},
	});

	// ── Tool: TaskNext ─────────────────────────────────────────────────

	pi.registerTool({
		name: "TaskNext",
		label: "TaskNext",
		description:
			"Get the highest-priority actionable task. Respects dependencies — " +
			"only returns tasks whose blockers are all completed.",
		parameters: Type.Object({
			owner: Type.Optional(Type.String()),
			labels: Type.Optional(Type.Array(Type.String())),
		}),
		promptSnippet: "Get next actionable task",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = loadStore(ctx.cwd);
			const next = findNextTask(store, params.owner, params.labels);

			if (!next) {
				return {
					content: [{
						type: "text" as const,
						text: "No actionable tasks found. All tasks are completed, blocked, or none exist.",
					}],
				};
			}

			let text = `Next task:\n${formatTask(next, true)}`;

			// Hint about branch/worktree
			if (next.branch) {
				text += `\n\n💡 This task has branch "${next.branch}". Consider spawning a worktree agent.`;
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { task: next },
			};
		},
	});

	// ── Tool: TaskDecompose ────────────────────────────────────────────

	pi.registerTool({
		name: "TaskDecompose",
		label: "TaskDecompose",
		description:
			"Break a large task into subtasks with dependency relationships. " +
			"Creates child tasks linked to the parent via parentTaskId and blocks/blockedBy.",
		parameters: Type.Object({
			taskId: Type.String({ description: "Parent task ID to decompose" }),
			strategy: Type.Optional(
				StringEnum(["sequential", "parallel", "phases"] as const, { default: "sequential" }),
			),
			subtasks: Type.Array(
				Type.Object({
					subject: Type.String({ description: "Subtask title" }),
					description: Type.Optional(Type.String()),
					priority: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
					effort: Type.Optional(StringEnum(["xs", "s", "m", "l", "xl"] as const)),
					labels: Type.Optional(Type.Array(Type.String())),
					acceptanceCriteria: Type.Optional(
						Type.Array(Type.Object({
							criterion: Type.String(),
							verified: Type.Boolean({ default: false }),
						})),
					),
					verifyCommand: Type.Optional(Type.String()),
				}),
			),
		}),
		promptSnippet: "Decompose a task into subtasks",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const store = loadStore(cwd);
			const parent = store.tasks[params.taskId];

			if (!parent) {
				return {
					content: [{ type: "text" as const, text: `Task not found: ${params.taskId}` }],
					isError: true,
				};
			}

			if (!params.subtasks?.length) {
				return {
					content: [{ type: "text" as const, text: "No subtasks provided. Pass subtasks array with the breakdown." }],
					isError: true,
				};
			}

			const now = Date.now();
			const strategy = params.strategy ?? "sequential";
			const createdIds: string[] = [];

			for (let i = 0; i < params.subtasks.length; i++) {
				const st = params.subtasks[i];
				const id = ulid();

				const subtask: Task = {
					id,
					subject: st.subject,
					description: st.description ?? "",
					status: "pending",
					priority: st.priority ?? parent.priority,
					effort: st.effort,
					labels: [...(parent.labels ?? []), ...(st.labels ?? [])],
					parentTaskId: parent.id,
					blocks: [],
					blockedBy: [],
					acceptanceCriteria: st.acceptanceCriteria?.map((ac) => ({
						criterion: ac.criterion,
						verified: ac.verified ?? false,
					})),
					verifyCommand: st.verifyCommand,
					branch: parent.branch,
					owner: parent.owner,
					createdAt: now,
					updatedAt: now,
					metadata: {},
					source: "pi",
				};

				// Wire dependencies based on strategy
				if (strategy === "sequential" && createdIds.length > 0) {
					// Each task blocks the next
					const prevId = createdIds[createdIds.length - 1];
					subtask.blockedBy.push(prevId);
					store.tasks[prevId].blocks.push(id);
				} else if (strategy === "phases") {
					// Group by label — same-label tasks are parallel, different labels are sequential
					// For simplicity: just sequential for now
					if (createdIds.length > 0) {
						const prevId = createdIds[createdIds.length - 1];
						subtask.blockedBy.push(prevId);
						store.tasks[prevId].blocks.push(id);
					}
				}
				// "parallel" — no dependencies between subtasks

				// Check if blocked
				if (subtask.blockedBy.some((bid) => store.tasks[bid]?.status !== "completed")) {
					subtask.status = "blocked";
				}

				store.tasks[id] = subtask;
				createdIds.push(id);

				if (!parent.subtasks) parent.subtasks = [];
				parent.subtasks.push(id);

				emitEvent("task:created", { taskId: id, source: "decompose", subject: st.subject });
			}

			parent.updatedAt = now;
			saveStore(cwd, store);

			const summary = createdIds
				.map((id, i) => `  ${i + 1}. [${id.slice(0, 8)}] ${params.subtasks[i].subject}`)
				.join("\n");

			return {
				content: [{
					type: "text" as const,
					text: `Decomposed [${parent.id.slice(0, 8)}] "${parent.subject}" into ${createdIds.length} subtasks (${strategy}):\n${summary}`,
				}],
				details: { parentTaskId: parent.id, subtaskIds: createdIds },
			};
		},
	});

	// ── Tool: TaskArchive ──────────────────────────────────────────────

	pi.registerTool({
		name: "TaskArchive",
		label: "TaskArchive",
		description: "Move completed/deleted tasks to archive files.",
		parameters: Type.Object({
			status: Type.Optional(StringEnum(["completed", "deleted"] as const, { default: "completed" })),
			olderThan: Type.Optional(
				Type.Number({ description: "Epoch ms — only archive tasks older than this" }),
			),
		}),
		promptSnippet: "Archive completed tasks",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const store = loadStore(cwd);
			const targetStatus = params.status ?? "completed";
			const cutoff = params.olderThan ?? 0;

			const toArchive: Task[] = [];
			const toKeep: Record<string, Task> = {};

			for (const [id, task] of Object.entries(store.tasks)) {
				if (
					task.status === targetStatus &&
					(cutoff === 0 || (task.completedAt ?? task.updatedAt) < cutoff)
				) {
					toArchive.push(task);
				} else {
					toKeep[id] = task;
				}
			}

			if (toArchive.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No ${targetStatus} tasks to archive.` }],
				};
			}

			const archiveDir = join(ensureTasksDir(cwd), "archive");
			if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

			const date = new Date();
			const archiveFile = join(
				archiveDir,
				`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}.json`,
			);

			let archive: Task[] = [];
			if (existsSync(archiveFile)) {
				archive = JSON.parse(readFileSync(archiveFile, "utf8"));
			}
			archive.push(...toArchive);
			writeFileSync(archiveFile, JSON.stringify(archive, null, "\t") + "\n");

			store.tasks = toKeep;
			saveStore(cwd, store);

			emitEvent("tasks:archived", { count: toArchive.length });

			return {
				content: [{
					type: "text" as const,
					text: `Archived ${toArchive.length} ${targetStatus} task(s).`,
				}],
			};
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	//  COMMANDS
	// ═══════════════════════════════════════════════════════════════════

	// ── Command: /tasks ────────────────────────────────────────────────

	pi.registerCommand("tasks", {
		description: "Task board — interactive overlay for viewing and managing tasks",
		async run(args, ctx) {
			const store = loadStore(ctx.cwd);
			const allTasks = Object.values(store.tasks).filter((t) => t.status !== "deleted");

			if (allTasks.length === 0) {
				ctx.ui.notify("No tasks. Use TaskCreate or TodoWrite to add tasks.", "info");
				return;
			}

			// Sort: in_progress first, then by priority
			allTasks.sort((a, b) => {
				const statusOrder: Record<TaskStatus, number> = {
					in_progress: 0, blocked: 1, pending: 2, review: 3, completed: 4, deleted: 5,
				};
				const so = statusOrder[a.status] - statusOrder[b.status];
				if (so !== 0) return so;
				return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
			});

			const state: BoardState = {
				tasks: allTasks,
				selectedIdx: 0,
				scrollOffset: 0,
				filter: "all",
				expanded: new Set(),
			};

			const filterOrder: Array<"all" | TaskStatus> = [
				"all", "in_progress", "blocked", "pending", "review", "completed",
			];

			ctx.ui.custom<string | null>((tui, theme, kb, done) => {
				// Use fixed overlay dimensions for layout calculations
				const overlayWidth = 60;
				const overlayHeight = 24;

				return {
					render(width: number): string[] {
						return renderTaskBoard(theme, state, overlayWidth, overlayHeight);
					},
					handleInput(data) {
						const key = data;

						if (matchesKey(key, "up") || key === "k") {
							if (state.selectedIdx > 0) {
								state.selectedIdx--;
								// Scroll up if needed
								const visibleHeight = overlayHeight - 5;
								if (state.selectedIdx < state.scrollOffset) {
									state.scrollOffset = state.selectedIdx;
								}
							}
							tui.requestRender();
						} else if (matchesKey(key, "down") || key === "j") {
							const filtered = state.filter === "all"
								? state.tasks
								: state.tasks.filter((t) => t.status === state.filter);
							if (state.selectedIdx < filtered.length - 1) {
								state.selectedIdx++;
								const visibleHeight = overlayHeight - 5;
								if (state.selectedIdx >= state.scrollOffset + visibleHeight) {
									state.scrollOffset = state.selectedIdx - visibleHeight + 1;
								}
							}
							tui.requestRender();
						} else if (key === "Enter") {
							const filtered = state.filter === "all"
								? state.tasks
								: state.tasks.filter((t) => t.status === state.filter);
							const task = filtered[state.selectedIdx];
							if (task) {
								if (state.expanded.has(task.id)) {
									state.expanded.delete(task.id);
								} else {
									state.expanded.add(task.id);
								}
							}
							tui.requestRender();
						} else if (key === "f") {
							// Cycle filter
							const currentIdx = filterOrder.indexOf(state.filter);
							state.filter = filterOrder[(currentIdx + 1) % filterOrder.length];
							state.selectedIdx = 0;
							state.scrollOffset = 0;
							tui.requestRender();
						} else if (key === "n") {
							// Get next task
							const next = findNextTask(loadStore(ctx.cwd));
							if (next) {
								const idx = state.tasks.findIndex((t) => t.id === next.id);
								if (idx >= 0) {
									state.selectedIdx = idx;
									state.expanded.add(next.id);
									// Scroll into view
									const visibleHeight = overlayHeight - 5;
									if (idx < state.scrollOffset) state.scrollOffset = idx;
									if (idx >= state.scrollOffset + visibleHeight) {
										state.scrollOffset = idx - visibleHeight + 1;
									}
								}
							}
							tui.requestRender();
						} else if (key === "a") {
							// Quick archive
							done("archive");
						} else if (matchesKey(key, "escape") || key === "q") {
							done(null);
						}
					},
					dispose() {},
				};
			}, {
				overlay: true,
				overlayOptions: { anchor: "center", width: 60, maxHeight: 24 },
			}).then((result) => {
				if (result === "archive") {
					// Quick archive completed tasks
					const store = loadStore(ctx.cwd);
					const completed = Object.values(store.tasks).filter(
						(t) => t.status === "completed",
					);
					if (completed.length > 0) {
						ctx.ui.notify(
							`${completed.length} completed task(s). Use TaskArchive tool to archive.`,
							"info",
						);
					} else {
						ctx.ui.notify("No completed tasks to archive.", "info");
					}
				}
			});
		},
	});
}
