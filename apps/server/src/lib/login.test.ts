import { describe, expect, it } from "vitest";
import type { AccountsClient, AccountsFailure, AccountsIdentity } from "./accounts";
import { claimLoginCode, passwordLogin, requestLoginCode } from "./login";
import { acceptInvite, inviteMember, setMemberEnabled } from "./members";
import { createTestContext } from "./testing";

const ADMIN_PASSWORD = "break-glass-123";

/** Accounts with one account: ana@foundathyon.com / "accounts-pass", code 123456 for challenge ch1. */
class FakeAccounts implements AccountsClient {
  down = false;
  mfa = false;
  requested: string[] = [];
  private who(email: string): AccountsIdentity {
    return { ok: true, userId: `acc-${email}`, email };
  }
  async signIn(email: string, password: string): Promise<AccountsIdentity | AccountsFailure> {
    if (this.down) return { ok: false, reason: "unavailable" };
    if (this.mfa) return { ok: false, reason: "mfa" };
    return password === "accounts-pass" ? this.who(email) : { ok: false, reason: "invalid_credentials" };
  }
  async requestEmailCode(email: string) {
    this.requested.push(email);
    return { ok: true as const, challengeId: "ch1", expiresIn: 600 };
  }
  async claimEmailCode(challengeId: string, code: string): Promise<AccountsIdentity | AccountsFailure> {
    if (challengeId !== "ch1" || code !== "123456") return { ok: false, reason: "invalid_code", remainingAttempts: 2 };
    return this.who(this.requested.at(-1) as string);
  }
}

async function setup() {
  const t = await createTestContext();
  const admin = { name: "root", memberId: null };
  const accounts = new FakeAccounts();
  const deps = (withAccounts = true) => ({
    store: t.store,
    accounts: withAccounts ? accounts : null,
    adminPassword: ADMIN_PASSWORD,
    now: t.clock.now(),
  });
  // ana: invited (no local password yet); luis: active with a local keel password.
  const ana = await inviteMember(
    t.store,
    admin,
    { name: "Ana", email: "ana@foundathyon.com", role: "deployer" },
    t.clock.now(),
  );
  const luis = await inviteMember(
    t.store,
    admin,
    { name: "Luis", email: "luis@foundathyon.com", role: "viewer" },
    t.clock.now(),
  );
  await acceptInvite(
    t.store,
    { token: luis.token, password: "local-pass-123", confirm: "local-pass-123" },
    t.clock.now(),
  );
  return { ...t, accounts, deps, ana, luis };
}

describe("login with Accounts", () => {
  it("signs a member in with their Accounts password and activates an invited one", async () => {
    const { deps, store, ana } = await setup();
    const result = await passwordLogin(deps(), "ANA@foundathyon.com", "accounts-pass");
    expect(result).toMatchObject({ ok: true, member: { email: "ana@foundathyon.com", status: "active" } });
    expect((await store.listAudit()).map((a) => [a.action, a.details?.method])).toEqual(
      expect.arrayContaining([
        ["login", "accounts_password"],
        ["member.activate", "accounts_password"],
      ]),
    );
    // Her invite link no longer works.
    expect(await store.getInvite((await import("./tokens")).hashToken(ana.token))).toBeUndefined();
  });

  it("refuses an Accounts user who isn't a keel member, or is disabled", async () => {
    const { deps, store, ana } = await setup();
    expect(await passwordLogin(deps(), "otro@foundathyon.com", "accounts-pass")).toEqual({
      ok: false,
      error: expect.stringMatching(/no eres miembro de keel/),
    });
    await setMemberEnabled(store, { name: "root", memberId: null }, ana.member.id, false, new Date());
    expect((await passwordLogin(deps(), "ana@foundathyon.com", "accounts-pass")).ok).toBe(false);
  });

  it("falls back to keel's own password when Accounts rejects it or is down", async () => {
    const { deps, accounts } = await setup();
    expect(await passwordLogin(deps(), "luis@foundathyon.com", "local-pass-123")).toMatchObject({ ok: true });
    accounts.down = true;
    expect(await passwordLogin(deps(), "luis@foundathyon.com", "local-pass-123")).toMatchObject({ ok: true });
    // With Accounts down, a failed local password says so instead of blaming the password.
    expect(await passwordLogin(deps(), "luis@foundathyon.com", "wrong")).toEqual({
      ok: false,
      error: expect.stringMatching(/Accounts no responde/),
    });
    accounts.down = false;
    expect(await passwordLogin(deps(), "luis@foundathyon.com", "wrong")).toEqual({
      ok: false,
      error: "Email o contraseña incorrectos.",
    });
  });

  it("explains MFA, and keeps the break-glass access", async () => {
    const { deps, accounts } = await setup();
    accounts.mfa = true;
    expect(await passwordLogin(deps(), "ana@foundathyon.com", "accounts-pass")).toEqual({
      ok: false,
      error: expect.stringMatching(/segundo factor/),
    });
    expect(await passwordLogin(deps(), "", ADMIN_PASSWORD)).toMatchObject({ ok: true, member: { role: "admin" } });
    expect(await passwordLogin(deps(), "", "nope")).toEqual({ ok: false, error: "Contraseña incorrecta." });
  });

  it("works as before without Accounts", async () => {
    const { deps } = await setup();
    expect(await passwordLogin(deps(false), "luis@foundathyon.com", "local-pass-123")).toMatchObject({ ok: true });
    expect((await passwordLogin(deps(false), "ana@foundathyon.com", "accounts-pass")).ok).toBe(false);
    expect(await requestLoginCode(deps(false), "ana@foundathyon.com")).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });
});

describe("login with an email code", () => {
  it("sends a code only to members and signs them in with it", async () => {
    const { deps, accounts } = await setup();
    const asked = await requestLoginCode(deps(), "ana@foundathyon.com");
    expect(asked).toEqual({ ok: true, challengeId: "ch1" });
    expect(await claimLoginCode(deps(), "ch1", "000 000")).toEqual({
      ok: false,
      error: expect.stringMatching(/2 intentos/),
    });
    expect(await claimLoginCode(deps(), "ch1", "123 456")).toMatchObject({
      ok: true,
      member: { email: "ana@foundathyon.com" },
    });

    // A stranger gets the same answer, but Accounts is never called and no code works.
    const stranger = await requestLoginCode(deps(), "otro@example.com");
    expect(stranger).toMatchObject({ ok: true, challengeId: expect.stringMatching(/^none_/) });
    expect(accounts.requested).toEqual(["ana@foundathyon.com"]);
    if (stranger.ok) expect((await claimLoginCode(deps(), stranger.challengeId, "123456")).ok).toBe(false);
  });
});
