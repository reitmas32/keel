import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const setupFiles = ["./src/lib/test-setup.ts"];

// The store-backed tests run twice: on SQLite, and on Postgres. Postgres is PGlite (in memory, no Docker) unless
// TEST_POSTGRES_DSN points at a real server, as in CI. Pure tests (auth, env, Dokploy client) only need SQLite's run.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server (sqlite)",
          root,
          include: ["src/**/*.test.ts"],
          setupFiles,
          env: { KEEL_TEST_DB: "sqlite" },
        },
      },
      {
        test: {
          name: process.env.TEST_POSTGRES_DSN ? "server (postgres)" : "server (pglite)",
          root,
          include: ["src/**/*.test.ts"],
          exclude: ["src/lib/auth.test.ts", "src/lib/env.test.ts", "src/lib/dokploy.test.ts"],
          setupFiles,
          env: { KEEL_TEST_DB: "postgres" },
          // PGlite boots a WASM Postgres per test file.
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
