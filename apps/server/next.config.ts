import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Trace from the monorepo root so the standalone bundle includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@keel/shared"],
  // Type checking runs via `pnpm typecheck` (tsc); Next's builtin checker doesn't support TypeScript 7.
  typescript: { ignoreBuildErrors: true },
};

export default config;
