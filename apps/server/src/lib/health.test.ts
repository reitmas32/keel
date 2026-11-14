import type { HealthCheck } from "@keel/shared";
import { healthCheckSchema } from "@keel/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateScopeAs } from "./admin";
import { recordCiResult, requestDeploy } from "./deploys";
import { handlers } from "./handlers";
import { addMember, apiRequest, createTestContext, memberToken, SHA } from "./testing";
import { DeployWorker, type ProbeResult, probeHealth, ROLLBACK_ACTOR } from "./worker";

const SHA2 = "b".repeat(40);
const repo = "konectus-io/app";
const check: HealthCheck = {
  enabled: true,
  url: "https://api.example.com/healthz",
  expectedStatus: null,
  retries: 3,
  intervalSeconds: 10,
  timeoutSeconds: 5,
};

/** A context whose worker uses a scripted probe; `v1.0.0` is already deployed and `v1.1.0` has passed CI. */
async function setup(settings: { healthCheck?: HealthCheck | null; autoRollback?: boolean }) {
  const t = await createTestContext();
  const answers: ProbeResult[] = [];
  const probed: string[] = [];
  const worker = new DeployWorker(t.store, t.dokploy, {
    ciExpiryMinutes: 60,
    deployTimeoutMinutes: 15,
    now: t.clock.now,
    log: () => {},
    notifier: t.notifier,
    probe: async (c) => {
      probed.push(c.url);
      return answers.shift() ?? { ok: false, reason: "respondió 503" };
    },
  });
  // The first version reaches `deployed` before the scope has any settings.
  await recordCiResult(t.store, { repo, tag: "v1.0.0", sha: SHA, status: "success" }, t.ciToken, t.clock.now());
  await requestDeploy(t.store, { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod" }, t.clock.now());
  await worker.tick();
  t.dokploy.status = "done";
  await worker.tick();
  t.notifier.sent.length = 0;
  t.dokploy.deployed.length = 0;

  await t.store.updateScopeSettings(t.scope.id, settings);
  await recordCiResult(t.store, { repo, tag: "v1.1.0", sha: SHA2, status: "success" }, t.ciToken, t.clock.now());
  const next = await requestDeploy(t.store, { repo, tag: "v1.1.0", sha: SHA2, scope: "api-prod" }, t.clock.now());
  const tickAfter = async (seconds: number) => {
    t.clock.advanceMinutes(seconds / 60);
    await worker.tick();
  };
  return { ...t, worker, answers, probed, next, tickAfter };
}

describe("health check after a deploy", () => {
  it("is off by default: a deploy is done when Dokploy says so", async () => {
    const { store, worker, probed, next, scope } = await setup({});
    expect((await store.getScope(scope.id))?.healthCheck).toBeNull();
    await worker.tick();
    await worker.tick();
    expect(await store.getDeploy(next.id)).toMatchObject({ status: "deployed", healthStatus: null });
    expect(probed).toEqual([]);
  });

  it("stays off when configured but disabled", async () => {
    const { store, worker, probed, next } = await setup({ healthCheck: { ...check, enabled: false } });
    await worker.tick();
    await worker.tick();
    expect((await store.getDeploy(next.id))?.status).toBe("deployed");
    expect(probed).toEqual([]);
  });

  it("keeps the deploy `deploying` until the URL answers healthy, retrying every interval", async () => {
    const { store, worker, answers, probed, next, tickAfter, notifier } = await setup({ healthCheck: check });
    answers.push({ ok: false, reason: "respondió 503" }, { ok: true });
    await worker.tick(); // starts in Dokploy
    await worker.tick(); // Dokploy done → first check, unhealthy
    expect(await store.getDeploy(next.id)).toMatchObject({ status: "deploying", healthStatus: "checking" });
    await tickAfter(5); // too soon for the next attempt
    expect(probed).toHaveLength(1);
    await tickAfter(10);
    expect(probed).toEqual([check.url, check.url]);
    expect(await store.getDeploy(next.id)).toMatchObject({ status: "deployed", healthStatus: "passed" });
    expect(notifier.events).toEqual(["deploy.deployed"]);
  });

  it("fails the deploy after the configured attempts, without rolling back unless asked", async () => {
    const { store, worker, probed, next, tickAfter, notifier, dokploy } = await setup({ healthCheck: check });
    await worker.tick();
    await worker.tick();
    await tickAfter(10);
    await tickAfter(10);
    expect(probed).toHaveLength(3);
    expect(await store.getDeploy(next.id)).toMatchObject({
      status: "deploy_failed",
      healthStatus: "failed",
      error: expect.stringMatching(/health check de api-prod falló 3 veces: respondió 503/),
    });
    await tickAfter(10);
    expect(notifier.events).toEqual(["deploy.failed"]);
    expect(dokploy.deployed.map((d) => d.tag)).toEqual(["v1.1.0"]);
  });

  it("doesn't wait on a health check that fails while Dokploy can't be reached", async () => {
    const { store, worker, next, tickAfter, dokploy } = await setup({ healthCheck: { ...check, retries: 1 } });
    await worker.tick();
    await worker.tick();
    expect((await store.getDeploy(next.id))?.status).toBe("deploy_failed");
    dokploy.status = "running";
    await tickAfter(60 * 20);
    expect((await store.getDeploy(next.id))?.status).toBe("deploy_failed");
  });
});

describe("automatic rollback", () => {
  it("redeploys the previous version when the health check fails", async () => {
    const { store, worker, next, notifier, dokploy, scope, answers } = await setup({
      healthCheck: { ...check, retries: 1 },
      autoRollback: true,
    });
    await worker.tick();
    await worker.tick(); // unhealthy → failed → rollback queued and started in the same tick
    expect((await store.getDeploy(next.id))?.status).toBe("deploy_failed");
    const [rollback] = await store.listDeploys({ scopeId: scope.id }, { limit: 1, newestFirst: true });
    expect(rollback).toMatchObject({
      tag: "v1.0.0",
      sha: SHA,
      status: "deploying",
      rollbackOf: next.id,
      requestedBy: ROLLBACK_ACTOR,
    });
    expect(notifier.events).toEqual(["deploy.failed", "deploy.rollback"]);

    answers.push({ ok: true });
    await worker.tick();
    expect(dokploy.deployed.map((d) => d.tag)).toEqual(["v1.1.0", "v1.0.0"]);
    expect((await store.getDeploy(rollback?.id as string))?.status).toBe("deployed");
    expect((await store.listAudit({ scope: "api-prod" })).map((a) => a.action)).toContain("deploy.rollback");
  });

  it("also rolls back when Dokploy reports an error or times out", async () => {
    const { store, worker, dokploy, scope, next } = await setup({ autoRollback: true });
    await worker.tick();
    dokploy.status = "error";
    await worker.tick();
    const deploys = await store.listDeploys({ scopeId: scope.id }, { newestFirst: true });
    expect(deploys[0]).toMatchObject({ tag: "v1.0.0", rollbackOf: next.id });
  });

  it("doesn't roll back a failed rollback, nor when there is no previous version", async () => {
    const { store, worker, dokploy, scope } = await setup({ autoRollback: true });
    await worker.tick();
    dokploy.status = "error";
    await worker.tick(); // v1.1.0 failed → rollback to v1.0.0 queued
    await worker.tick(); // rollback starts
    await worker.tick(); // and fails too
    const deploys = await store.listDeploys({ scopeId: scope.id }, { newestFirst: true });
    expect(deploys.map((d) => [d.tag, d.status])).toEqual([
      ["v1.0.0", "deploy_failed"],
      ["v1.1.0", "deploy_failed"],
      ["v1.0.0", "deployed"],
    ]);

    const fresh = await createTestContext();
    await fresh.store.updateScopeSettings(fresh.scope.id, { autoRollback: true });
    await recordCiResult(fresh.store, { repo, tag: "v1.0.0", sha: SHA, status: "success" }, fresh.ciToken, new Date());
    await requestDeploy(fresh.store, { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod" }, fresh.clock.now());
    await fresh.worker.tick();
    fresh.dokploy.status = "error";
    await fresh.worker.tick();
    expect(await fresh.store.listDeploys({ scopeId: fresh.scope.id })).toHaveLength(1);
  });
});

describe("scope settings", () => {
  it("are changed through the API by a maintainer and audited", async () => {
    const { ctx, store, clock, scope } = await createTestContext();
    const maintainer = await memberToken(store, clock.now(), { role: "maintainer" });
    const deployer = await memberToken(store, clock.now(), { role: "deployer" });
    const body = { healthCheck: { enabled: true, url: "https://api.example.com/up" }, autoRollback: true };

    const denied = await handlers.updateScope(
      ctx,
      apiRequest("", { method: "PATCH", body, headers: deployer.headers }),
      "konectus-io",
      "app",
      "api-prod",
    );
    expect(denied.status).toBe(403);

    const response = await handlers.updateScope(
      ctx,
      apiRequest("", { method: "PATCH", body, headers: maintainer.headers }),
      "konectus-io",
      "app",
      "api-prod",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alias: "api-prod",
      autoRollback: true,
      healthCheck: { enabled: true, url: "https://api.example.com/up", expectedStatus: null, retries: 5 },
    });
    expect((await store.getScope(scope.id))?.autoRollback).toBe(true);
    expect((await store.listAudit())[0]).toMatchObject({ action: "scope.update", scope: "api-prod" });

    // Only what is sent changes; null removes the health check.
    await handlers.updateScope(
      ctx,
      apiRequest("", { method: "PATCH", body: { healthCheck: null }, headers: maintainer.headers }),
      "konectus-io",
      "app",
      "api-prod",
    );
    expect(await store.getScope(scope.id)).toMatchObject({ healthCheck: null, autoRollback: true });
  });

  it("rejects an invalid health check", async () => {
    const { store, clock, app, scope } = await createTestContext();
    const admin = await addMember(store, clock.now(), { role: "admin" });
    const p = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const save = (healthCheck: unknown) => updateScopeAs(store, p, app.id, scope.id, { healthCheck }, clock.now());
    await expect(save({ enabled: true, url: "" })).rejects.toThrow(/URL http/);
    await expect(save({ enabled: true, url: "ftp://x" })).rejects.toThrow(/URL http/);
    await expect(save({ enabled: true, url: check.url, retries: 99 })).rejects.toThrow(/retries/);
    expect(healthCheckSchema.parse({ enabled: true, url: check.url })).toEqual({ ...check, retries: 5 });
  });
});

describe("probeHealth", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts any 2xx, or only the expected status when one is set", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await probeHealth(check)).toEqual({ ok: true });
    expect(await probeHealth({ ...check, expectedStatus: 200 })).toEqual({ ok: false, reason: "respondió 204" });
    expect(await probeHealth({ ...check, expectedStatus: 204 })).toEqual({ ok: true });
  });

  it("reports a refused connection without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await probeHealth(check)).toEqual({ ok: false, reason: "no se pudo conectar" });
  });
});
