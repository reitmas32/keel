import { describe, expect, it } from "vitest";
import { recordCiResult, registerVersion } from "./deploys";
import { handlers } from "./handlers";
import { createTestContext, SHA } from "./testing";

const RUN = "https://github.com/konectus-io/app/actions/runs/123";
const register = (tag = "v1.4.0") => ({
  repo: "konectus-io/app",
  tag,
  sha: SHA,
  branch: "hotfix/login",
  createdByName: "Ana",
  createdByEmail: "ana@jalo.mx",
});
const ci = (status: "success" | "failure" | "cancelled", tag = "v1.4.0", runUrl?: string) => ({
  repo: "konectus-io/app",
  tag,
  sha: SHA,
  status,
  ...(runUrl && { runUrl }),
});

describe("versions", () => {
  it("goes from pending to the CI outcome, keeping who created it and from which branch", () => {
    const { store, clock, ciToken } = createTestContext();
    expect(registerVersion(store, register(), clock.now())).toMatchObject({
      tag: "v1.4.0",
      branch: "hotfix/login",
      createdByName: "Ana",
      ciStatus: "pending",
      ciFinishedAt: null,
    });

    clock.advanceMinutes(5);
    recordCiResult(store, ci("success", "v1.4.0", RUN), ciToken, clock.now());

    expect(store.getVersion("konectus-io/app", "v1.4.0")).toMatchObject({
      branch: "hotfix/login",
      createdByEmail: "ana@jalo.mx",
      ciStatus: "success",
      ciFinishedAt: "2026-10-26T12:05:00.000Z",
      runUrl: RUN,
    });
  });

  it("learns of a version from its CI alone when create-version could not register it", () => {
    const { store, clock, ciToken } = createTestContext();
    recordCiResult(store, ci("failure"), ciToken, clock.now());

    expect(store.getVersion("konectus-io/app", "v1.4.0")).toMatchObject({
      ciStatus: "failure",
      branch: null,
      createdByName: null,
      runUrl: null,
    });
  });

  it("a late registration fills in the author without undoing the CI outcome", () => {
    const { store, clock, ciToken } = createTestContext();
    recordCiResult(store, ci("success"), ciToken, clock.now());
    registerVersion(store, register(), clock.now());

    expect(store.getVersion("konectus-io/app", "v1.4.0")).toMatchObject({
      ciStatus: "success",
      branch: "hotfix/login",
      createdByName: "Ana",
    });
  });

  it("an invalid CI token records nothing", () => {
    const { store, clock } = createTestContext();
    expect(() => recordCiResult(store, ci("success"), "keel_wrong", clock.now())).toThrow(/Token de CI inválido/);
    expect(store.getVersion("konectus-io/app", "v1.4.0")).toBeUndefined();
  });

  it("rejects registering a version for a repo without a scope", () => {
    const { store, clock } = createTestContext();
    expect(() => registerVersion(store, { ...register(), repo: "other/repo" }, clock.now())).toThrow(
      /no está vinculado/,
    );
  });

  it("expires pending versions whose CI never reports, and still accepts a late result", async () => {
    const { store, worker, clock, ciToken } = createTestContext();
    registerVersion(store, register("v1.4.0"), clock.now());
    clock.advanceMinutes(30);
    registerVersion(store, register("v1.5.0"), clock.now());

    clock.advanceMinutes(31);
    await worker.tick();
    expect(store.getVersion("konectus-io/app", "v1.4.0")?.ciStatus).toBe("expired");
    expect(store.getVersion("konectus-io/app", "v1.5.0")?.ciStatus).toBe("pending");

    recordCiResult(store, ci("success", "v1.4.0"), ciToken, clock.now());
    expect(store.getVersion("konectus-io/app", "v1.4.0")?.ciStatus).toBe("success");
  });

  it("lists newest first and filters by CI status", () => {
    const { store, clock, ciToken } = createTestContext();
    registerVersion(store, register("v1.4.0"), clock.now());
    clock.advanceMinutes(1);
    registerVersion(store, register("v1.5.0"), clock.now());
    recordCiResult(store, ci("success", "v1.4.0"), ciToken, clock.now());

    expect(store.listVersions("konectus-io/app").map((v) => v.tag)).toEqual(["v1.5.0", "v1.4.0"]);
    expect(store.listVersions("Konectus-IO/App", { status: "success" }).map((v) => v.tag)).toEqual(["v1.4.0"]);
  });
});

describe("version API", () => {
  const post = (body: unknown) =>
    new Request("http://keel.test/api/versions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("registers with POST /versions and lists with GET /repos/:owner/:name/versions", async () => {
    const { ctx } = createTestContext();

    const created = await handlers.registerVersion(ctx, post(register()));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ tag: "v1.4.0", ciStatus: "pending" });

    const list = await handlers.listRepoVersions(ctx, "konectus-io", "app", new URLSearchParams());
    expect(await list.json()).toMatchObject({ repo: "konectus-io/app", versions: [{ tag: "v1.4.0" }] });

    const filtered = await handlers.listRepoVersions(ctx, "konectus-io", "app", new URLSearchParams("status=success"));
    expect((await filtered.json()).versions).toEqual([]);
  });

  it("validates the body, the query and the repo", async () => {
    const { ctx } = createTestContext();

    expect((await handlers.registerVersion(ctx, post({ repo: "konectus-io/app" }))).status).toBe(400);
    expect((await handlers.registerVersion(ctx, post({ ...register(), repo: "other/repo" }))).status).toBe(404);
    const bad = await handlers.listRepoVersions(ctx, "konectus-io", "app", new URLSearchParams("status=green"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/pending, success/);
    expect((await handlers.listRepoVersions(ctx, "other", "repo", new URLSearchParams())).status).toBe(404);
  });

  it("ci-result accepts the run link and old Actions that don't send it", async () => {
    const { ctx, store, ciToken } = createTestContext();
    const send = (body: unknown) =>
      handlers.ciResult(
        ctx,
        new Request("http://keel.test/api/ci-result", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ciToken}` },
          body: JSON.stringify(body),
        }),
      );

    expect((await send(ci("success", "v1.4.0", RUN))).status).toBe(200);
    expect((await send(ci("success", "v1.5.0"))).status).toBe(200);
    expect((await send({ ...ci("success", "v1.6.0"), runUrl: "not a url" })).status).toBe(400);

    expect(store.getVersion("konectus-io/app", "v1.4.0")?.runUrl).toBe(RUN);
    expect(store.getVersion("konectus-io/app", "v1.5.0")?.runUrl).toBeNull();
  });
});
