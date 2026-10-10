import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/parity/**/*.test.ts"],
    setupFiles: ["src/testing/sandbox.ts"],
    globals: false,
    // Several sessions run suites on one machine; at load 70 an ordinary store test takes 5–7 s (2026-10-11).
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        // bun:sqlite does not exist under Node; `pnpm smoke:bun` runs this driver instead.
        "src/store/drivers/bun-sqlite.ts",
        // Declarations whose callbacks drizzle-kit runs, in its own process; the baseline test checks its output.
        "src/store/sqlite/schema.ts",
        // Run only with real worker threads, from dist; `pnpm check:dist` drives two of them under Node and Bun.
        "src/embeddings/worker.ts",
        "src/embeddings/workers.ts",
        // A child process run from dist; `pnpm check:dist` drives it under Node and Bun.
        "src/embeddings/child.ts",
        "src/embeddings/process.ts",
        // stdin, argv and an exit code around parityProblems, which the parity tests cover.
        "src/parity/bin.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // A little under what the suite reaches (2026-09-29), so coverage can rise and not fall.
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 89,
        branches: 77,
        perFile: { lines: 50 },
      },
    },
  },
})
