import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import type { ApiError } from "./errors";
import { handlers } from "./handlers";
import { apiRequest, createTestContext, memberToken, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, scope: "api-prod" };

const lock = (reason: unknown, headers: Record<string, string> = {}) =>
  apiRequest("", { method: "PUT", body: { reason }, headers });

describe("scope locks", () => {
  it("locks with the member's name, replaces the reason, and unlocks", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers: auth } = await memberToken(store, clock.now(), { name: "rafa", role: "maintainer" });
    const { headers: ana } = await memberToken(store, clock.now(), { name: "ana", role: "maintainer" });

    const locked = await handlers.lockScope(ctx, lock(" migración de DB ", auth), "konectus-io", "app", "api-prod");
    expect(locked.status).toBe(200);
    expect(await locked.json()).toEqual({
      alias: "api-prod",
      reason: "migración de DB",
      lockedBy: "rafa",
      createdAt: clock.now().toISOString(),
    });

    const createdAt = clock.now().toISOString();
    clock.advanceMinutes(5);
    const relocked = await handlers.lockScope(ctx, lock("otra cosa", ana), "konectus-io", "app", "api-prod");
    expect(await relocked.json()).toEqual({ alias: "api-prod", reason: "otra cosa", lockedBy: "ana", createdAt });

    const scopes = await (await handlers.listScopes(ctx, apiRequest(), "konectus-io", "app")).json();
    expect(scopes.scopes[0].lock).toEqual({ reason: "otra cosa", lockedBy: "ana", createdAt });

    const unlock = () =>
      handlers.unlockScope(ctx, apiRequest("", { method: "DELETE", headers: auth }), "konectus-io", "app", "api-prod");
    expect(await (await unlock()).json()).toEqual({ ok: true, wasLocked: true });
    expect(await (await unlock()).json()).toEqual({ ok: true, wasLocked: false });
    const after = await (await handlers.listScopes(ctx, apiRequest(), "konectus-io", "app")).json();
    expect(after.scopes[0].lock).toBeNull();
  });

  it("validates the reason and 404s an unknown repo or alias", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers } = await memberToken(store, clock.now(), { role: "maintainer" });
    expect((await handlers.lockScope(ctx, lock("", headers), "konectus-io", "app", "api-prod")).status).toBe(400);
    const tooLong = lock("x".repeat(501), headers);
    expect((await handlers.lockScope(ctx, tooLong, "konectus-io", "app", "api-prod")).status).toBe(400);
    const noRepo = await handlers.lockScope(ctx, lock("x", headers), "other", "repo", "api-prod");
    expect(noRepo.status).toBe(404);
    expect((await noRepo.json()).error).toBe("El repo other/repo no está vinculado a ninguna app de keel.");
    const noAlias = await handlers.unlockScope(ctx, apiRequest("", { headers }), "konectus-io", "app", "nope");
    expect(noAlias.status).toBe(404);
    expect((await noAlias.json()).error).toBe("El scope nope no existe en konectus-io/app. Disponibles: api-prod.");
  });

  it("refuses new deploys with 423 but lets in-flight deploys finish", async () => {
    const { ctx, store, worker, dokploy, clock, scope, ciToken } = await createTestContext();
    const inFlight = await requestDeploy(store, deployReq, clock.now());
    await store.lockScope({ scopeId: scope.id, reason: "congelado por release", lockedBy: "rafa" }, clock.now());

    const refused = await handlers.createDeploy(
      ctx,
      apiRequest("", { method: "POST", body: { ...deployReq, sha: "b".repeat(40) } }),
    );
    expect(refused.status).toBe(423);
    expect((await refused.json()).error).toBe(
      "El scope api-prod está bloqueado: congelado por release (por rafa, 26/10/26, 12:00 UTC). Desbloquéalo con `keel unlock -s api-prod`.",
    );

    await store.lockScope({ scopeId: scope.id, reason: "x", lockedBy: null }, clock.now());
    await expect(requestDeploy(store, deployReq, clock.now())).rejects.toThrow(/\(por alguien, /);
    try {
      await requestDeploy(store, deployReq, clock.now());
    } catch (error) {
      expect((error as ApiError).status).toBe(423);
    }

    await recordCiResult(store, { ...deployReq, status: "success" }, ciToken, clock.now());
    await worker.tick();
    dokploy.status = "done";
    await worker.tick();
    expect((await store.getDeploy(inFlight.id))?.status).toBe("deployed");
  });

  it("is removed with its scope", async () => {
    const { store, clock, scope } = await createTestContext();
    await store.lockScope({ scopeId: scope.id, reason: "x", lockedBy: null }, clock.now());
    await store.deleteScope(scope.id);
    expect(await store.getScopeLock(scope.id)).toBeUndefined();
  });
});
