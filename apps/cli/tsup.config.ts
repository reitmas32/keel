import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Bundle the workspace package so the published CLI has no workspace deps.
  noExternal: ["@keel/shared"],
  banner: { js: "#!/usr/bin/env node" },
});
