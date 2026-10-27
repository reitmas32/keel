import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

describe("keel program", () => {
  it("registers the four commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual([
      "login",
      "use",
      "create-version",
      "deploy",
      "rollback",
      "scopes",
      "versions",
      "deploys",
      "update",
    ]);
  });
});
