/**
 * MCP Discovery Extension for Pi
 *
 * Reads MCP server configs from `.pi/mcp-servers.json` and provides
 * incremental tool discovery instead of loading all tools at startup.
 *
 * Provides:
 *   - `list_mcp_servers` tool — list configured servers and their status
 *   - `search_mcp_tools` tool — search/filter tools across servers, with activation
 *   - `/mcp` command — interactive TUI overlay for browsing servers & tools
 *
 * Config format (`.pi/mcp-servers.json`):
 * {
 *   "servers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *       "env": { "API_KEY": "..." },
 *       "disabled": false
 *     }
 *   }
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

// ─── Types ───────────────────────────────────────────────────────────

interface MCPServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}

interface MCPConfig {
	servers: Record<string, MCPServerConfig>;
}

interface MCPTool {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
	};
	serverName: string;
}

interface ServerState {
	status: "disconnected" | "connecting" | "connected" | "error";
	tools: MCPTool[];
	error?: string;
	pid?: number;
}

// ─── JSON-RPC helpers ────────────────────────────────────────────────

let jsonRpcId = 0;

function jsonRpcRequest(method: string, params?: unknown): string {
	const msg = {
		jsonrpc: "2.0",
		id: ++jsonRpcId,
		method,
		...(params !== undefined ? { params } : {}),
	};
	return JSON.stringify(msg);
}

// ─── MCP Client ──────────────────────────────────────────────────────

class MCPClient extends EventEmitter {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private pending = new Map<number, {
		resolve: (result: unknown) => void;
		reject: (err: Error) => void;
	}>();
	private _status: ServerState["status"] = "disconnected";
	private _tools: MCPTool[] = [];
	private _error?: string;
	private initialized = false;

	constructor(
		public readonly name: string,
		private readonly config: MCPServerConfig,
		private readonly cwd: string,
	) {
		super();
	}

	get status(): ServerState["status"] { return this._status; }
	get tools(): MCPTool[] { return this._tools; }
	get error(): string | undefined { return this._error; }

	get state(): ServerState {
		return {
			status: this._status,
			tools: this._tools,
			error: this._error,
			pid: this.proc?.pid,
		};
	}

	async connect(): Promise<void> {
		if (this._status === "connected" || this._status === "connecting") return;
		this._status = "connecting";
		this.emit("status", this.state);

		try {
			const env = { ...process.env, ...this.config.env };
			this.proc = spawn(this.config.command, this.config.args ?? [], {
				cwd: this.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			if (!this.proc.stdin || !this.proc.stdout) {
				throw new Error(`Failed to create stdio pipes for server "${this.name}"`);
			}

			this.proc.on("error", (err) => {
				this._status = "error";
				this._error = err.message;
				this.emit("status", this.state);
			});

			this.proc.on("exit", (code) => {
				if (this._status !== "error") {
					this._status = "disconnected";
					this._error = code ? `Process exited with code ${code}` : undefined;
				}
				this.proc = null;
				this.emit("status", this.state);
			});

			// Drain stderr to prevent pipe blockage
			this.proc.stderr?.on("data", () => {});

			this.proc.stdout.on("data", (chunk: Buffer) => {
				this.buffer += chunk.toString("utf8");
				this.parseMessages();
			});

			// Initialize MCP protocol
			await this.sendRequest("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-mcp-discovery", version: "1.0.0" },
			});

			// Send initialized notification
			const initNotif = JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/initialized",
			});
			this.proc.stdin.write(initNotif + "\n");

			this.initialized = true;
			this._status = "connected";
			this._error = undefined;

			// Discover tools
			const result = await this.sendRequest("tools/list", {}) as {
				tools?: Array<{
					name: string;
					description?: string;
					inputSchema?: MCPTool["inputSchema"];
				}>;
			};

			this._tools = (result.tools ?? []).map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema ?? { type: "object", properties: {} },
				serverName: this.name,
			}));

			this.emit("status", this.state);
		} catch (err) {
			this._status = "error";
			this._error = err instanceof Error ? err.message : String(err);
			this.emit("status", this.state);
		}
	}

	async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.proc || this._status !== "connected") {
			throw new Error(`Server "${this.name}" is not connected`);
		}
		return this.sendRequest("tools/call", {
			name: toolName,
			arguments: args,
		});
	}

	disconnect(): void {
		if (this.proc) {
			try {
				this.proc.kill("SIGTERM");
			} catch {
				// already dead
			}
			this.proc = null;
		}
		this._status = "disconnected";
		this._tools = [];
		this._error = undefined;
		this.initialized = false;
		this.pending.clear();
	}

	private parseMessages(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const headerStr = this.buffer.slice(0, headerEnd);
			const match = headerStr.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				this.buffer = this.buffer.slice(headerEnd + 4);
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + contentLength;

			if (this.buffer.length < bodyEnd) break;

			const body = this.buffer.slice(bodyStart, bodyEnd);
			this.buffer = this.buffer.slice(bodyEnd);

			try {
				const msg = JSON.parse(body);
				if (msg.id !== undefined && this.pending.has(msg.id)) {
					const { resolve, reject } = this.pending.get(msg.id)!;
					this.pending.delete(msg.id);
					if (msg.error) {
						reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
					} else {
						resolve(msg.result);
					}
				}
			} catch {
				// Malformed JSON — skip
			}
		}
	}

	private sendRequest(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++jsonRpcId;
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request "${method}" timed out (id=${id})`));
			}, 30_000);

			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolve(result);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			const msg = jsonRpcRequest(method, params);
			const framed = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;

			if (!this.proc?.stdin?.writable) {
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(new Error(`Server "${this.name}" stdin is not writable`));
				return;
			}

			this.proc.stdin.write(framed);
		});
	}
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const clients = new Map<string, MCPClient>();
	const activatedTools = new Map<string, string>(); // toolName → serverName
	let configPath: string | null = null;
	let config: MCPConfig | null = null;
	let fileWatcher: ReturnType<typeof watchFile> | null = null;

	// ── Config loading ──

	function loadConfig(cwd: string): void {
		configPath = join(cwd, ".pi", "mcp-servers.json");
		if (!existsSync(configPath)) {
			config = null;
			return;
		}
		try {
			const raw = readFileSync(configPath, "utf8");
			config = JSON.parse(raw) as MCPConfig;
		} catch (err) {
			pi.events.emit("mcp-discovery:error", {
				message: `Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`,
			});
			config = null;
		}
	}

	// ── Server lifecycle ──

	async function connectServer(name: string, cfg: MCPServerConfig, cwd: string): Promise<MCPClient> {
		const existing = clients.get(name);
		if (existing) {
			existing.disconnect();
		}

		const client = new MCPClient(name, cfg, cwd);
		clients.set(name, client);

		client.on("status", (state: ServerState) => {
			pi.events.emit("mcp-discovery:server-status", { name, state });
		});

		await client.connect();
		return client;
	}

	function disconnectAll(): void {
		for (const client of clients.values()) {
			client.disconnect();
		}
		clients.clear();
		activatedTools.clear();
	}

	// ── Tool search ──

	function searchTools(query: string, serverName?: string, limit?: number): MCPTool[] {
		const q = query.toLowerCase();
		let results: MCPTool[] = [];

		for (const client of clients.values()) {
			if (serverName && client.name !== serverName) continue;
			for (const tool of client.tools) {
				const nameMatch = tool.name.toLowerCase().includes(q);
				const descMatch = tool.description?.toLowerCase().includes(q) ?? false;
				if (nameMatch || descMatch || q === "") {
					results.push(tool);
				}
			}
		}

		if (limit && limit > 0) {
			results = results.slice(0, limit);
		}

		return results;
	}

	// ── Dynamic tool activation ──

	function activateTool(serverName: string, tool: MCPTool): void {
		const qualifiedName = tool.name;
		if (activatedTools.has(qualifiedName)) return;
		activatedTools.set(qualifiedName, serverName);

		// Build a permissive typebox schema from MCP inputSchema
		const properties: Record<string, unknown> = {};
		if (tool.inputSchema.properties) {
			for (const [key, val] of Object.entries(tool.inputSchema.properties)) {
				properties[key] = val;
			}
		}

		const schema = Type.Object(properties, {
			required: tool.inputSchema.required,
		});

		pi.registerTool({
			name: qualifiedName,
			label: `MCP: ${tool.name}`,
			description: tool.description ?? `MCP tool from ${serverName}`,
			promptSnippet: `MCP tool: ${tool.name} (${serverName})${tool.description ? ` — ${tool.description.slice(0, 80)}` : ""}`,
			parameters: schema,
			async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
				const client = clients.get(serverName);
				if (!client || client.status !== "connected") {
					throw new Error(`Server "${serverName}" is not connected. Use search_mcp_tools to reconnect.`);
				}

				onUpdate?.({
					content: [{ type: "text", text: `Calling ${tool.name} on ${serverName}...` }],
				});

				const result = await client.callTool(tool.name, params as Record<string, unknown>);

				// MCP tool results: { content: [...], isError?: boolean }
				if (result && typeof result === "object" && "content" in result) {
					const mcpResult = result as {
						content: Array<{ type: string; text?: string }>;
						isError?: boolean;
					};

					if (mcpResult.isError) {
						throw new Error(
							mcpResult.content.map((c) => c.text ?? JSON.stringify(c)).join("\n"),
						);
					}

					const text = mcpResult.content
						.map((c) => c.type === "text" ? (c.text ?? "") : JSON.stringify(c))
						.join("\n");

					return {
						content: [{ type: "text", text }],
						details: { server: serverName, tool: tool.name },
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: { server: serverName, tool: tool.name },
				};
			},
		});
	}

	// ── Register tools ──

	pi.registerTool({
		name: "list_mcp_servers",
		label: "List MCP Servers",
		description:
			"List all configured MCP servers and their connection status. " +
			"Shows server name, command, status (connected/disconnected/error), " +
			"number of available tools, and any error messages. " +
			"Does NOT activate any tools — use search_mcp_tools to discover and activate tools.",
		promptSnippet: "List configured MCP servers and their connection status",
		promptGuidelines: [
			"Use list_mcp_servers when the user asks about available MCP servers or their status.",
		],
		parameters: Type.Object({}),
		async execute() {
			if (!config) {
				return {
					content: [{
						type: "text",
						text: "No `.pi/mcp-servers.json` configuration found. Create one to define MCP servers.",
					}],
					details: { servers: [] },
				};
			}

			const serverInfos = Object.entries(config.servers).map(([name, cfg]) => {
				const client = clients.get(name);
				const status = client?.status ?? "disconnected";
				const toolCount = client?.tools.length ?? 0;
				const error = client?.error;
				const disabled = cfg.disabled ?? false;

				return {
					name,
					command: `${cfg.command} ${(cfg.args ?? []).join(" ")}`,
					status,
					toolCount,
					disabled,
					error,
				};
			});

			const lines = serverInfos.map((s) => {
				const statusIcon = s.disabled ? "⊘" : s.status === "connected" ? "●" : s.status === "connecting" ? "◌" : s.status === "error" ? "✗" : "○";
				const toolInfo = s.status === "connected" ? ` (${s.toolCount} tools)` : "";
				const errInfo = s.error ? ` — ${s.error}` : "";
				return `${statusIcon} ${s.name}: ${s.status}${toolInfo}${errInfo}\n  Command: ${s.command}`;
			});

			return {
				content: [{
					type: "text",
					text: lines.length > 0
						? lines.join("\n\n")
						: "No MCP servers configured.",
				}],
				details: { servers: serverInfos },
			};
		},
	});

	pi.registerTool({
		name: "search_mcp_tools",
		label: "Search MCP Tools",
		description:
			"Search for tools across connected MCP servers by name or description. " +
			"Optionally activate tools to make them available as callable tools. " +
			"When activate is true, matching tools are registered and immediately usable by the LLM. " +
			"Use query '' (empty string) to list all available tools. " +
			"Use server_name to limit search to a specific server.",
		promptSnippet: "Search and optionally activate MCP tools from connected servers",
		promptGuidelines: [
			"Use search_mcp_tools to discover tools from MCP servers before using them.",
			"Always set activate=true when the user wants to USE a specific MCP tool.",
			"Use search_mcp_tools with an empty query to browse all available tools.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query — matches against tool name and description. Use '' to list all.",
			}),
			server_name: Type.Optional(Type.String({
				description: "Limit search to a specific server by name.",
			})),
			activate: Type.Optional(Type.Boolean({
				description: "If true, register matching tools so they become callable. Default: false.",
			})),
			limit: Type.Optional(Type.Number({
				description: "Maximum number of results to return. Default: 20.",
			})),
		}),
		async execute(_toolCallId, params) {
			const { query, server_name, activate = false, limit = 20 } = params;

			// Auto-connect disconnected servers when searching
			if (config) {
				for (const [name, cfg] of Object.entries(config.servers)) {
					if (cfg.disabled) continue;
					if (server_name && name !== server_name) continue;
					const client = clients.get(name);
					if (!client || client.status === "disconnected" || client.status === "error") {
						try {
							await connectServer(name, cfg, process.cwd());
						} catch {
							// Connection errors are stored in client state
						}
					}
				}
			}

			const results = searchTools(query, server_name, limit);

			if (results.length === 0) {
				return {
					content: [{
						type: "text",
						text: `No tools found matching "${query}". Ensure servers are configured in .pi/mcp-servers.json and connected.`,
					}],
					details: { query, results: [] },
				};
			}

			// Activate if requested
			const activated: string[] = [];
			if (activate) {
				for (const tool of results) {
					activateTool(tool.serverName, tool);
					activated.push(tool.name);
				}
			}

			const lines = results.map((t) => {
				const alreadyActive = activatedTools.has(t.name);
				const badge = alreadyActive || activate ? " [active]" : "";
				return `● ${t.name} (${t.serverName})${badge}\n  ${t.description ?? "No description"}`;
			});

			const summary = activate && activated.length > 0
				? `\n\nActivated ${activated.length} tool(s): ${activated.join(", ")}`
				: "\n\nSet activate=true to register these tools for use.";

			return {
				content: [{
					type: "text",
					text: `Found ${results.length} tool(s) matching "${query}":\n\n${lines.join("\n\n")}${summary}`,
				}],
				details: {
					query,
					activated,
					results: results.map((t) => ({
						name: t.name,
						server: t.serverName,
						description: t.description,
					})),
				},
			};
		},
	});

	// ── /mcp command ──

	type ColorKey = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted" | "border";

	class MCPModal {
		private theme: Theme;
		private onClose: () => void;
		private ctx: ExtensionContext;
		private servers: Array<{
			name: string;
			cfg: MCPServerConfig;
			state: ServerState;
		}>;
		private scrollOffset = 0;
		private totalLines = 0;
		private selectedServer: number | null = null;

		constructor(ctx: ExtensionContext, theme: Theme, onClose: () => void) {
			this.theme = theme;
			this.onClose = onClose;
			this.ctx = ctx;

			this.servers = [];
			if (config) {
				for (const [name, cfg] of Object.entries(config.servers)) {
					const client = clients.get(name);
					this.servers.push({
						name,
						cfg,
						state: client?.state ?? { status: "disconnected", tools: [] },
					});
				}
			}
		}

		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
				this.onClose();
				return;
			}
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				if (this.scrollOffset > 0) this.scrollOffset--;
				this.invalidate();
				return;
			}
			if (matchesKey(data, "down") || matchesKey(data, "j")) {
				const maxScroll = Math.max(0, this.totalLines - 24);
				if (this.scrollOffset < maxScroll) this.scrollOffset++;
				this.invalidate();
			}
			if (matchesKey(data, "tab")) {
				if (this.servers.length > 0) {
					this.selectedServer = this.selectedServer === null
						? 0
						: (this.selectedServer + 1) % this.servers.length;
					this.invalidate();
				}
			}
		}

		render(width: number): string[] {
			const th = this.theme;
			const inner = Math.min(width - 4, 64);
			const lines: string[] = [];

			const b = {
				tl: th.fg("border", "╔"),
				tr: th.fg("border", "╗"),
				bl: th.fg("border", "╚"),
				br: th.fg("border", "╝"),
				h: th.fg("border", "═"),
				v: th.fg("border", "║"),
				hl: th.fg("border", "╟"),
				hr: th.fg("border", "╢"),
			};

			const padLine = (content: string) => {
				const pad = Math.max(0, inner - visibleWidth(content));
				return b.v + " " + content + " ".repeat(pad) + " " + b.v;
			};
			const emptyRow = () => padLine(" ".repeat(inner));
			const divider = () => b.hl + th.fg("borderMuted", "─".repeat(inner + 2)) + b.hr;

			// Title bar
			const title = " ⚡ MCP Discovery ";
			const titleLen = visibleWidth(title);
			const hLeft = Math.max(1, Math.floor((inner + 2 - titleLen) / 2));
			const hRight = Math.max(1, inner + 2 - titleLen - hLeft);
			lines.push(b.tl + b.h.repeat(hLeft) + th.bold(th.fg("accent", title)) + b.h.repeat(hRight) + b.tr);
			lines.push(emptyRow());

			if (this.servers.length === 0) {
				lines.push(padLine(th.fg("dim", "No MCP servers configured.")));
				lines.push(padLine(th.fg("dim", "Create .pi/mcp-servers.json")));
				lines.push(emptyRow());
			} else {
				for (let i = 0; i < this.servers.length; i++) {
					if (i > 0) lines.push(emptyRow());
					const srv = this.servers[i];
					const isSelected = this.selectedServer === i;
					const cursor = isSelected ? th.fg("accent", "▸ ") : "  ";

					const statusIcon = this.statusIcon(th, srv.state.status, srv.cfg.disabled);
					const nameColor: ColorKey = srv.cfg.disabled ? "dim" : "accent";
					const toolCount = srv.state.tools.length;
					const toolStr = srv.state.status === "connected"
						? th.fg("muted", ` (${toolCount} tool${toolCount !== 1 ? "s" : ""})`)
						: "";

					lines.push(padLine(
						cursor + statusIcon + " " + th.fg(nameColor, srv.name) + toolStr,
					));
					lines.push(padLine(
						"    " + th.fg("dim", `$ ${srv.cfg.command} ${(srv.cfg.args ?? []).join(" ")}`),
					));

					if (srv.state.error) {
						lines.push(padLine(
							"    " + th.fg("error", `✗ ${srv.state.error}`),
						));
					}

					// Show tools when server is selected and connected
					if (isSelected && srv.state.status === "connected" && srv.state.tools.length > 0) {
						lines.push(emptyRow());
						const maxTools = Math.min(srv.state.tools.length, 8);
						for (let t = 0; t < maxTools; t++) {
							const tool = srv.state.tools[t];
							const isActive = activatedTools.has(tool.name);
							const activeBadge = isActive
								? " " + th.fg("success", "●")
								: "";
							lines.push(padLine(
								"    " + th.fg("text", tool.name) + activeBadge,
							));
							if (tool.description) {
								const desc = tool.description.length > 50
									? tool.description.slice(0, 47) + "..."
									: tool.description;
								lines.push(padLine(
									"      " + th.fg("dim", desc),
								));
							}
						}
						if (srv.state.tools.length > maxTools) {
							lines.push(padLine(
								"    " + th.fg("dim", `... +${srv.state.tools.length - maxTools} more`),
							));
						}
					}
				}
			}

			// Footer
			lines.push(emptyRow());
			lines.push(divider());

			const totalTools = Array.from(clients.values())
				.reduce((sum, c) => sum + c.tools.length, 0);
			const activeCount = activatedTools.size;
			const statusLine = `${this.servers.length} server${this.servers.length !== 1 ? "s" : ""} · ${totalTools} tools · ${activeCount} active`;
			lines.push(padLine(th.fg("muted", statusLine)));

			lines.push(divider());
			lines.push(padLine(th.fg("dim", "tab cycle  ↑↓ scroll  esc close")));
			lines.push(b.bl + b.h.repeat(inner + 2) + b.br);

			this.totalLines = lines.length;
			const maxVis = 28;
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - maxVis));
			return lines.length > maxVis
				? lines.slice(this.scrollOffset, this.scrollOffset + maxVis)
				: lines;
		}

		private statusIcon(th: Theme, status: ServerState["status"], disabled?: boolean): string {
			if (disabled) return th.fg("dim", "⊘");
			switch (status) {
				case "connected": return th.fg("success", "●");
				case "connecting": return th.fg("warning", "◌");
				case "error": return th.fg("error", "✗");
				default: return th.fg("dim", "○");
			}
		}

		invalidate(): void { /* re-render */ }
	}

	function showMCPModal(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/mcp requires interactive mode", "error");
			return Promise.resolve();
		}
		return ctx.ui.custom<void>(
			(_tui, theme, _kb, done) => new MCPModal(ctx, theme, () => done()),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 68, maxHeight: 30 },
			},
		);
	}

	pi.registerCommand("mcp", {
		description: "Show MCP servers, tools, and activation status",
		getArgumentCompletions(prefix: string) {
			const subs = ["connect", "disconnect", "status", "activate"];
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		async handler(args, ctx) {
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0];

			if (sub === "status" || !sub) {
				await showMCPModal(ctx);
				return;
			}

			if (sub === "connect") {
				const serverName = parts[1];
				if (!config) {
					ctx.ui.notify("No .pi/mcp-servers.json found", "warning");
					return;
				}

				const targets = serverName
					? { [serverName]: config.servers[serverName] }
					: Object.fromEntries(
						Object.entries(config.servers).filter(([, c]) => !c.disabled),
					);

				for (const [name, cfg] of Object.entries(targets)) {
					if (!cfg) {
						ctx.ui.notify(`Unknown server: ${name}`, "error");
						continue;
					}
					ctx.ui.setStatus("mcp", `Connecting ${name}...`);
					await connectServer(name, cfg, ctx.cwd);
					const client = clients.get(name);
					if (client?.status === "connected") {
						ctx.ui.notify(`${name}: connected (${client.tools.length} tools)`, "success");
					} else {
						ctx.ui.notify(`${name}: ${client?.error ?? "failed"}`, "error");
					}
				}
				ctx.ui.setStatus("mcp", undefined);
				return;
			}

			if (sub === "disconnect") {
				const serverName = parts[1];
				if (serverName) {
					const client = clients.get(serverName);
					if (client) {
						client.disconnect();
						clients.delete(serverName);
						ctx.ui.notify(`Disconnected ${serverName}`, "info");
					} else {
						ctx.ui.notify(`Unknown server: ${serverName}`, "warning");
					}
				} else {
					disconnectAll();
					ctx.ui.notify("All MCP servers disconnected", "info");
				}
				return;
			}

			if (sub === "activate") {
				const toolName = parts[1];
				if (!toolName) {
					ctx.ui.notify("Usage: /mcp activate <tool-name>", "warning");
					return;
				}
				for (const client of clients.values()) {
					const tool = client.tools.find((t) => t.name === toolName);
					if (tool) {
						activateTool(client.name, tool);
						ctx.ui.notify(`Activated tool: ${toolName} (${client.name})`, "success");
						return;
					}
				}
				ctx.ui.notify(`Tool not found: ${toolName}`, "error");
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${sub}. Use: status, connect, disconnect, activate`, "warning");
		},
	});

	// ── Lifecycle ──

	pi.on("session_start", async (_event, ctx) => {
		loadConfig(ctx.cwd);

		// Watch config file for changes
		if (configPath && existsSync(configPath)) {
			fileWatcher = watchFile(configPath, { interval: 2000 }, () => {
				loadConfig(ctx.cwd);
				pi.events.emit("mcp-discovery:config-changed", { path: configPath });
			});
		}

		// Notify readiness (lazy — servers connect on first search)
		pi.events.emit("mcp-discovery:ready", {
			servers: config ? Object.keys(config.servers) : [],
		});
	});

	pi.on("session_shutdown", async () => {
		if (fileWatcher && configPath) {
			unwatchFile(configPath, fileWatcher);
			fileWatcher = null;
		}
		disconnectAll();
	});
}
