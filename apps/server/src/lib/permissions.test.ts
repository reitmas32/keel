import type { Role } from "@keel/shared";
import { describe, expect, it } from "vitest";
import type { AppContext } from "./context";
import { requestDeploy } from "./deploys";
import { handlers } from "./handlers";
import { apiRequest, createTestContext, memberToken, SHA } from "./testing";

const deployBody = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, scope: "api-prod" };
const versionBody = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA };

/** Every role-checked handler, with the role it needs and the action its 403 names. */
function calls(ctx: AppContext, headers: Record<string, string>, deployId: string) {
  const req = (method = "GET", body?: unknown) =>
    apiRequest("", { method, headers, ...(body !== undefined && { body }) });
  return [
    {
      role: "viewer",
      what: "ver scopes en konectus-io/app",
      run: () => handlers.listScopes(ctx, req(), "konectus-io", "app"),
    },
    {
      role: "viewer",
      what: "ver versiones en konectus-io/app",
      run: () => handlers.listRepoVersions(ctx, req(), "konectus-io", "app"),
    },
    {
      role: "viewer",
      what: "ver deploys en konectus-io/app",
      run: () => handlers.listRepoDeploys(ctx, req(), "konectus-io", "app"),
    },
    {
      role: "viewer",
      what: "ver deploys en konectus-io/app",
      run: () => handlers.getRepoDeploy(ctx, req(), "konectus-io", "app", deployId.slice(0, 8)),
    },
    {
      role: "viewer",
      what: "ver deploys en konectus-io/app/api-prod",
      run: () => handlers.getDeploy(ctx, req(), deployId),
    },
    {
      role: "publisher",
      what: "registrar versiones en konectus-io/app",
      run: () => handlers.registerVersion(ctx, req("POST", versionBody)),
    },
    {
      role: "deployer",
      what: "desplegar en konectus-io/app/api-prod",
      run: () => handlers.createDeploy(ctx, req("POST", deployBody)),
    },
    {
      role: "maintainer",
      what: "bloquear scopes en konectus-io/app/api-prod",
      run: () => handlers.lockScope(ctx, req("PUT", { reason: "x" }), "konectus-io", "app", "api-prod"),
    },
    {
      role: "maintainer",
      what: "desbloquear scopes en konectus-io/app/api-prod",
      run: () => handlers.unlockScope(ctx, req("DELETE"), "konectus-io", "app", "api-prod"),
    },
  ] as const;
}

const rank: Role[] = ["viewer", "publisher", "deployer", "maintainer", "admin"];

async function withDeploy() {
  const t = await createTestContext();
  const deploy = await requestDeploy(t.store, { ...deployBody, sha: "f".repeat(40) }, t.clock.now());
  return { ...t, deployId: deploy.id };
}

describe("role checks on the API", () => {
  it.each(rank)("a %s token gets 403 exactly on the handlers above its role", async (role) => {
    const { ctx, store, clock, deployId } = await withDeploy();
    const { headers } = await memberToken(store, clock.now(), { role });
    for (const call of calls(ctx, headers, deployId)) {
      const response = await call.run();
      const allowed = rank.indexOf(role) >= rank.indexOf(call.role);
      if (allowed) {
        expect(response.status, call.what).not.toBe(403);
        expect(response.status, call.what).toBeLessThan(400);
      } else {
        expect(response.status, call.what).toBe(403);
        expect((await response.json()).error).toBe(
          `Tu rol (${role}) no permite ${call.what}. Pide a un admin de keel que te dé acceso.`,
        );
      }
    }
  });

  it("applies grants per scope and caps tokens at their max role", async () => {
    const { ctx, store, clock, scope, app } = await withDeploy();
    const { addScope } = await import("./apps");
    await addScope(
      store,
      app,
      { alias: "api-stg", dokployUrl: "https://dokploy.example.com/dashboard/project/p/services/application/s1" },
      clock.now(),
    );
    // Deployer everywhere except prod scopes, where they only read.
    const { headers } = await memberToken(store, clock.now(), {
      role: "deployer",
      grants: [["konectus-io/*", "*-prod", "viewer"]],
    });
    const deploy = (alias: string, h = headers) =>
      handlers.createDeploy(ctx, apiRequest("", { method: "POST", headers: h, body: { ...deployBody, scope: alias } }));
    expect((await deploy(scope.alias)).status).toBe(403);
    expect((await deploy("api-stg")).status).toBe(202);

    // A maintainer whose token is capped at publisher can register versions but not deploy.
    const capped = await memberToken(store, clock.now(), { role: "maintainer", maxRole: "publisher" });
    expect((await deploy("api-stg", capped.headers)).status).toBe(403);
    const version = await handlers.registerVersion(
      ctx,
      apiRequest("", { method: "POST", headers: capped.headers, body: versionBody }),
    );
    expect(version.status).toBe(201);

    // An admin is never lowered by a grant.
    const admin = await memberToken(store, clock.now(), { role: "admin", grants: [["*", "*", "viewer"]] });
    expect((await deploy(scope.alias, admin.headers)).status).toBe(202);
  });

  it("checks the role before revealing whether the repo exists", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers } = await memberToken(store, clock.now(), { role: "viewer" });
    const response = await handlers.createDeploy(
      ctx,
      apiRequest("", { method: "POST", headers, body: { ...deployBody, repo: "secret/repo" } }),
    );
    expect(response.status).toBe(403);
  });
});

