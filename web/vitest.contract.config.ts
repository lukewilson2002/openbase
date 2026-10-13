import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Live contract tests: the TypeScript API client against the real Rust server.
 * `npm run test:contract`. See contract/README.md.
 *
 * Separate from vite.config.ts on purpose: no jsdom, no React plugins, and the global setup
 * builds and boots `target/debug/openbase`.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "contract",
    environment: "node",
    include: ["contract/**/*.test.ts"],
    globalSetup: ["./contract/globalSetup.ts"],
    // One server, shared database: files and tests run in order, never in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    // The first run compiles the server (cargo build) inside globalSetup.
    hookTimeout: 900_000,
  },
});
