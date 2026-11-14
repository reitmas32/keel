import { describe, expect, it } from "vitest";
import { createFreezeAs, deleteFreezeAs, setFreezeEnabledAs } from "./admin";
import { recordCiResult, requestDeploy } from "./deploys";
import { activeFreeze, activeUntil, describeWindow, type FreezeWindow, parseFreezeInput, wallClock } from "./freeze";
import { handlers } from "./handlers";
import { addMember, apiRequest, createTestContext, memberToken, SHA } from "./testing";

const repo = "konectus-io/app";
const MX = "America/Mexico_City"; // UTC-6, no DST since 2022.

const window = (over: Partial<FreezeWindow>): FreezeWindow => ({
  id: "w",
  appId: null,
  name: "freeze",
  kind: "weekly",
  timezone: MX,
  startsAt: null,
  endsAt: null,
  days: [],
  startTime: null,
  endTime: null,
  scopePattern: "*",
  enabled: true,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

/** A UTC instant from a Mexico City wall clock. */
const mx = (local: string) => new Date(`${local}:00-06:00`);

describe("freeze window rules", () => {
  it("reads the wall clock of the window's time zone", () => {
    // Friday 2026-11-13 20:30 in Mexico City is Saturday 02:30 UTC.
    expect(wallClock(new Date("2026-11-14T02:30:00Z"), MX)).toEqual({ date: "2026-11-13", time: "20:30", weekday: 5 });
    expect(wallClock(new Date("2026-11-14T02:30:00Z"), "UTC")).toEqual({
      date: "2026-11-14",
      time: "02:30",
      weekday: 6,
    });
  });

  it("matches a date-time range, end excluded", () => {
    const w = window({ kind: "range", startsAt: "2026-12-20T18:00", endsAt: "2027-01-02T08:00" });
    expect(activeUntil(w, mx("2026-12-20T17:59"))).toBeUndefined();
    expect(activeUntil(w, mx("2026-12-24T12:00"))).toBe("2027-01-02 08:00");
    expect(activeUntil(w, mx("2027-01-02T08:00"))).toBeUndefined();
  });

  it("matches weekly hours, also across midnight and on whole days", () => {
    const evenings = window({ days: [5], startTime: "18:00", endTime: "08:00" }); // Friday 18:00 → Saturday 08:00
    expect(activeUntil(evenings, mx("2026-11-13T17:59"))).toBeUndefined();
    expect(activeUntil(evenings, mx("2026-11-13T22:00"))).toBe("2026-11-14 08:00");
    expect(activeUntil(evenings, mx("2026-11-14T07:59"))).toBe("2026-11-14 08:00");
    expect(activeUntil(evenings, mx("2026-11-14T08:00"))).toBeUndefined();

    const office = window({ days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "11:00" });
    expect(activeUntil(office, mx("2026-11-16T10:00"))).toBe("2026-11-16 11:00"); // Monday
    expect(activeUntil(office, mx("2026-11-15T10:00"))).toBeUndefined(); // Sunday

    const sundays = window({ days: [7], startTime: "00:00", endTime: "00:00" });
    expect(activeUntil(sundays, mx("2026-11-15T23:59"))).toBe("2026-11-16 00:00");
    expect(activeUntil(sundays, mx("2026-11-16T00:00"))).toBeUndefined();
  });

  it("matches one date, whole day or between hours", () => {
    const christmas = window({ kind: "date", startsAt: "2026-12-25" });
    expect(activeUntil(christmas, mx("2026-12-25T00:00"))).toBe("2026-12-26 00:00");
    expect(activeUntil(christmas, mx("2026-12-24T23:59"))).toBeUndefined();
    const launch = window({ kind: "date", startsAt: "2026-12-01", startTime: "10:00", endTime: "14:00" });
    expect(activeUntil(launch, mx("2026-12-01T13:00"))).toBe("2026-12-01 14:00");
    expect(activeUntil(launch, mx("2026-12-01T14:00"))).toBeUndefined();
  });

  it("gives the organization's window priority over the app's, and honors scope patterns and disabling", () => {
    const always = { kind: "weekly" as const, days: [1, 2, 3, 4, 5, 6, 7], startTime: "00:00", endTime: "00:00" };
    const app = window({ ...always, id: "a", appId: "app1", name: "de la app" });
    const org = window({ ...always, id: "o", name: "de la org" });
    const now = mx("2026-11-13T12:00");
    expect(activeFreeze([app, org], { appId: "app1", scope: "prod" }, now)).toMatchObject({ level: "org" });
    expect(activeFreeze([app], { appId: "app1", scope: "prod" }, now)).toMatchObject({ level: "app" });
    expect(activeFreeze([app], { appId: "app2", scope: "prod" }, now)).toBeUndefined();
    const prodOnly = window({ ...always, scopePattern: "prod*" });
    expect(activeFreeze([prodOnly], { appId: "x", scope: "stg" }, now)).toBeUndefined();
    expect(activeFreeze([{ ...org, enabled: false }], { appId: "x", scope: "prod" }, now)).toBeUndefined();
  });

  it("describes windows the way people say them", () => {
    expect(describeWindow(window({ days: [1, 2, 3, 4, 5], startTime: "18:00", endTime: "08:00" }))).toBe(
      "lun–vie, 18:00–08:00 (+1 día)",
    );
    expect(describeWindow(window({ days: [1, 2, 3, 4, 5, 6, 7], startTime: "00:00", endTime: "00:00" }))).toBe(
      "todos los días, todo el día",
    );
    expect(describeWindow(window({ days: [6, 7], startTime: "09:00", endTime: "14:00" }))).toBe(
      "sáb y dom, 09:00–14:00",
    );
    expect(describeWindow(window({ kind: "date", startsAt: "2026-12-25" }))).toBe("2026-12-25, todo el día");
  });

  it("validates the admin's input", () => {
    const base = { name: "fin de año", timezone: MX };
    expect(() => parseFreezeInput({ ...base, kind: "range", startsAt: "2026-12-20", endsAt: "x" })).toThrow(
      /fecha y hora/,
    );
    expect(() =>
      parseFreezeInput({ ...base, kind: "range", startsAt: "2026-12-20T10:00", endsAt: "2026-12-20T09:00" }),
    ).toThrow(/posterior/);
    expect(() => parseFreezeInput({ ...base, kind: "weekly", days: [], startTime: "18:00", endTime: "08:00" })).toThrow(
      /día/,
    );
    expect(() =>
      parseFreezeInput({ ...base, kind: "weekly", days: [5], startTime: "25:00", endTime: "08:00" }),
    ).toThrow(/HH:mm/);
    expect(() => parseFreezeInput({ ...base, kind: "date", startsAt: "2026-12-25", timezone: "Luna/Base" })).toThrow(
      /Zona horaria/,
    );
    expect(
      parseFreezeInput({ ...base, kind: "weekly", days: ["5", "1", "5"], startTime: "18:00", endTime: "08:00" }),
    ).toMatchObject({ days: [1, 5], scopePattern: "*" });
  });
});

describe("deploys during a freeze", () => {
  // createTestContext's clock is 2026-10-26T12:00Z, a Monday (06:00 in Mexico City).
  const weekdays = { kind: "weekly", days: ["1"], startTime: "00:00", endTime: "23:00", timezone: MX };

  async function setup(level: "org" | "app") {
    const t = await createTestContext();
    const admin = await addMember(t.store, t.clock.now(), { role: "admin" });
    const asAdmin = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const freeze = await createFreezeAs(
      t.store,
      asAdmin,
      level === "org" ? null : t.app.id,
      { ...weekdays, name: "lunes sin deploys" },
      t.clock.now(),
    );
    const maintainer = await memberToken(t.store, t.clock.now(), { name: "mia", role: "maintainer" });
    const adminToken = await memberToken(t.store, t.clock.now(), { name: "root", role: "admin" });
    const post = (body: Record<string, unknown>, headers: Record<string, string>) =>
      handlers.createDeploy(
        t.ctx,
        apiRequest("/deploys", {
          method: "POST",
          body: { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod", ...body },
          headers,
        }),
      );
    return { ...t, asAdmin, freeze, maintainer, adminToken, post };
  }

  it("refuses a new deploy with 423, naming the window and until when", async () => {
    const { post, maintainer } = await setup("app");
    const response = await post({}, maintainer.headers);
    expect(response.status).toBe(423);
    expect((await response.json()).error).toMatch(
      /ventana de congelamiento «lunes sin deploys» \(app\) hasta 2026-10-26 23:00 \(America\/Mexico_City\)/,
    );
  });

  it("lets a maintainer force an app's window, audited and notified", async () => {
    const { post, maintainer, store, notifier } = await setup("app");
    const response = await post({ forceReason: "hotfix de pagos" }, maintainer.headers);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ forcedBy: "mia", forcedReason: "hotfix de pagos" });
    expect((await store.listAudit()).map((a) => a.action)).toContain("deploy.force");
    expect(notifier.events).toEqual(["deploy.forced"]);
  });

  it("needs an admin to force the organization's window", async () => {
    const { post, maintainer, adminToken } = await setup("org");
    const denied = await post({ forceReason: "hotfix" }, maintainer.headers);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/necesita rol admin/);
    expect((await post({ forceReason: "hotfix" }, adminToken.headers)).status).toBe(202);
  });

  it("holds a deploy queued before the window and lets forced ones through", async () => {
    const t = await createTestContext();
    const admin = await addMember(t.store, t.clock.now(), { role: "admin" });
    const asAdmin = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    const queued = await requestDeploy(t.store, { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod" }, t.clock.now());
    const freeze = await createFreezeAs(t.store, asAdmin, null, { ...weekdays, name: "lunes" }, t.clock.now());
    await recordCiResult(t.store, { repo, tag: "v1.0.0", sha: SHA, status: "success" }, t.ciToken, t.clock.now());
    await t.worker.tick();
    expect(t.dokploy.deployed).toEqual([]);
    expect((await t.store.getDeploy(queued.id))?.status).toBe("ci_passed");

    // Disabling the window releases it.
    await setFreezeEnabledAs(t.store, asAdmin, freeze.id, false, t.clock.now());
    await t.worker.tick();
    expect(t.dokploy.deployed).toHaveLength(1);
    await deleteFreezeAs(t.store, asAdmin, freeze.id, t.clock.now());
    expect((await t.store.listAudit()).map((a) => a.action)).toEqual(
      expect.arrayContaining(["freeze.create", "freeze.disable", "freeze.delete"]),
    );
  });

  it("expires a held deploy once the window outlasts the CI expiry", async () => {
    const t = await createTestContext();
    const admin = await addMember(t.store, t.clock.now(), { role: "admin" });
    const asAdmin = { member: admin, grants: [], maxRole: null, anonymousRole: null };
    await recordCiResult(t.store, { repo, tag: "v1.0.0", sha: SHA, status: "success" }, t.ciToken, t.clock.now());
    const queued = await requestDeploy(t.store, { repo, tag: "v1.0.0", sha: SHA, scope: "api-prod" }, t.clock.now());
    await createFreezeAs(t.store, asAdmin, null, { ...weekdays, name: "lunes" }, t.clock.now());
    t.clock.advanceMinutes(61);
    await t.worker.tick();
    expect(await t.store.getDeploy(queued.id)).toMatchObject({
      status: "expired",
      error: expect.stringMatching(/«lunes» no terminó/),
    });
  });

  it("shows the active window in the scope list", async () => {
    const { ctx, maintainer } = await setup("org");
    const response = await handlers.listScopes(
      ctx,
      apiRequest("", { headers: maintainer.headers }),
      "konectus-io",
      "app",
    );
    expect((await response.json()).scopes[0].freeze).toEqual({
      name: "lunes sin deploys",
      level: "org",
      until: "2026-10-26 23:00",
      timezone: MX,
    });
  });

  it("only lets admins manage the organization's windows, and maintainers an app's", async () => {
    const t = await createTestContext();
    const maintainer = await addMember(t.store, t.clock.now(), { role: "maintainer" });
    const p = { member: maintainer, grants: [], maxRole: null, anonymousRole: null };
    await expect(createFreezeAs(t.store, p, null, { ...weekdays, name: "x" }, t.clock.now())).rejects.toThrow(
      /no permite/,
    );
    await expect(
      createFreezeAs(t.store, p, t.app.id, { ...weekdays, name: "x" }, t.clock.now()),
    ).resolves.toMatchObject({
      appId: t.app.id,
      createdBy: maintainer.name,
    });
  });
});
