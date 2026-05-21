/**
 * Shared types for the assistant extension.
 */

/** A single personality trait with intensity. */
export interface PersonalityTrait {
	name: string;
	value: number; // 0-1
	description: string;
}

/** A full assistant personality profile. */
export interface PersonalityProfile {
	id: string;
	name: string;
	description: string;
	traits: PersonalityTrait[];
	goals: string[];
	constraints: string[];
	systemPrompt: string;
	color: string; // theme color key
	icon: string;  // single emoji
}

/** A chat message in an assistant session. */
export interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

/** Global assistant config. */
export interface AssistantConfig {
	maxHistoryLength: number;
	provider?: string;
	model?: string;
	responseTimeoutMs: number;
	/** Which assistant ID is currently selected. */
	selectedAssistantId: string;
}

/** What the assistant is currently doing. */
export type AssistantActivity = "idle" | "thinking" | "reading";

/** A snapshot of a single AWTY evaluation. */
export interface EvalMemory {
	round: number;
	achieved: boolean;
	summary: string;
	gaps: string[];
	fixes: string[];
	wasFallback: boolean; // true if parser hit strategy 4
	timestamp: number;
}

/** The full runtime state of the extension. */
export interface AssistantState {
	/** Whether the assistant system is activated. */
	activated: boolean;
	/** Current conversation messages. */
	messages: Message[];
	/** Accumulated session history across all agent turns. */
	sessionHistory: Array<{ role: string; text: string }>;
	/** How many times AWTY has auto-reprompted in this session. */
	repromptCount: number;
	/** What the assistant is currently doing (for status line). */
	activity: AssistantActivity;
	/** Previous evaluation results for progressive evaluation. */
	evalHistory: EvalMemory[];
	/** Hash of last file snapshot to detect if anything changed. */
	lastSnapshotHash: string;
	/** All loaded assistant profiles (defaults + custom). */
	assistants: Map<string, PersonalityProfile>;
	/** Config -- persisted across sessions. */
	config: AssistantConfig;
}
