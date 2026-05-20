/**
 * Tests for messenger extension — message bus CRUD, cross-agent messaging.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageBus } from "./message-bus.js";

let testDir: string;

beforeAll(() => {
	testDir = mkdtempSync(join(tmpdir(), "msg-test-"));
});

afterAll(() => {
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
	// Clean message dirs between tests
	try { rmSync(testDir, { recursive: true, force: true }); } catch {}
	testDir = mkdtempSync(join(tmpdir(), "msg-test-"));
});

describe("MessageBus — send and receive", () => {
	it("sends a message to an agent's inbox", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		const msg = hub.send("alpha", "hello from hub");

		expect(msg.id).toBeTruthy();
		expect(msg.from).toBe("hub");
		expect(msg.to).toBe("alpha");
		expect(msg.body).toBe("hello from hub");
		expect(msg.read).toBe(false);

		// File exists in alpha's inbox
		expect(existsSync(join(testDir, "alpha", `${msg.id}.json`))).toBe(true);
	});

	it("reads inbox messages in order", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		const msg1 = hub.send("alpha", "msg 1");
		const msg2 = hub.send("alpha", "msg 2");

		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		const messages = alpha.readInbox();

		expect(messages.length).toBe(2);
		const bodies = messages.map((m) => m.body);
		expect(bodies).toContain("msg 1");
		expect(bodies).toContain("msg 2");
	});

	it("marks messages as read", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		hub.send("alpha", "hello");

		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		const first = alpha.readInbox();
		expect(first.length).toBe(1);
		expect(first[0].read).toBe(true);

		// Read again — should show as read
		const second = alpha.readInbox();
		expect(second[0].read).toBe(true);
	});

	it("reads only unread messages", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		hub.send("alpha", "msg 1");

		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		
		// First read — should find 1 unread
		const first = alpha.readUnread();
		expect(first.length).toBe(1);

		// After reading, readUnread should return 0 (marked read by readInbox inside readUnread)
		const second = alpha.readUnread();
		expect(second.length).toBe(0);
	});
});

describe("MessageBus — broadcast", () => {
	it("sends to _broadcast channel", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		const msg = hub.broadcast("heads up everyone");

		expect(msg.to).toBe("_broadcast");
		expect(existsSync(join(testDir, "_broadcast", `${msg.id}.json`))).toBe(true);
	});
});

describe("MessageBus — cross-agent communication", () => {
	it("two agents can exchange messages", () => {
		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		const beta = new MessageBus({ messagesDir: testDir, agentName: "beta" });

		// Alpha sends to beta
		alpha.send("beta", "auth module is done");

		// Beta reads
		const inbox = beta.readInbox();
		expect(inbox.length).toBe(1);
		expect(inbox[0].body).toBe("auth module is done");
		expect(inbox[0].from).toBe("alpha");

		// Beta replies
		beta.send("alpha", "thanks, starting integration");

		// Alpha reads reply
		const reply = alpha.readInbox();
		expect(reply.length).toBe(1);
		expect(reply[0].body).toBe("thanks, starting integration");
		expect(reply[0].from).toBe("beta");
	});

	it("hub can coordinate multiple agents", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		const beta = new MessageBus({ messagesDir: testDir, agentName: "beta" });

		hub.send("alpha", "work on feature A");
		hub.send("beta", "work on feature B");

		expect(alpha.readInbox().length).toBe(1);
		expect(beta.readInbox().length).toBe(1);

		// Alpha reports back
		alpha.send("hub", "feature A done");

		const hubInbox = hub.readInbox();
		expect(hubInbox.length).toBe(1);
		expect(hubInbox[0].body).toBe("feature A done");
	});
});

describe("MessageBus — list agents", () => {
	it("lists agents that have inboxes", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		hub.send("alpha", "hello");
		hub.send("beta", "hello");

		const agents = hub.listAgents();
		expect(agents).toContain("alpha");
		expect(agents).toContain("beta");
	});

	it("excludes _broadcast from agent list", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		hub.broadcast("test");

		const agents = hub.listAgents();
		expect(agents).not.toContain("_broadcast");
	});
});

describe("MessageBus — cleanup", () => {
	it("clears inbox", () => {
		const hub = new MessageBus({ messagesDir: testDir, agentName: "hub" });
		hub.send("alpha", "msg 1");
		hub.send("alpha", "msg 2");

		const alpha = new MessageBus({ messagesDir: testDir, agentName: "alpha" });
		expect(alpha.readInbox().length).toBe(2);

		alpha.clearInbox();
		expect(alpha.readInbox().length).toBe(0);
	});

	it("prunes old messages", async () => {
		const pruneDir = mkdtempSync(join(tmpdir(), "msg-prune-"));
		const bus = new MessageBus({
			messagesDir: pruneDir,
			agentName: "hub",
			maxMessageAge: 100,
		});

		bus.send("alpha", "old message");
		
		await new Promise((r) => setTimeout(r, 200));

		const pruned = bus.prune();
		expect(pruned).toBe(1);

		try { rmSync(pruneDir, { recursive: true, force: true }); } catch {}
	}, 5000);
});
