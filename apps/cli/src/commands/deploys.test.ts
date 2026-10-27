import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveOrg } from "../config.js";
import { createGitFixture, type GitFixture } from "../testing/git-fixture.js";
import { deploys } from "./deploys.js";

let fx: GitFixture;
let urls: string[];

const deploy = {
  id: "d3f1a9c2-0000-4000-8000-000000000003",
  repo: "konectus-io/app",
  tag: "v1.0.0",
  sha: "a".repeat(40),
  service: "api-prod",
  status: "deployed",
  error: null,
  createdAt: "2026-10-27T10:00:00Z",
  updatedAt: "2026-10-27T10:05:00Z",
  finishedAt: "2026-10-27T10:05:00Z",
};

const fakeApi: typeof fetch = (async (input: string | URL | Request) => {
  const url = input.toString();
  urls.push(url);
  if (url.includes("/deploys/d3f1")) return Response.json({ ...deploy, serviceKind: "application", tagVariable: null });
  if (url.includes("/deploys")) return Response.json({ repo: "konectus-io/app", deploys: [deploy] });
  return Response.json({ error: "no" }, { status: 404 });
}) as typeof fetch;

const run = (opts: Parameters<typeof deploys>[0] = {}) =>
  deploys({
    cwd: fx.work,
    home: fx.home,
    fetch: fakeApi,
    now: new Date("2026-10-27T12:00:00Z"),
    timeZone: "UTC",
    ...opts,
  });

beforeEach(async () => {
  fx = await createGitFixture();
  urls = [];
});

afterEach(async () => {
  await fx.cleanup();
});

describe("keel deploys", () => {
  it("lists the deploys of the current repo from the active org's API", async () => {
    const text = await run({ service: "api-prod", limit: 5 });
    expect(urls).toEqual(["https://keel.konectus.internal/api/repos/konectus-io/app/deploys?service=api-prod&limit=5"]);
    expect(text).toContain("konectus-io/app · github.com:konectus-io");
    expect(text).toContain("✔ desplegado");
  });

  it("shows one deploy by id prefix", async () => {
    const text = await run({ id: "d3f1" });
    expect(urls).toEqual(["https://keel.konectus.internal/api/repos/konectus-io/app/deploys/d3f1"]);
    expect(text).toContain("Deploy d3f1a9c2 · konectus-io/app");
  });

  it("prints JSON for scripts", async () => {
    expect(JSON.parse(await run({ json: true }))).toEqual([deploy]);
  });

  it("rejects a repo outside the active org and invalid limits", async () => {
    await expect(run({ limit: 0 })).rejects.toThrow(/-n debe ser/);
    await setActiveOrg("github.com:jalocompany", fx.home);
    await expect(run()).rejects.toThrow(/no puede consultar deploys/);
    expect(urls).toEqual([]);
  });
});
