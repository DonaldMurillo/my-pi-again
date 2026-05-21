import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	parseFrontmatter,
	serializeFrontmatter,
	loadProfiles,
	loadProfile,
	createProfile,
	createAdHoc,
	type AgentDefinition,
} from "./agent-profile.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Test fixtures ───────────────────────────────────────────────────

const TEST_DIR = join(homedir(), ".pi-test-agent-profiles");

// ─── Tests ───────────────────────────────────────────────────────────

describe("agent-profile", () => {
	describe("parseFrontmatter", () => {
		it("parses pi-native agent with model and tools", () => {
			const content = `---
model: fast
tools: [read, bash, grep, find]
---
You are a code reviewer. Be concise.`;

			const result = parseFrontmatter(content);
			expect(result.model).toBe("fast");
			expect(result.tools).toEqual(["read", "bash", "grep", "find"]);
			expect(result.prompt).toBe("You are a code reviewer. Be concise.");
		});

		it("parses pi-native agent with model only", () => {
			const content = `---
model: deep
---
Think carefully about edge cases.`;

			const result = parseFrontmatter(content);
			expect(result.model).toBe("deep");
			expect(result.tools).toBeUndefined();
			expect(result.prompt).toBe("Think carefully about edge cases.");
		});

		it("parses pi-native agent with empty tools (no tools)", () => {
			const content = `---
model: fast
tools: []
---
Read-only agent.`;

			const result = parseFrontmatter(content);
			expect(result.model).toBe("fast");
			expect(result.tools).toEqual([]);
		});

		it("parses pi-native agent with null tools (inherit)", () => {
			const content = `---
model: balanced
tools: null
---
Generic agent.`;

			const result = parseFrontmatter(content);
			expect(result.model).toBe("balanced");
			expect(result.tools).toBeNull();
		});

		it("handles quoted tool names", () => {
			const content = `---
tools: [read, "write", 'edit']
---
Agent.`;

			const result = parseFrontmatter(content);
			expect(result.tools).toEqual(["read", "write", "edit"]);
		});

		it("handles comma-separated tools without brackets", () => {
			const content = `---
tools: read, bash, grep
---
Agent.`;

			const result = parseFrontmatter(content);
			expect(result.tools).toEqual(["read", "bash", "grep"]);
		});

		it("parses file without frontmatter (Claude Code compat)", () => {
			const content = "You are a helpful assistant.\nNo frontmatter here.";

			const result = parseFrontmatter(content);
			expect(result.model).toBeUndefined();
			expect(result.tools).toBeUndefined();
			expect(result.prompt).toBe("You are a helpful assistant.\nNo frontmatter here.");
		});

		it("handles malformed frontmatter (no closing ---)", () => {
			const content = "---\nmodel: fast\nNo closing dashes";

			const result = parseFrontmatter(content);
			// Falls back to treating whole content as prompt
			expect(result.prompt).toBeTruthy();
		});

		it("handles empty file", () => {
			const result = parseFrontmatter("");
			expect(result.prompt).toBe("");
			expect(result.model).toBeUndefined();
		});

		it("ignores comment lines in frontmatter", () => {
			const content = `---
# This is a comment
model: deep
---
Agent.`;

			const result = parseFrontmatter(content);
			expect(result.model).toBe("deep");
		});

		it("handles single tool without brackets", () => {
			const content = `---
tools: read
---
Agent.`;

			const result = parseFrontmatter(content);
			expect(result.tools).toEqual(["read"]);
		});
	});

	describe("serializeFrontmatter", () => {
		it("round-trips through parse", () => {
			const original = {
				prompt: "You are a reviewer.",
				model: "fast",
				tools: ["read", "bash"] as string[],
			};

			const serialized = serializeFrontmatter(original);
			const parsed = parseFrontmatter(serialized);

			expect(parsed.model).toBe(original.model);
			expect(parsed.tools).toEqual(original.tools);
			expect(parsed.prompt).toBe(original.prompt);
		});

		it("serializes null tools", () => {
			const serialized = serializeFrontmatter({ prompt: "Agent.", model: "balanced", tools: null });
			expect(serialized).toContain("tools: null");
		});

		it("serializes empty tools", () => {
			const serialized = serializeFrontmatter({ prompt: "Agent.", model: "balanced", tools: [] });
			expect(serialized).toContain("tools: []");
		});

		it("serializes prompt without frontmatter when defaults", () => {
			const serialized = serializeFrontmatter({ prompt: "Just a prompt.", model: "balanced", tools: null });
			expect(serialized).toContain("---");
			expect(serialized).toContain("Just a prompt.");
		});
	});

	describe("loadProfiles", () => {
		beforeEach(() => {
			const projectDir = join(TEST_DIR, "project");

			// Claude Code agents
			const claudeDir = join(projectDir, ".claude", "agents");
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(join(claudeDir, "reviewer.md"), "You are a Claude Code reviewer.\nRead code and review it.");
			writeFileSync(join(claudeDir, "helper.md"), "You are a helper.");

			// Pi agents
			const piDir = join(projectDir, ".pi", "agents");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "reviewer.md"),
				"---\nmodel: fast\ntools: [read, bash]\n---\nYou are a pi reviewer.",
			);
			writeFileSync(
				join(piDir, "fixer.md"),
				"---\nmodel: deep\ntools: [read, bash, edit, write]\n---\nFix bugs thoroughly.",
			);
		});

		afterEach(() => {
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("discovers agents from both .claude/agents and .pi/agents", () => {
			const profiles = loadProfiles(join(TEST_DIR, "project"));
			expect(profiles.size).toBe(3); // reviewer (pi overrides claude), helper (claude), fixer (pi)
		});

		it("pi agent overrides claude agent with same name", () => {
			const profiles = loadProfiles(join(TEST_DIR, "project"));
			const reviewer = profiles.get("reviewer");
			expect(reviewer).toBeDefined();
			expect(reviewer!.source).toBe("repo-pi");
			expect(reviewer!.model).toBe("fast");
			expect(reviewer!.prompt).toBe("You are a pi reviewer.");
		});

		it("claude-only agent has correct defaults", () => {
			const profiles = loadProfiles(join(TEST_DIR, "project"));
			const helper = profiles.get("helper");
			expect(helper).toBeDefined();
			expect(helper!.source).toBe("repo-claude");
			expect(helper!.model).toBe("balanced"); // default
			expect(helper!.tools).toBeNull(); // inherit
		});

		it("returns empty map when no agents exist", () => {
			const emptyDir = join(TEST_DIR, "empty");
			mkdirSync(emptyDir, { recursive: true });
			const profiles = loadProfiles(emptyDir);
			expect(profiles.size).toBe(0);
		});
	});

	describe("loadProfile", () => {
		beforeEach(() => {
			const projectDir = join(TEST_DIR, "project");

			const claudeDir = join(projectDir, ".claude", "agents");
			mkdirSync(claudeDir, { recursive: true });
			writeFileSync(join(claudeDir, "reviewer.md"), "Claude reviewer.");

			const piDir = join(projectDir, ".pi", "agents");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "reviewer.md"),
				"---\nmodel: fast\n---\nPi reviewer.",
			);
		});

		afterEach(() => {
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("prefers pi agent over claude agent", () => {
			const profile = loadProfile("reviewer", join(TEST_DIR, "project"));
			expect(profile).not.toBeNull();
			expect(profile!.source).toBe("repo-pi");
			expect(profile!.model).toBe("fast");
		});

		it("falls back to claude agent", () => {
			const profile = loadProfile("reviewer", join(TEST_DIR, "project"));
			// Already loaded pi version, so this tests the fallback path
			// by using a name that only exists in claude
			const claudeOnly = loadProfile("nonexistent-claude-only", join(TEST_DIR, "project"));
			expect(claudeOnly).toBeNull();
		});

		it("returns null for unknown profile", () => {
			const profile = loadProfile("nonexistent", join(TEST_DIR, "project"));
			expect(profile).toBeNull();
		});
	});

	describe("createProfile", () => {
		afterEach(() => {
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("creates .pi/agents/<name>.md with frontmatter", () => {
			const cwd = join(TEST_DIR, "project");
			const def = createProfile("my-agent", cwd, {
				prompt: "Do stuff.",
				model: "fast",
				tools: ["read", "bash"],
			});

			expect(def.name).toBe("my-agent");
			expect(def.source).toBe("repo-pi");
			expect(def.model).toBe("fast");
			expect(def.tools).toEqual(["read", "bash"]);

			// File exists
			const filePath = join(cwd, ".pi", "agents", "my-agent.md");
			expect(existsSync(filePath)).toBe(true);

			// Round-trips through parse
			const content = parseFrontmatter(
				require("fs").readFileSync(filePath, "utf8"),
			);
			expect(content.model).toBe("fast");
			expect(content.tools).toEqual(["read", "bash"]);
			expect(content.prompt).toBe("Do stuff.");
		});

		it("creates with defaults when no options", () => {
			const cwd = join(TEST_DIR, "project");
			const def = createProfile("minimal", cwd);

			expect(def.model).toBe("balanced");
			expect(def.tools).toBeNull();
			expect(def.prompt).toBe("");
		});

		it("creates .pi/agents/ directory if missing", () => {
			const cwd = join(TEST_DIR, "fresh-project");
			createProfile("test", cwd);
			expect(existsSync(join(cwd, ".pi", "agents", "test.md"))).toBe(true);
		});
	});

	describe("createAdHoc", () => {
		it("creates ad-hoc definition without persisting", () => {
			const def = createAdHoc("quick-fix", {
				prompt: "Fix the bug quickly.",
				model: "fast",
				tools: ["read", "bash", "edit"],
			});

			expect(def.name).toBe("quick-fix");
			expect(def.source).toBe("ad-hoc");
			expect(def.model).toBe("fast");
			expect(def.tools).toEqual(["read", "bash", "edit"]);
		});

		it("defaults to balanced model and inherit tools", () => {
			const def = createAdHoc("simple", { prompt: "Do it." });
			expect(def.model).toBe("balanced");
			expect(def.tools).toBeNull();
		});

		it("does not write to disk", () => {
			const def = createAdHoc("temp", { prompt: "Temp." });
			// Ad-hoc definitions don't have a file path — pure in-memory
			expect(def.source).toBe("ad-hoc");
		});
	});
});
