import { describe, it, expect } from "vitest";
import { batchItems, fanoutAgentName, buildFanoutResult } from "./fanout.js";

describe("fanout", () => {
	describe("batchItems", () => {
		it("splits items into batches", () => {
			const items = [1, 2, 3, 4, 5, 6, 7];
			const batches = batchItems(items, 3);
			expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
		});

		it("returns single batch when items fit", () => {
			const items = [1, 2, 3];
			const batches = batchItems(items, 5);
			expect(batches).toEqual([[1, 2, 3]]);
		});

		it("returns empty array for empty input", () => {
			expect(batchItems([], 3)).toEqual([]);
		});

		it("handles batch size of 1", () => {
			const items = [1, 2, 3];
			const batches = batchItems(items, 1);
			expect(batches).toEqual([[1], [2], [3]]);
		});
	});

	describe("fanoutAgentName", () => {
		it("generates deterministic names", () => {
			expect(fanoutAgentName("abc", 0)).toBe("fanout-abc-0");
			expect(fanoutAgentName("abc", 2)).toBe("fanout-abc-2");
		});

		it("different fanout IDs produce different names", () => {
			expect(fanoutAgentName("a", 0)).not.toBe(fanoutAgentName("b", 0));
		});
	});

	describe("buildFanoutResult", () => {
		it("calculates total cost", () => {
			const startedAt = Date.now() - 5000;

			const result = buildFanoutResult(
				[
					{ name: "a", prompt: "p1", output: "ok", success: true, turns: 2, cost: 0.001 },
					{ name: "b", prompt: "p2", output: "ok", success: true, turns: 3, cost: 0.002 },
				],
				[],
				startedAt,
			);

			expect(result.totalCost).toBe(0.003);
			expect(result.results).toHaveLength(2);
			expect(result.errors).toHaveLength(0);
			expect(result.duration).toBeGreaterThanOrEqual(5000);
		});

		it("includes errors in result", () => {
			const startedAt = Date.now();
			const result = buildFanoutResult(
				[],
				[{ name: "c", prompt: "p3", error: "failed" }],
				startedAt,
			);

			expect(result.results).toHaveLength(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].error).toBe("failed");
		});
	});
});
