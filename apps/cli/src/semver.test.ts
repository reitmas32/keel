import { describe, expect, it } from "vitest";
import { compareSemverDesc, isSemverTag } from "./semver.js";

describe("semver", () => {
  it("sorts newest first, numerically, with prereleases below releases", () => {
    const tags = ["v1.2.0", "v1.10.0", "v1.10.0-rc.1", "v0.9.9", "v2.0.0-beta.2", "v2.0.0-beta.10"];
    expect(tags.sort(compareSemverDesc)).toEqual([
      "v2.0.0-beta.10",
      "v2.0.0-beta.2",
      "v1.10.0",
      "v1.10.0-rc.1",
      "v1.2.0",
      "v0.9.9",
    ]);
  });

  it("requires the v prefix and three components", () => {
    expect(isSemverTag("v1.0.0")).toBe(true);
    expect(isSemverTag("1.0.0")).toBe(false);
    expect(isSemverTag("v1.0")).toBe(false);
  });
});
