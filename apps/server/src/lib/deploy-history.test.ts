import type { Deploy, DeployDetail } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { handlers } from "./handlers";
import { createTestContext, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };
const ciReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" as const };
const params = (query = "") => new URLSearchParams(query);

describe("deploy milestones", () => {
  it("records when the CI passed, when Dokploy started and when it finished", async () => {
    const { store, worker, dokploy, clock, ciToken } = createTestContext();
    const { id } = requestDeploy(store, deployReq, clock.now());
    expect(store.getDeploy(id)).toMatchObject({ ciPassedAt: null, deployStartedAt: null, finishedAt: null });

    clock.advanceMinutes(3);
    recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    clock.advanceMinutes(2);
    dokploy.status = "done";
    await worker.tick();

    expect(store.getDeploy(id)).toMatchObject({
      status: "deployed",
      createdAt: "2026-10-26T12:00:00.000Z",
      ciPassedAt: "2026-10-26T12:03:00.000Z",
      deployStartedAt: "2026-10-26T12:03:00.000Z",
      finishedAt: "2026-10-26T12:05:00.000Z",
    });
  });

  it("stamps both dates at creation when the CI result was already there", () => {
    const passed = createTestContext();
    recordCiResult(passed.store, ciReq, passed.ciToken, passed.clock.now());
    const a = requestDeploy(passed.store, deployReq, passed.clock.now());
    expect(a.ciPassedAt).toBe(a.createdAt);
    expect(a.finishedAt).toBeNull();

    const failed = createTestContext();
    recordCiResult(failed.store, { ...ciReq, status: "failure" }, failed.ciToken, failed.clock.now());
    const b = requestDeploy(failed.store, deployReq, failed.clock.now());
    expect(b).toMatchObject({ status: "ci_failed", ciPassedAt: null, finishedAt: b.createdAt });
  });

  it("marks expiry as the finish", async () => {
    const { store, worker, clock } = createTestContext();
    const { id } = requestDeploy(store, deployReq, clock.now());
    clock.advanceMinutes(61);
    await worker.tick();
    expect(store.getDeploy(id)).toMatchObject({ status: "expired", finishedAt: "2026-10-26T13:01:00.000Z" });
  });
});

describe("GET /api/repos/:owner/:name/deploys", () => {
  it("lists newest first, filters by service and honours the limit", async () => {
    const { ctx, store, clock, scope } = createTestContext();
    const { addService } = await import("./scopes");
    addService(
      store,
      scope,
      { alias: "worker", dokployUrl: "https://dokploy.example.com/dashboard/project/p/services/application/w1" },
      clock.now(),
    );
    requestDeploy(store, deployReq, clock.now());
    clock.advanceMinutes(1);
    requestDeploy(store, { ...deployReq, tag: "v1.1.0", sha: "b".repeat(40) }, clock.now());
    clock.advanceMinutes(1);
    requestDeploy(store, { ...deployReq, service: "worker" }, clock.now());

    const all = (await (await handlers.listRepoDeploys(ctx, "Konectus-IO", "app", params())).json()) as {
      deploys: Deploy[];
    };
    expect(all.deploys.map((d) => `${d.tag} ${d.service}`)).toEqual([
      "v1.0.0 worker",
      "v1.1.0 api-prod",
      "v1.0.0 api-prod",
    ]);
    expect(all.deploys[0]).not.toHaveProperty("serviceId");

    const filtered = (await (
      await handlers.listRepoDeploys(ctx, "konectus-io", "app", params("service=api-prod&limit=1"))
    ).json()) as { deploys: Deploy[] };
    expect(filtered.deploys.map((d) => d.tag)).toEqual(["v1.1.0"]);
  });

  it("rejects unknown repos and services and bad limits", async () => {
    const { ctx } = createTestContext();
    expect((await handlers.listRepoDeploys(ctx, "other", "repo", params())).status).toBe(404);
    const unknown = await handlers.listRepoDeploys(ctx, "konectus-io", "app", params("service=nope"));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toMatch(/Disponibles: api-prod/);
    expect((await handlers.listRepoDeploys(ctx, "konectus-io", "app", params("limit=0"))).status).toBe(400);
    expect((await handlers.listRepoDeploys(ctx, "konectus-io", "app", params("limit=abc"))).status).toBe(400);
  });
});

describe("GET /api/repos/:owner/:name/deploys/:id", () => {
  it("finds a deploy by a unique id prefix and adds the service details", async () => {
    const { ctx, store, clock } = createTestContext();
    const { id } = requestDeploy(store, deployReq, clock.now());

    const response = await handlers.getRepoDeploy(ctx, "konectus-io", "app", id.slice(0, 8).toUpperCase());
    const detail = (await response.json()) as DeployDetail;
    expect(detail).toMatchObject({ id, serviceKind: "application", tagVariable: null });
  });

  it("asks for more characters when the prefix is short or ambiguous", async () => {
    const { ctx, store, clock } = createTestContext();
    const a = requestDeploy(store, deployReq, clock.now());
    const b = requestDeploy(store, { ...deployReq, sha: "b".repeat(40), tag: "v2" }, clock.now());

    expect((await handlers.getRepoDeploy(ctx, "konectus-io", "app", "abc")).status).toBe(400);
    // Force a shared prefix: ids are random UUIDs, so rewrite them to collide.
    const db = (store as unknown as { db: { prepare(sql: string): { run(...a: string[]): void } } }).db;
    db.prepare("UPDATE deploys SET id = ? WHERE id = ?").run(`abcd1111-${a.id.slice(9)}`, a.id);
    db.prepare("UPDATE deploys SET id = ? WHERE id = ?").run(`abcd2222-${b.id.slice(9)}`, b.id);
    const ambiguous = await handlers.getRepoDeploy(ctx, "konectus-io", "app", "abcd");
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).error).toMatch(/abcd1111.*abcd2222|abcd2222.*abcd1111/);
    expect((await handlers.getRepoDeploy(ctx, "konectus-io", "app", "abcd1")).status).toBe(200);
  });

  it("does not leak deploys of other repos", async () => {
    const { ctx, store, clock } = createTestContext();
    const { createScope } = await import("./scopes");
    createScope(store, { name: "other", repoUrl: "konectus-io/other" }, clock.now());
    const { id } = requestDeploy(store, deployReq, clock.now());
    expect((await handlers.getRepoDeploy(ctx, "konectus-io", "other", id)).status).toBe(404);
  });
});
