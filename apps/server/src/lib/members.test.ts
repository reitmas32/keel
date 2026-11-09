import { describe, expect, it } from "vitest";
import type { AuditActor } from "./access";
import { ApiError } from "./errors";
import {
  acceptInvite,
  addMemberGrant,
  changeMemberRole,
  checkInvite,
  INVITE_DAYS,
  inviteMember,
  loginBreakGlass,
  loginWithPassword,
  removeMemberGrant,
  resendInvite,
  setMemberEnabled,
} from "./members";
import { BOOTSTRAP_ADMIN } from "./postgres-schema.mjs";
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

const PASSWORD = "una contraseña larga";

async function setup() {
  const t = await createTestContext();
  const admin = await addMember(t.store, t.clock.now(), { name: "Root", role: "admin" });
  const actor: AuditActor = { name: admin.name, memberId: admin.id };
  return { ...t, admin, actor };
}

describe("invites", () => {
  it("creates an invited member and a single-use link that activates it", async () => {
    const { store, clock, actor } = await setup();
    const { member, token } = await inviteMember(
      store,
      actor,
      { name: " Ana ", email: " Ana@Example.com ", role: "deployer" },
      clock.now(),
    );
    expect(member).toMatchObject({ name: "Ana", email: "ana@example.com", status: "invited", hasPassword: false });
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(await checkInvite(store, token, clock.now())).toMatchObject({ ok: true, member: { id: member.id } });

    expect(await statusOf(() => acceptInvite(store, { token, password: "corta", confirm: "corta" }, clock.now()))).toBe(
      400,
    );
    const mismatch = () => acceptInvite(store, { token, password: PASSWORD, confirm: `${PASSWORD}!` }, clock.now());
    expect(await statusOf(mismatch)).toBe(400);

    const active = await acceptInvite(store, { token, password: PASSWORD, confirm: PASSWORD }, clock.now());
    expect(active).toMatchObject({ status: "active", hasPassword: true, lastLoginAt: clock.now().toISOString() });
    expect(await store.getMemberPasswordHash(member.id)).toMatch(/^scrypt\$/);

    // Single use.
    expect(
      await statusOf(() => acceptInvite(store, { token, password: PASSWORD, confirm: PASSWORD }, clock.now())),
    ).toBe(410);
    expect(await checkInvite(store, token, clock.now())).toMatchObject({ ok: false, reason: /ya se usó/ });
    expect(await loginWithPassword(store, "ANA@example.com", PASSWORD, clock.now())).toMatchObject({ id: member.id });
    expect(await loginWithPassword(store, "ana@example.com", "otra contraseña", clock.now())).toBeUndefined();
  });

  it("expires after 7 days", async () => {
    const { store, clock, actor } = await setup();
    const { token } = await inviteMember(
      store,
      actor,
      { name: "Ana", email: "ana@x.com", role: "viewer" },
      clock.now(),
    );
    clock.advanceMinutes(INVITE_DAYS * 24 * 60 - 1);
    expect((await checkInvite(store, token, clock.now())).ok).toBe(true);
    clock.advanceMinutes(1);
    expect(await checkInvite(store, token, clock.now())).toMatchObject({ ok: false, reason: /expiró/ });
    expect(
      await statusOf(() => acceptInvite(store, { token, password: PASSWORD, confirm: PASSWORD }, clock.now())),
    ).toBe(410);
  });

  it("re-sending replaces the old link; a disabled member's link stops working", async () => {
    const { store, clock, actor } = await setup();
    const { member, token: first } = await inviteMember(
      store,
      actor,
      { name: "Ana", email: "ana@x.com", role: "viewer" },
      clock.now(),
    );
    const second = await resendInvite(store, actor, member.id, clock.now());
    expect(await checkInvite(store, first, clock.now())).toMatchObject({ ok: false, reason: /no existe/ });
    expect((await checkInvite(store, second, clock.now())).ok).toBe(true);

    await setMemberEnabled(store, actor, member.id, false, clock.now());
    expect((await checkInvite(store, second, clock.now())).ok).toBe(false);
    expect(await statusOf(() => resendInvite(store, actor, member.id, clock.now()))).toBe(409);
    // Enabled again without a password: back to invited, with a new link.
    expect(await setMemberEnabled(store, actor, member.id, true, clock.now())).toMatchObject({ status: "invited" });
  });

  it("rejects a repeated email, a bad email and an unknown role", async () => {
    const { store, clock, actor } = await setup();
    await inviteMember(store, actor, { name: "Ana", email: "ana@x.com", role: "viewer" }, clock.now());
    const invite = (email: string, role = "viewer") =>
      statusOf(() => inviteMember(store, actor, { name: "B", email, role }, clock.now()));
    expect(await invite("ANA@x.com")).toBe(409);
    expect(await invite("no-es-email")).toBe(400);
    expect(await invite("b@x.com", "owner")).toBe(400);
  });
});

