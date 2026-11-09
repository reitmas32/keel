import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Trace from the monorepo root so the standalone bundle includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@keel/shared"],
  // node-postgres stays a runtime require (not bundled), so output tracing copies it and its dependencies into the
  // standalone bundle. Next lists `pg` by default; it's spelled out because keel needs it with DB_ENGINE=postgres.
  serverExternalPackages: ["pg"],
  // Type checking runs via `pnpm typecheck` (tsc); Next's builtin checker doesn't support TypeScript 7.
  typescript: { ignoreBuildErrors: true },
  // The admin's "Scopes" became "Apps" in v0.7.0 (same ids); old bookmarks land on the new pages.
  redirects: async () => [{ source: "/scopes/:path*", destination: "/apps/:path*", permanent: true }],
};

export default config;
