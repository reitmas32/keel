import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveOrg } from "../config.js";
import { createGitFixture, type GitFixture, git } from "../testing/git-fixture.js";
import { createVersion } from "./create-version.js";
import { deploy } from "./deploy.js";

let fx: GitFixture;
let requests: { method: string; url: string; body: unknown }[];

const fakeApi: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input.toString();
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  requests.push({ method: init?.method ?? "GET", url, body });
  if (url.endsWith("/repos/konectus-io/app/services")) {
    return Response.json({ repo: "konectus-io/app", services: [{ alias: "api-prod" }, { alias: "worker" }] });
  }
  if (url.endsWith("/deploys")) return Response.json({ id: "d1", status: "waiting_ci", ...body }, { status: 202 });
  return Response.json({ error: "no" }, { status: 404 });
}) as typeof fetch;

const run = (opts: Parameters<typeof deploy>[0]) => deploy({ cwd: fx.work, home: fx.home, fetch: fakeApi, ...opts });

beforeEach(async () => {
  fx = await createGitFixture();
  requests = [];
  await createVersion({ version: "v1.0.0", cwd: fx.work, home: fx.home });
  await fx.commit(fx.work, "b.txt");
  git(fx.work, "push", "-q", "origin", "main");
  // v1.10.0 must win over v1.2.0: numeric, not lexical, ordering.
  await createVersion({ version: "v1.2.0", cwd: fx.work, home: fx.home });
  await createVersion({ version: "v1.10.0", cwd: fx.work, home: fx.home });
});

afterEach(async () => {
  await fx.cleanup();
});

describe("deploy", () => {
  it("--latest picks the highest semver tag and sends its commit", async () => {
    const result = await run({ service: "api-prod", latest: true });

    expect(result.status).toBe("waiting_ci");
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe("https://keel.konectus.internal/api/deploys");
    expect(post?.body).toEqual({
      repo: "konectus-io/app",
      tag: "v1.10.0",
      sha: git(fx.work, "rev-parse", "v1.10.0^{commit}"),
      service: "api-prod",
    });
  });

  it("sends the commit of an explicit version", async () => {
    await run({ service: "worker", version: "v1.0.0" });

    const post = requests.find((r) => r.method === "POST");
    expect(post?.body).toMatchObject({ tag: "v1.0.0", sha: git(fx.work, "rev-parse", "v1.0.0^{commit}") });
  });

  it("rejects an unknown service or version", async () => {
    await expect(run({ service: "nope", latest: true })).rejects.toThrow(/Disponibles: api-prod, worker/);
    await expect(run({ service: "api-prod", version: "v9.9.9" })).rejects.toThrow(/v9.9.9 no existe/);
  });

  it("rejects a repo outside the active org", async () => {
    await setActiveOrg("github.com:jalocompany", fx.home);

    await expect(run({ service: "api-prod", latest: true })).rejects.toThrow(/no puede desplegar/);
    expect(requests).toEqual([]);
  });
});
