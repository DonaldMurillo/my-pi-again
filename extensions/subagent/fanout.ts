/**
 * Fanout — parallel dispatch of prompts across multiple subagents.
 *
 * Takes an array of prompt items, spawns one agent per item,
 * respects concurrency limits, and returns structured results.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface FanoutItem {
	prompt: string;
	task?: string;
}

export interface FanoutResult {
	results: Array<FanoutItemResult>;
	errors: Array<FanoutItemError>;
	duration: number;
	totalCost: number;
}

export interface FanoutItemResult {
	name: string;
	prompt: string;
	task?: string;
	output: string;
	success: boolean;
	turns: number;
	cost: number;
}

export interface FanoutItemError {
	name: string;
	prompt: string;
	task?: string;
	error: string;
}

export interface FanoutOptions {
	items: FanoutItem[];
	profile?: string;
	model?: string;
	tools?: string[] | null;
	concurrency?: number;     // default 3
	failFast?: boolean;        // default false
}

// ─── Batch helper ───────────────────────────────────────────────────

/**
 * Split items into batches of the given size.
 */
export function batchItems<T>(items: T[], batchSize: number): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += batchSize) {
		batches.push(items.slice(i, i + batchSize));
	}
	return batches;
}

/**
 * Generate a deterministic agent name for a fanout item.
 */
export function fanoutAgentName(fanoutId: string, itemIndex: number): string {
	return `fanout-${fanoutId}-${itemIndex}`;
}

/**
 * Build a FanoutResult from individual results and errors.
 */
export function buildFanoutResult(
	results: FanoutItemResult[],
	errors: FanoutItemError[],
	startedAt: number,
): FanoutResult {
	return {
		results,
		errors,
		duration: Date.now() - startedAt,
		totalCost: results.reduce((sum, r) => sum + r.cost, 0),
	};
}
