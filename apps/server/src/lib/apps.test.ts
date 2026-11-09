import { describe, expect, it } from "vitest";
import { addScope, createApp, rotateCiToken } from "./apps";
import { createTestContext } from "./testing";
import { verifyToken } from "./tokens";

const appUrl = (id: string) => `https://dokploy.example.com/dashboard/project/p/services/application/${id}`;

describe("apps", () => {
  it("stores only the token hash and rejects a second app for the same repo", async () => {
    const { store, clock, app, ciToken } = await createTestContext();
    expect(verifyToken(ciToken, (await store.getCiTokenHash(app.id)) as string)).toBe(true);
    await expect(
      createApp(store, { name: "", repoUrl: "git@github.com:Konectus-IO/app.git" }, clock.now()),
    ).rejects.toThrow(/ya está vinculado/);
  });

  it("invalidates the old token on rotation", async () => {
    const { store, app, ciToken } = await createTestContext();
    const next = await rotateCiToken(store, app.id);
    const hash = (await store.getCiTokenHash(app.id)) as string;
    expect(verifyToken(next, hash)).toBe(true);
    expect(verifyToken(ciToken, hash)).toBe(false);
  });

  it("validates scope alias, URL, kind and uniqueness", async () => {
    const { store, clock, app } = await createTestContext();
    const add = (alias: string, dokployUrl: string) => addScope(store, app, { alias, dokployUrl }, clock.now());

    expect((await add("Worker", appUrl("w1"))).alias).toBe("worker");
    await expect(add("api prod", appUrl("x"))).rejects.toThrow(/alias/);
    await expect(add("web", "https://dokploy.example.com/dashboard/projects")).rejects.toThrow(/URL de servicio/);
    await expect(add("api-prod", appUrl("other"))).rejects.toThrow(/Ya existe/);
  });

  it("links a Compose with DOCKER_TAG by default or a custom tag variable", async () => {
    const { store, clock, app } = await createTestContext();
    const composeUrl = (id: string) => `https://dokploy.example.com/dashboard/project/p/services/compose/${id}`;
    const add = (alias: string, dokployUrl: string, tagVariable?: string) =>
      addScope(store, app, { alias, dokployUrl, ...(tagVariable !== undefined && { tagVariable }) }, clock.now());

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
    expect((await store.getScope((await add("again", composeUrl("c5"))).id))?.tagVariable).toBe("DOCKER_TAG");
  });
});
