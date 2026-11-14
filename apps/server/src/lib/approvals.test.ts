import { describe, expect, it } from "vitest";
import { decideDeployAs, setAppRequireApprovalAs, updateScopeAs } from "./admin";
import { recordCiResult } from "./deploys";
import { handlers } from "./handlers";
import { addMember, apiRequest, createTestContext, memberToken, SHA } from "./testing";

const repo = "konectus-io/app";
const deployBody = { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod" };
const ciReq = { repo, tag: "v1.0.0", sha: SHA, status: "success" as const };

async function setup({ app = false, scope = null as boolean | null } = {}) {
  const t = await createTestContext();
  const admin = await addMember(t.store, t.clock.now(), { role: "admin" });
  const asAdmin = { member: admin, grants: [], maxRole: null, anonymousRole: null };
  if (app) await setAppRequireApprovalAs(t.store, asAdmin, t.app.id, true, t.clock.now());
  if (scope !== null) {
    await updateScopeAs(t.store, asAdmin, t.app.id, t.scope.id, { requireApproval: scope }, t.clock.now());
  }
  const requester = await memberToken(t.store, t.clock.now(), { name: "ana", role: "maintainer" });
  const approver = await memberToken(t.store, t.clock.now(), { name: "luis", role: "maintainer" });
  const deployer = await memberToken(t.store, t.clock.now(), { name: "eva", role: "deployer" });
  const deploy = async (headers = requester.headers) => {
    const response = await handlers.createDeploy(
      t.ctx,
      apiRequest("/deploys", { method: "POST", body: deployBody, headers }),
    );
    return response.json();
  };
  const decide = (id: string, decision: "approved" | "rejected", headers: Record<string, string>, body?: unknown) =>
    handlers.decideRepoDeploy(
      t.ctx,
      apiRequest("", { method: "POST", headers, ...(body !== undefined && { body }) }),
      "konectus-io",
      "app",
      id.slice(0, 8),
      decision,
    );
  return { ...t, admin, asAdmin, requester, approver, deployer, deploy, decide };
}

describe("deploy approvals", () => {
  it("are off by default: deploys start as soon as CI passes", async () => {
    const { deploy, store, worker, dokploy, clock, ciToken, notifier } = await setup();
    const created = await deploy();
    expect(created.approval).toBeNull();
    await recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    expect(dokploy.deployed).toHaveLength(1);
    expect(notifier.events).not.toContain("deploy.approval_requested");
  });

  it("hold the deploy until a second maintainer approves it", async () => {
    const { deploy, decide, store, worker, dokploy, clock, ciToken, notifier, approver } = await setup({ app: true });
    const created = await deploy();
    expect(created.approval).toEqual({ status: "pending", by: null, at: null, reason: null });
    expect(notifier.events).toEqual(["deploy.approval_requested"]);

    await recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    expect(dokploy.deployed).toEqual([]);
    expect((await store.getDeploy(created.id))?.status).toBe("ci_passed");

    const response = await decide(created.id, "approved", approver.headers, { reason: "ok, va" });
    expect(response.status).toBe(200);
    expect((await response.json()).approval).toMatchObject({ status: "approved", by: "luis", reason: "ok, va" });
    expect(notifier.events).toEqual(["deploy.approval_requested", "deploy.approved"]);

    await worker.tick();
    expect(dokploy.deployed.map((d) => d.tag)).toEqual(["v1.0.0"]);
    expect((await store.listAudit({ scope: "api-prod" })).map((a) => a.action)).toContain("deploy.approve");
  });

  it("can be approved before the CI finishes", async () => {
    const { deploy, decide, store, worker, dokploy, clock, ciToken, approver } = await setup({ app: true });
    const created = await deploy();
    expect((await decide(created.id, "approved", approver.headers)).status).toBe(200);
    await recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    expect(dokploy.deployed).toHaveLength(1);
  });

  it("don't let the requester, a deployer or an anonymous call approve", async () => {
    const { deploy, decide, requester, deployer } = await setup({ app: true });
    const created = await deploy();
    const own = await decide(created.id, "approved", requester.headers);
    expect(own.status).toBe(403);
    expect((await own.json()).error).toMatch(/tu propio deploy/);
    expect((await decide(created.id, "approved", deployer.headers)).status).toBe(403);
    expect((await decide(created.id, "approved", {})).status).toBe(403);
  });

  it("end a rejected deploy as deploy_failed, with the reason, and only once", async () => {
    const { deploy, decide, store, worker, dokploy, clock, ciToken, approver, notifier } = await setup({ app: true });
    const created = await deploy();
    expect((await decide(created.id, "rejected", approver.headers, {})).status).toBe(400);
    const response = await decide(created.id, "rejected", approver.headers, { reason: "falta la migración" });
    expect(response.status).toBe(200);
    expect(await store.getDeploy(created.id)).toMatchObject({
      status: "deploy_failed",
      error: "Rechazado por luis: falta la migración",
      approval: { status: "rejected", by: "luis" },
    });
    expect(notifier.events).toContain("deploy.rejected");
    expect((await decide(created.id, "approved", approver.headers)).status).toBe(409);

    await recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    expect(dokploy.deployed).toEqual([]);
  });

  it("follow the scope's override over the app's setting", async () => {
    const off = await setup({ app: true, scope: false });
    expect((await off.deploy()).approval).toBeNull();
    const on = await setup({ app: false, scope: true });
    expect((await on.deploy()).approval).toMatchObject({ status: "pending" });
  });

  it("expire when nobody approves in time, without blocking later deploys of the scope", async () => {
    const { deploy, store, worker, clock, ciToken } = await setup({ app: true });
    const created = await deploy();
    await recordCiResult(store, ciReq, ciToken, clock.now());
    clock.advanceMinutes(24 * 60 + 1);
    await worker.tick();
    expect(await store.getDeploy(created.id)).toMatchObject({
      status: "expired",
      error: expect.stringMatching(/Nadie aprobó/),
    });
  });

  it("are decided from the admin too, as the member signed in", async () => {
    const { deploy, store, clock, app, approver } = await setup({ app: true });
    const created = await deploy();
    const p = { member: approver.member, grants: [], maxRole: null, anonymousRole: null };
    const decided = await decideDeployAs(store, p, app.id, created.id, "approved", "", clock.now());
    expect(decided.approval).toMatchObject({ status: "approved", by: "luis", reason: null });
  });

  it("report the effective setting in the scope list", async () => {
    const { ctx, requester } = await setup({ app: true });
    const response = await handlers.listScopes(
      ctx,
      apiRequest("", { headers: requester.headers }),
      "konectus-io",
      "app",
    );
    expect((await response.json()).scopes[0]).toMatchObject({ alias: "api-prod", requireApproval: true });
  });
});
