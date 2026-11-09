import { describe, expect, it } from "vitest";
import { addService, createScope, rotateCiToken } from "./scopes";
import { createTestContext } from "./testing";
import { verifyToken } from "./tokens";

const appUrl = (id: string) => `https://dokploy.example.com/dashboard/project/p/services/application/${id}`;

describe("scopes", () => {
  it("stores only the token hash and rejects a second scope for the same repo", async () => {
    const { store, clock, scope, ciToken } = await createTestContext();
    expect(verifyToken(ciToken, (await store.getCiTokenHash(scope.id)) as string)).toBe(true);
    await expect(
      createScope(store, { name: "", repoUrl: "git@github.com:Konectus-IO/app.git" }, clock.now()),
    ).rejects.toThrow(/ya está vinculado/);
  });

  it("invalidates the old token on rotation", async () => {
    const { store, scope, ciToken } = await createTestContext();
    const next = await rotateCiToken(store, scope.id);
    const hash = (await store.getCiTokenHash(scope.id)) as string;
    expect(verifyToken(next, hash)).toBe(true);
    expect(verifyToken(ciToken, hash)).toBe(false);
  });

  it("validates service alias, URL, kind and uniqueness", async () => {
    const { store, clock, scope } = await createTestContext();
    const add = (alias: string, dokployUrl: string) => addService(store, scope, { alias, dokployUrl }, clock.now());

    expect((await add("Worker", appUrl("w1"))).alias).toBe("worker");
    await expect(add("api prod", appUrl("x"))).rejects.toThrow(/alias/);
    await expect(add("web", "https://dokploy.example.com/dashboard/projects")).rejects.toThrow(/URL de servicio/);
    await expect(add("api-prod", appUrl("other"))).rejects.toThrow(/Ya existe/);
  });

  it("links a Compose with DOCKER_TAG by default or a custom tag variable", async () => {
    const { store, clock, scope } = await createTestContext();
    const composeUrl = (id: string) => `https://dokploy.example.com/dashboard/project/p/services/compose/${id}`;
    const add = (alias: string, dokployUrl: string, tagVariable?: string) =>
      addService(store, scope, { alias, dokployUrl, ...(tagVariable !== undefined && { tagVariable }) }, clock.now());

    expect(await add("staging", composeUrl("c1"))).toMatchObject({
      kind: "compose",
      dokployId: "c1",
      tagVariable: "DOCKER_TAG",
    });
    expect(await add("prod", composeUrl("c2"), " API_TAG ")).toMatchObject({ tagVariable: "API_TAG" });
    expect(await add("blank", composeUrl("c3"), "")).toMatchObject({ tagVariable: "DOCKER_TAG" });
    await expect(add("bad", composeUrl("c4"), "DOCKER-TAG")).rejects.toThrow(/Variable de tag inválida/);
    // An Application keeps its tag in the image, so a tag variable is ignored.
    expect(await add("app", appUrl("a1"), "DOCKER_TAG")).toMatchObject({ kind: "application", tagVariable: null });
    expect((await store.getService((await add("again", composeUrl("c5"))).id))?.tagVariable).toBe("DOCKER_TAG");
  });
});
