import { describe, expect, it } from "vitest";
import { addService, createScope, rotateCiToken } from "./scopes";
import { createTestContext } from "./testing";
import { verifyToken } from "./tokens";

const appUrl = (id: string) => `https://dokploy.example.com/dashboard/project/p/services/application/${id}`;

describe("scopes", () => {
  it("stores only the token hash and rejects a second scope for the same repo", () => {
    const { store, clock, scope, ciToken } = createTestContext();
    expect(verifyToken(ciToken, store.getCiTokenHash(scope.id) as string)).toBe(true);
    expect(() => createScope(store, { name: "", repoUrl: "git@github.com:Konectus-IO/app.git" }, clock.now())).toThrow(
      /ya está vinculado/,
    );
  });

  it("invalidates the old token on rotation", () => {
    const { store, scope, ciToken } = createTestContext();
    const next = rotateCiToken(store, scope.id);
    const hash = store.getCiTokenHash(scope.id) as string;
    expect(verifyToken(next, hash)).toBe(true);
    expect(verifyToken(ciToken, hash)).toBe(false);
  });

  it("validates service alias, URL, kind and uniqueness", () => {
    const { store, clock, scope } = createTestContext();
    const add = (alias: string, dokployUrl: string) => addService(store, scope, { alias, dokployUrl }, clock.now());

    expect(add("Worker", appUrl("w1")).alias).toBe("worker");
    expect(() => add("api prod", appUrl("x"))).toThrow(/alias/);
    expect(() => add("web", "https://dokploy.example.com/dashboard/projects")).toThrow(/URL de servicio/);
    expect(() => add("web", "https://dokploy.example.com/dashboard/project/p/services/compose/c1")).toThrow(/Compose/);
    expect(() => add("api-prod", appUrl("other"))).toThrow(/Ya existe/);
  });
});
