import { describe, expect, it } from "vitest";
import { latestReleaseTag, releaseTarballUrl, update } from "./update.js";

const githubWith = (tag: string | undefined, status = 200): typeof fetch =>
  (async () => Response.json({ tag_name: tag }, { status })) as unknown as typeof fetch;

const recorder = (exitCode = 0) => {
  const runs: string[][] = [];
  return {
    runs,
    run: async (command: string, args: string[]) => {
      runs.push([command, ...args]);
      return exitCode;
    },
  };
};

describe("keel update", () => {
  it("does nothing when already on the latest release", async () => {
    const { runs, run } = recorder();
    const result = await update({ currentVersion: "0.3.0", fetch: githubWith("v0.3.0"), run });
    expect(result).toEqual({ status: "up-to-date", current: "v0.3.0", latest: "v0.3.0" });
    expect(runs).toEqual([]);
  });

  it("never downgrades a newer local build", async () => {
    const { runs, run } = recorder();
    expect((await update({ currentVersion: "0.4.0", fetch: githubWith("v0.3.0"), run })).status).toBe("up-to-date");
    expect(runs).toEqual([]);
  });

  it("installs the latest release tarball with npm", async () => {
    const { runs, run } = recorder();
    const result = await update({ currentVersion: "0.2.0", fetch: githubWith("v0.10.0"), run });
    expect(result).toEqual({ status: "updated", current: "v0.2.0", latest: "v0.10.0" });
    expect(runs).toEqual([
      ["npm", "install", "--global", "https://github.com/reitmas32/keel/releases/download/v0.10.0/keel-cli.tgz"],
    ]);
  });

  it("--check only reports the new version", async () => {
    const { runs, run } = recorder();
    const result = await update({ currentVersion: "0.2.0", check: true, fetch: githubWith("v0.3.0"), run });
    expect(result).toEqual({ status: "available", current: "v0.2.0", latest: "v0.3.0" });
    expect(runs).toEqual([]);
  });

  it("reports a failed npm install with the command to retry", async () => {
    const { run } = recorder(243);
    await expect(update({ currentVersion: "0.2.0", fetch: githubWith("v0.3.0"), run })).rejects.toThrow(
      /código 243 y keel sigue en v0.2.0.*npm install --global https:\/\/github.com\/reitmas32\/keel\/releases\/download\/v0.3.0\/keel-cli.tgz/,
    );
  });

  it("explains GitHub errors and invalid tags", async () => {
    await expect(latestReleaseTag(githubWith(undefined, 403))).rejects.toThrow(/GitHub respondió 403/);
    await expect(latestReleaseTag(githubWith("nightly"))).rejects.toThrow(/tag válido/);
  });

  it("builds the tarball URL of a release", () => {
    expect(releaseTarballUrl("v1.2.3")).toBe("https://github.com/reitmas32/keel/releases/download/v1.2.3/keel-cli.tgz");
  });
});
