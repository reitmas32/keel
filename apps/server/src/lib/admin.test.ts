import type { Role } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { memberPrincipal, type Principal } from "./access";
import {
  createScopeAs,
  createTokenAs,
  deleteScopeAs,
  linkServiceAs,
  lockServiceAs,
  revokeTokenAs,
  rotateCiTokenAs,
  unlinkServiceAs,
  unlockServiceAs,
} from "./admin";
import { ApiError } from "./errors";
import { addMember, createTestContext } from "./testing";

const statusOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  return 200;
};

const DOKPLOY_URL = "https://dokploy.example.com/dashboard/project/p/services/application/s1";

async function setup() {
  const t = await createTestContext();
  const as = async (role: Role, grants: [string, string, Role][] = []): Promise<Principal> =>
    memberPrincipal(t.store, await addMember(t.store, t.clock.now(), { name: role, role, grants }));
  return { ...t, as };
}

describe("admin actions", () => {
  it("need maintainer to link, unlink, lock and rotate, and admin to create or delete scopes", async () => {
    const { store, clock, scope, service, as } = await setup();
    const now = clock.now();
    const deployer = await as("deployer");
    const maintainer = await as("maintainer");

    expect(await statusOf(() => createScopeAs(store, maintainer, { name: "x", repoUrl: "jalo/x" }, now))).toBe(403);
    expect(await statusOf(() => deleteScopeAs(store, maintainer, scope.id, now))).toBe(403);
    expect(await statusOf(() => rotateCiTokenAs(store, deployer, scope.id, now))).toBe(403);
    const link = (p: Principal) =>
      linkServiceAs(store, p, scope.id, { alias: "api-stg", dokployUrl: DOKPLOY_URL }, now);
    expect(await statusOf(() => link(deployer))).toBe(403);
    await expect(link(deployer)).rejects.toThrow(
      "Tu rol (deployer) no permite vincular servicios en konectus-io/app. Pide a un admin de keel que te dé acceso.",
    );
    expect(await statusOf(() => lockServiceAs(store, deployer, scope.id, service.id, "x", now))).toBe(403);
    expect(await statusOf(() => unlockServiceAs(store, deployer, scope.id, service.id, now))).toBe(403);
    expect(await statusOf(() => unlinkServiceAs(store, deployer, scope.id, service.id, now))).toBe(403);

    const linked = await link(maintainer);
    expect(await rotateCiTokenAs(store, maintainer, scope.id, now)).toMatch(/^keel_/);
    await lockServiceAs(store, maintainer, scope.id, service.id, "release", now);
    expect((await store.getServiceLock(service.id))?.lockedBy).toBe("maintainer");
    await unlockServiceAs(store, maintainer, scope.id, service.id, now);
    await unlinkServiceAs(store, maintainer, scope.id, linked.id, now);

    const admin = await as("admin");
    const { scope: created } = await createScopeAs(store, admin, { name: "x", repoUrl: "jalo/x" }, now);
    await deleteScopeAs(store, admin, created.id, now);

    const entries = (await store.listAudit()).reverse();
    expect(entries.map((e) => [e.actor, e.action, e.repo, e.service])).toEqual([
      ["maintainer", "service.link", "konectus-io/app", "api-stg"],
      ["maintainer", "ci_token.rotate", "konectus-io/app", null],
      ["maintainer", "lock.set", "konectus-io/app", "api-prod"],
      ["maintainer", "lock.clear", "konectus-io/app", "api-prod"],
      ["maintainer", "service.unlink", "konectus-io/app", "api-stg"],
      ["admin", "scope.create", "jalo/x", null],
      ["admin", "scope.delete", "jalo/x", null],
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/keel_[\w-]{20}/);
  });

  it("checks lock and unlink against the service's own grants", async () => {
    const { store, clock, scope, service, as } = await setup();
    const prodOnly = await as("deployer", [["konectus-io/app", "*-prod", "maintainer"]]);
    await lockServiceAs(store, prodOnly, scope.id, service.id, "release", clock.now());
    const stg = await linkServiceAs(
      store,
      await as("admin"),
      scope.id,
      { alias: "api-stg", dokployUrl: DOKPLOY_URL },
      clock.now(),
    );
    expect(await statusOf(() => lockServiceAs(store, prodOnly, scope.id, stg.id, "x", clock.now()))).toBe(403);
    // Linking is checked on the whole repo, where the grant doesn't apply.
    expect(
      await statusOf(() =>
        linkServiceAs(store, prodOnly, scope.id, { alias: "web-prod", dokployUrl: DOKPLOY_URL }, clock.now()),
      ),
    ).toBe(403);
  });
});

describe("tokens in the admin", () => {
  it("lets members revoke their own tokens and admins anyone's", async () => {
    const { store, clock, as } = await setup();
    const ana = await as("deployer");
    const beto = await as("viewer");
    const admin = await as("admin");
    const mine = await createTokenAs(store, ana, { name: "ana-laptop", maxRole: "publisher" }, clock.now());
    expect(mine.record).toMatchObject({ memberId: ana.member?.id, maxRole: "publisher" });
    expect(await statusOf(() => createTokenAs(store, beto, { name: "beto", maxRole: "deployer" }, clock.now()))).toBe(
      400,
    );

    expect(await statusOf(() => revokeTokenAs(store, beto, mine.record.id, clock.now()))).toBe(403);
    const other = await createTokenAs(store, ana, { name: "ana-ci", maxRole: null }, clock.now());
    await revokeTokenAs(store, ana, other.record.id, clock.now());
    await revokeTokenAs(store, admin, mine.record.id, clock.now());
    expect(await store.listApiTokens()).toEqual([]);

    const actions = (await store.listAudit()).reverse().map((e) => `${e.actor}:${e.action}`);
    expect(actions).toEqual([
      "deployer:token.create",
      "deployer:token.create",
      "deployer:token.revoke",
      "admin:token.revoke",
    ]);
    expect(JSON.stringify(await store.listAudit())).not.toContain(mine.token);
  });
});
