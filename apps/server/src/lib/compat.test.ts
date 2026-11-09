import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { apiRequest, createTestContext, memberToken, SHA } from "./testing";

// keel v0.7.0 renamed the deploy targets from services to scopes. Clients before it (the v0.6.0 CLI) still send and
// read the old names, so the API accepts and returns both.

const post = (body: unknown) => apiRequest("", { method: "POST", body });
const deployBody = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA };

describe("API names before v0.7.0", () => {
  it("POST /deploys takes the target as scope or as service, and both must match", async () => {
    const { ctx } = await createTestContext();

    const byScope = await handlers.createDeploy(ctx, post({ ...deployBody, scope: "api-prod" }));
    expect(byScope.status).toBe(202);
    expect(await byScope.json()).toMatchObject({ scope: "api-prod", service: "api-prod" });

    // The same commit and target: the in-flight deploy comes back, whatever name the target had.
    const byService = await handlers.createDeploy(ctx, post({ ...deployBody, service: "api-prod" }));
    expect(byService.status).toBe(202);
    const both = await handlers.createDeploy(ctx, post({ ...deployBody, scope: "api-prod", service: "api-prod" }));
    expect(both.status).toBe(202);
    const ids = new Set([(await byService.json()).id, (await both.json()).id]);
    expect(ids.size).toBe(1);

    const mismatch = await handlers.createDeploy(ctx, post({ ...deployBody, scope: "api-prod", service: "stg" }));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toMatch(/^Petición inválida: service: no coincide con scope \(api-prod\)/);

    const missing = await handlers.createDeploy(ctx, post(deployBody));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/scope: falta el scope/);

    const unknown = await handlers.createDeploy(ctx, post({ ...deployBody, service: "nope" }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("El scope nope no existe en konectus-io/app. Disponibles: api-prod.");
  });

  it("returns the deploy with scope and service, and its detail with scopeKind and serviceKind", async () => {
    const { ctx } = await createTestContext();
    const created = await (await handlers.createDeploy(ctx, post({ ...deployBody, service: "api-prod" }))).json();
    expect(created).not.toHaveProperty("scopeId");

    const fetched = await (await handlers.getDeploy(ctx, apiRequest(), created.id)).json();
    expect(fetched).toEqual(created);
    expect(fetched).toMatchObject({ scope: "api-prod", service: "api-prod" });

    const detail = await (
      await handlers.getRepoDeploy(ctx, apiRequest(), "konectus-io", "app", created.id.slice(0, 8))
    ).json();
    expect(detail).toMatchObject({
      scope: "api-prod",
      service: "api-prod",
      scopeKind: "application",
      serviceKind: "application",
      tagVariable: null,
    });
  });

  it("lists the scopes under scopes and services, and filters deploys by scope= or service=", async () => {
    const { ctx } = await createTestContext();
    await handlers.createDeploy(ctx, post({ ...deployBody, scope: "api-prod" }));

    const body = await (await handlers.listScopes(ctx, apiRequest(), "konectus-io", "app")).json();
    expect(Object.keys(body)).toEqual(["repo", "scopes", "services"]);
    expect(body.services).toEqual(body.scopes);
    expect(Object.keys(body.scopes[0])).toEqual([
      "alias",
      "kind",
      "tagVariable",
      "dokployId",
      "dokployUrl",
      "dokployName",
      "current",
      "last",
      "lock",
    ]);
    expect(body.scopes[0].last).toMatchObject({ scope: "api-prod", service: "api-prod" });

    const list = async (query: string) => handlers.listRepoDeploys(ctx, apiRequest(`?${query}`), "konectus-io", "app");
    for (const query of ["scope=api-prod", "service=api-prod", "scope=api-prod&service=api-prod"]) {
      const deploys = (await (await list(query)).json()).deploys;
      expect(deploys.map((d: { scope: string }) => d.scope)).toEqual(["api-prod"]);
    }
    expect((await list("service=nope")).status).toBe(404);
    expect((await list("scope=api-prod&service=stg")).status).toBe(400);
  });

  it("records the scope of a lock in the audit log", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers } = await memberToken(store, clock.now(), { name: "rafa", role: "maintainer" });
    const request = apiRequest("", { method: "PUT", body: { reason: "release" }, headers });
    expect((await handlers.lockScope(ctx, request, "konectus-io", "app", "api-prod")).status).toBe(200);

    const [entry] = await store.listAudit({ scope: "api-prod" });
    expect(entry).toMatchObject({ action: "lock.set", repo: "konectus-io/app", scope: "api-prod" });
    expect(await store.listAudit({ scope: "stg" })).toEqual([]);
    expect((await store.auditFacets()).scopes).toEqual(["api-prod"]);
  });
});