describe("the last active admin", () => {
  it("can't be demoted or disabled, by itself or anyone", async () => {
    const { store, clock, admin, actor } = await setup();
    // The bootstrap admin is an active admin too; disable it to leave Root as the last one.
    await setMemberEnabled(store, actor, BOOTSTRAP_ADMIN.id, false, clock.now());
    expect(await store.countActiveAdmins()).toBe(1);

    const demote = () => changeMemberRole(store, actor, admin.id, "maintainer", clock.now());
    expect(await statusOf(demote)).toBe(409);
    await expect(demote()).rejects.toThrow(/último admin activo/);
    expect(await statusOf(() => setMemberEnabled(store, actor, admin.id, false, clock.now()))).toBe(409);

    const other = await addMember(store, clock.now(), { role: "admin" });
    await changeMemberRole(store, actor, admin.id, "maintainer", clock.now());
    expect((await store.getMember(admin.id))?.role).toBe("maintainer");
    expect(await statusOf(() => setMemberEnabled(store, actor, other.id, false, clock.now()))).toBe(409);
  });
});

describe("login", () => {
  it("signs in as the bootstrap admin with KEEL_ADMIN_PASSWORD, unless it was disabled", async () => {
    const { store, clock, actor } = await setup();
    expect(await loginBreakGlass(store, clock.now())).toMatchObject({ id: BOOTSTRAP_ADMIN.id, role: "admin" });
    await setMemberEnabled(store, actor, BOOTSTRAP_ADMIN.id, false, clock.now());
    expect(await loginBreakGlass(store, clock.now())).toBeUndefined();
  });

  it("refuses members without a password, disabled or unknown", async () => {
    const { store, clock, actor } = await setup();
    const { member } = await inviteMember(
      store,
      actor,
      { name: "Ana", email: "ana@x.com", role: "viewer" },
      clock.now(),
    );
    expect(await loginWithPassword(store, "ana@x.com", "", clock.now())).toBeUndefined();
    expect(await loginWithPassword(store, "nadie@x.com", PASSWORD, clock.now())).toBeUndefined();
    expect(await loginWithPassword(store, BOOTSTRAP_ADMIN.email, "", clock.now())).toBeUndefined();
    const token = await resendInvite(store, actor, member.id, clock.now());
    await acceptInvite(store, { token, password: PASSWORD, confirm: PASSWORD }, clock.now());
    await setMemberEnabled(store, actor, member.id, false, clock.now());
    expect(await loginWithPassword(store, "ana@x.com", PASSWORD, clock.now())).toBeUndefined();
  });
});

describe("audit of member changes", () => {
  it("records every change without secrets", async () => {
    const { store, clock, actor } = await setup();
    const { member, token } = await inviteMember(
      store,
      actor,
      { name: "Ana", email: "ana@x.com", role: "viewer" },
      clock.now(),
    );
    const resent = await resendInvite(store, actor, member.id, clock.now());
    await acceptInvite(store, { token: resent, password: PASSWORD, confirm: PASSWORD }, clock.now());
    await changeMemberRole(store, actor, member.id, "deployer", clock.now());
    const grant = await addMemberGrant(
      store,
      actor,
      member.id,
      { repo: "konectus-io/*", scope: "prod*", role: "viewer" },
      clock.now(),
    );
    await removeMemberGrant(store, actor, grant.id, clock.now());
    await setMemberEnabled(store, actor, member.id, false, clock.now());
    await setMemberEnabled(store, actor, member.id, true, clock.now());
    await loginBreakGlass(store, clock.now());

    const entries = (await store.listAudit()).reverse();
    expect(entries.map((e) => [e.actor, e.action])).toEqual([
      ["Root", "member.invite"],
      ["Root", "member.invite"],
      ["Ana", "member.activate"],
      ["Root", "member.role"],
      ["Root", "member.grant"],
      ["Root", "member.grant"],
      ["Root", "member.disable"],
      ["Root", "member.enable"],
      ["admin", "login"],
    ]);
    expect(entries[3]?.details).toMatchObject({ from: "viewer", to: "deployer" });
    expect(entries[4]?.details).toMatchObject({ op: "add", repo: "konectus-io/*", scope: "prod*", role: "viewer" });
    const all = JSON.stringify(entries);
    for (const secret of [token, resent, PASSWORD]) expect(all).not.toContain(secret);
  });
});
