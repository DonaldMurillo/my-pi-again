import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts", "tests/**/*.test.ts", "evals/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		nodeOptions: ["--max-old-space-size=8192"],
	},
});
