import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/env.setup.ts"],
    globals: false,
    hookTimeout: 20000,
    testTimeout: 20000,
    // All test files share one real Postgres database and each truncates it
    // in beforeEach — running files in parallel races those truncations
    // against in-flight inserts in other files, so this must stay serial.
    fileParallelism: false,
  },
});
