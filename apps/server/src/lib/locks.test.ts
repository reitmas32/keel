import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import type { ApiError } from "./errors";
import { handlers } from "./handlers";
import { apiRequest, createTestContext, memberToken, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };

const lock = (reason: unknown, headers: Record<string, string> = {}) =>
  apiRequest("", { method: "PUT", body: { reason }, headers });

describe("service locks", () => {
  it("locks with the member's name, replaces the reason, and unlocks", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers: auth } = await memberToken(store, clock.now(), { name: "rafa", role: "maintainer" });
    const { headers: ana } = await memberToken(store, clock.now(), { name: "ana", role: "maintainer" });

    const locked = await handlers.lockService(ctx, lock(" migración de DB ", auth), "konectus-io", "app", "api-prod");
    expect(locked.status).toBe(200);
    expect(await locked.json()).toEqual({
      alias: "api-prod",
      reason: "migración de DB",
      lockedBy: "rafa",
      createdAt: clock.now().toISOString(),
    });

    const createdAt = clock.now().toISOString();
    clock.advanceMinutes(5);
    const relocked = await handlers.lockService(ctx, lock("otra cosa", ana), "konectus-io", "app", "api-prod");
    expect(await relocked.json()).toEqual({ alias: "api-prod", reason: "otra cosa", lockedBy: "ana", createdAt });

    const services = await (await handlers.listServices(ctx, apiRequest(), "konectus-io", "app")).json();
    expect(services.services[0].lock).toEqual({ reason: "otra cosa", lockedBy: "ana", createdAt });

    const unlock = () =>
      handlers.unlockService(
        ctx,
        apiRequest("", { method: "DELETE", headers: auth }),
        "konectus-io",
        "app",
        "api-prod",
      );
    expect(await (await unlock()).json()).toEqual({ ok: true, wasLocked: true });
    expect(await (await unlock()).json()).toEqual({ ok: true, wasLocked: false });
    const after = await (await handlers.listServices(ctx, apiRequest(), "konectus-io", "app")).json();
    expect(after.services[0].lock).toBeNull();
  });

  it("validates the reason and 404s an unknown repo or alias", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { headers } = await memberToken(store, clock.now(), { role: "maintainer" });
    expect((await handlers.lockService(ctx, lock("", headers), "konectus-io", "app", "api-prod")).status).toBe(400);
    const tooLong = lock("x".repeat(501), headers);
    expect((await handlers.lockService(ctx, tooLong, "konectus-io", "app", "api-prod")).status).toBe(400);
    const noRepo = await handlers.lockService(ctx, lock("x", headers), "other", "repo", "api-prod");
    expect(noRepo.status).toBe(404);
    expect((await noRepo.json()).error).toBe("El repo other/repo no está vinculado a ningún scope.");
    const noAlias = await handlers.unlockService(ctx, apiRequest("", { headers }), "konectus-io", "app", "nope");
    expect(noAlias.status).toBe(404);
    expect((await noAlias.json()).error).toBe("El servicio nope no existe en konectus-io/app. Disponibles: api-prod.");
  });

  it("refuses new deploys with 423 but lets in-flight deploys finish", async () => {
    const { ctx, store, worker, dokploy, clock, service, ciToken } = await createTestContext();
    const inFlight = await requestDeploy(store, deployReq, clock.now());
    await store.lockService({ serviceId: service.id, reason: "congelado por release", lockedBy: "rafa" }, clock.now());

    const refused = await handlers.createDeploy(
      ctx,
      apiRequest("", { method: "POST", body: { ...deployReq, sha: "b".repeat(40) } }),
    );
    expect(refused.status).toBe(423);
    expect((await refused.json()).error).toBe(
      "El servicio api-prod está bloqueado: congelado por release (por rafa, 26/10/26, 12:00 UTC). Desbloquéalo con `keel unlock -s api-prod`.",
    );

    await store.lockService({ serviceId: service.id, reason: "x", lockedBy: null }, clock.now());
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

  it("is removed with its service", async () => {
    const { store, clock, service } = await createTestContext();
    await store.lockService({ serviceId: service.id, reason: "x", lockedBy: null }, clock.now());
    await store.deleteService(service.id);
    expect(await store.getServiceLock(service.id)).toBeUndefined();
  });
});
