import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@keel/shared"],
  // Type checking runs via `pnpm typecheck` (tsc); Next's builtin checker doesn't support TypeScript 7.
  typescript: { ignoreBuildErrors: true },
};

export default config;