describe("anonymous calls", () => {
  it("default to deployer, as before roles", async () => {
    const { ctx } = await createTestContext();
    const created = await handlers.createDeploy(ctx, apiRequest("", { method: "POST", body: deployBody }));
    expect(created.status).toBe(202);
    const locked = await handlers.lockScope(
      ctx,
      apiRequest("", { method: "PUT", body: { reason: "x" } }),
      "konectus-io",
      "app",
      "api-prod",
    );
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toMatch(/^Tu rol \(deployer\) no permite bloquear scopes/);
  });

  it.each([
    ["none", 0],
    ["viewer", 5],
    ["publisher", 6],
    ["deployer", 7],
  ] as const)("get KEEL_ANONYMOUS_ROLE=%s", async (anonymousRole, allowedCount) => {
    const { ctx, env, deployId } = await withDeploy();
    env.KEEL_ANONYMOUS_ROLE = anonymousRole;
    const statuses = [];
    for (const call of calls(ctx, {}, deployId)) statuses.push((await call.run()).status);
    expect(statuses.filter((s) => s !== 403)).toHaveLength(allowedCount);
    if (anonymousRole === "none") {
      const body = await (await handlers.listScopes(ctx, apiRequest(), "konectus-io", "app")).json();
      expect(body.error).toMatch(/^Tu rol \(none\) no permite ver scopes en konectus-io\/app\./);
    }
  });
});

describe("audit of API mutations", () => {
  it("records deploys, versions, locks and CI results, with who did them", async () => {
    const { ctx, store, clock, ciToken } = await createTestContext();
    const { member, headers } = await memberToken(store, clock.now(), { name: "Rafa", role: "maintainer" });
    const post = (body: unknown, h: Record<string, string> = headers) =>
      apiRequest("", { method: "POST", headers: h, body });

    await handlers.registerVersion(ctx, post(versionBody));
    await handlers.createDeploy(ctx, post(deployBody));
    await handlers.createDeploy(ctx, post({ ...deployBody, sha: "b".repeat(40) }, {}));
    const lockReq = apiRequest("", { method: "PUT", headers, body: { reason: "release" } });
    await handlers.lockScope(ctx, lockReq, "konectus-io", "app", "api-prod");
    await handlers.unlockScope(ctx, apiRequest("", { method: "DELETE", headers }), "konectus-io", "app", "api-prod");
    // Unlocking an unlocked scope changes nothing and isn't recorded.
    await handlers.unlockScope(ctx, apiRequest("", { method: "DELETE", headers }), "konectus-io", "app", "api-prod");
    await handlers.ciResult(
      ctx,
      apiRequest("", {
        method: "POST",
        headers: { authorization: `Bearer ${ciToken}` },
        body: { ...versionBody, status: "success" },
      }),
    );
    // Reads and refused calls are not mutations.
    await handlers.listScopes(ctx, apiRequest("", { headers }), "konectus-io", "app");

    const entries = (await store.listAudit()).reverse();
    expect(entries.map((e) => [e.actor, e.action, e.repo, e.scope])).toEqual([
      ["Rafa", "version.register", "konectus-io/app", null],
      ["Rafa", "deploy.create", "konectus-io/app", "api-prod"],
      ["anónimo", "deploy.create", "konectus-io/app", "api-prod"],
      ["Rafa", "lock.set", "konectus-io/app", "api-prod"],
      ["Rafa", "lock.clear", "konectus-io/app", "api-prod"],
      ["ci", "ci.result", "konectus-io/app", null],
    ]);
    expect(entries[0]?.actorMemberId).toBe(member.id);
    expect(entries[2]?.actorMemberId).toBeNull();
    expect(entries[1]?.details).toMatchObject({ tag: "v1.0.0", sha: SHA, via: "api", token: expect.any(String) });
    const all = JSON.stringify(entries);
    expect(all).not.toContain(headers.authorization.slice(7));
    expect(all).not.toContain(ciToken);
  });
});
