import { describe, expect, it } from "vitest";
import { parseGithubRemote } from "./git.js";

describe("parseGithubRemote", () => {
  it.each([
    "git@github.com:konectus-io/app.git",
    "git@github.com:konectus-io/app",
    "https://github.com/konectus-io/app.git",
    "https://github.com/konectus-io/app",
    "ssh://git@github.com/konectus-io/app.git",
  ])("parses %s", (url) => {
    expect(parseGithubRemote(url)).toEqual({ host: "github.com", owner: "konectus-io", name: "app" });
  });

  it("returns undefined for a local path", () => {
    expect(parseGithubRemote("/tmp/repo.git")).toBeUndefined();
  });
});
