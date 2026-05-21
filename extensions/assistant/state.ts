/**
 * Assistant state management — activation, messages, persistence.
 */

import type {
	PersonalityProfile,
	AssistantState,
	AssistantConfig,
	Message,
} from "./types.js";
import { loadAllAssistants } from "./personalities.js";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG: AssistantConfig = {
	maxHistoryLength: 100,
	responseTimeoutMs: 30_000,
	selectedAssistantId: "are-we-there-yet",
};

export function createInitialState(projectDir: string): AssistantState {
	return {
		activated: false,
		messages: [],
		sessionHistory: [],
		repromptCount: 0,
		activity: "idle",
		evalHistory: [],
		lastSnapshotHash: "",
		assistants: loadAllAssistants(projectDir),
		config: { ...DEFAULT_CONFIG },
	};
}

export function getSelectedAssistant(state: AssistantState): PersonalityProfile | undefined {
	return state.assistants.get(state.config.selectedAssistantId);
}

// ─── Messages ────────────────────────────────────────────────────────

export function addMessage(
	state: AssistantState,
	role: "user" | "assistant",
	content: string,
): Message {
	const msg: Message = {
		id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		role,
		content,
		timestamp: Date.now(),
	};

	state.messages.push(msg);

	// Trim to max length
	if (state.messages.length > state.config.maxHistoryLength) {
		state.messages = state.messages.slice(-state.config.maxHistoryLength);
	}

	return msg;
}

export function clearMessages(state: AssistantState): void {
	state.messages = [];
}

// ─── Persistence ─────────────────────────────────────────────────────

const STATE_FILE = (cwd: string) => join(cwd, ".pi", "assistant", "state.json");

interface Serialized {
	activated: boolean;
	messages: Message[];
	config: AssistantConfig;
}

export function persistState(state: AssistantState, cwd: string): void {
	const dir = join(cwd, ".pi", "assistant");
	try {
		mkdirSync(dir, { recursive: true });
		const data: Serialized = {
			activated: state.activated,
			messages: state.messages.slice(-(state.config.maxHistoryLength)),
			config: state.config,
		};
		writeFileSync(STATE_FILE(cwd), JSON.stringify(data, null, "\t") + "\n");
	} catch {
		// best effort
	}
}

export function loadPersistedState(state: AssistantState, cwd: string): void {
	const file = STATE_FILE(cwd);
	if (!existsSync(file)) return;

	try {
		const raw = readFileSync(file, "utf8");
		const data = JSON.parse(raw) as Serialized;

		state.activated = data.activated ?? false;
		state.messages = Array.isArray(data.messages) ? data.messages : [];
		if (data.config) {
			state.config = { ...state.config, ...data.config };
		}
	} catch {
		// corrupted — start fresh
	}
}
