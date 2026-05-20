import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts"],
		testTimeout: 120_000, // e2e tests need time for pi to start
		hookTimeout: 30_000,
	},
});
