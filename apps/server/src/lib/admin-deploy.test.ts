import { describe, expect, it } from "vitest";
import { createFreezeAs, lockScopeAs, requestDeployAs } from "./admin";
import { registerVersion } from "./deploys";
import { addMember, createTestContext, SHA } from "./testing";

const repo = "konectus-io/app";

async function setup(role: "deployer" | "maintainer" | "viewer" | "admin" = "deployer") {
  const t = await createTestContext();
  const member = await addMember(t.store, t.clock.now(), { role });
  const p = { member, grants: [], maxRole: null, anonymousRole: null };
  await registerVersion(t.store, { repo, tag: "v1.0.0", sha: SHA }, t.clock.now());
  return { ...t, p };
}

describe("deploys asked from the admin", () => {
  it("queues the version's commit to the scope, audited as from the admin", async () => {
    const { store, notifier, clock, app, scope, p } = await setup();
    const { deploy, created } = await requestDeployAs(
      store,
      notifier,
      p,
      app.id,
      { scopeId: scope.id, tag: "v1.0.0" },
      clock.now(),
    );
    expect(created).toBe(true);
    expect(deploy).toMatchObject({ tag: "v1.0.0", sha: SHA, scope: "api-prod", requestedBy: p.member.name });
    const audit = await store.listAudit();
    expect(audit.find((a) => a.action === "deploy.create")?.details).toMatchObject({ via: "admin", tag: "v1.0.0" });

    // Asking again for the same commit returns the one in flight.
    const again = await requestDeployAs(store, notifier, p, app.id, { scopeId: scope.id, tag: "v1.0.0" }, clock.now());
    expect(again).toMatchObject({ created: false, deploy: { id: deploy.id } });
  });

  it("needs deployer on the scope and a version that exists", async () => {
    const viewer = await setup("viewer");
    await expect(
      requestDeployAs(
        viewer.store,
        viewer.notifier,
        viewer.p,
        viewer.app.id,
        { scopeId: viewer.scope.id, tag: "v1.0.0" },
        viewer.clock.now(),
      ),
    ).rejects.toThrow(/desplegar/);
    const { store, notifier, clock, app, scope, p } = await setup();
    await expect(
      requestDeployAs(store, notifier, p, app.id, { scopeId: scope.id, tag: "v9.9.9" }, clock.now()),
    ).rejects.toThrow(/no existe/);
  });

  it("respects locks and freeze windows, and forces one with a reason when the role allows it", async () => {
    const { store, notifier, clock, app, scope, p } = await setup("admin");
    await createFreezeAs(
      store,
      p,
      app.id,
      { name: "todo el día", kind: "weekly", days: ["1"], startTime: "00:00", endTime: "00:00", timezone: "UTC" },
      clock.now(),
    );
    await expect(
      requestDeployAs(store, notifier, p, app.id, { scopeId: scope.id, tag: "v1.0.0" }, clock.now()),
    ).rejects.toThrow(/ventana de congelamiento/);
    const forced = await requestDeployAs(
      store,
      notifier,
      p,
      app.id,
      { scopeId: scope.id, tag: "v1.0.0", forceReason: "hotfix" },
      clock.now(),
    );
    expect(forced.deploy).toMatchObject({ forcedBy: p.member.name, forcedReason: "hotfix" });
    expect(notifier.events).toContain("deploy.forced");

    const locked = await setup("admin");
    await lockScopeAs(locked.store, locked.p, locked.app.id, locked.scope.id, "migración", locked.clock.now());
    await expect(
      requestDeployAs(
        locked.store,
        locked.notifier,
        locked.p,
        locked.app.id,
        { scopeId: locked.scope.id, tag: "v1.0.0" },
        locked.clock.now(),
      ),
    ).rejects.toThrow(/bloquead|migración/);
  });
});
