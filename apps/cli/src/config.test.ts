import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveOrg, listOrgs, normalizeApiUrl, saveOrg, setActiveOrg, validateOrg } from "./config.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "keel-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("config", () => {
  it("stores each org in its own folder and tracks the active one", async () => {
    await saveOrg({ org: "github.com:jalocompany", apiUrl: "https://keel.jalo.internal/api" }, home);
    await saveOrg({ org: "github.com:konectus-io", apiUrl: "https://keel.konectus.internal/api" }, home);
    await setActiveOrg("github.com:konectus-io", home);

    expect(await listOrgs(home)).toEqual(["github.com:jalocompany", "github.com:konectus-io"]);
    expect((await getActiveOrg(home)).apiUrl).toBe("https://keel.konectus.internal/api");

    const stored = JSON.parse(await readFile(join(home, "github.com:jalocompany", "config.json"), "utf8"));
    expect(stored).toEqual({ org: "github.com:jalocompany", apiUrl: "https://keel.jalo.internal/api" });

    await setActiveOrg("github.com:jalocompany", home);
    expect((await getActiveOrg(home)).org).toBe("github.com:jalocompany");
  });

  it("refuses to activate an org that was never logged in", async () => {
    await expect(setActiveOrg("github.com:nope", home)).rejects.toThrow(/keel login/);
  });

  it("asks to log in when nothing is active", async () => {
    await expect(getActiveOrg(home)).rejects.toThrow(/keel login/);
  });

  it("validates the org format", () => {
    expect(validateOrg("github.com:konectus-io")).toBeUndefined();
    expect(validateOrg("konectus-io")).toBeDefined();
  });

  it("defaults the API URL scheme to https", () => {
    expect(normalizeApiUrl("keel.konectus.internal/api/")).toBe("https://keel.konectus.internal/api");
    expect(normalizeApiUrl("http://localhost:3000/api")).toBe("http://localhost:3000/api");
  });
});
