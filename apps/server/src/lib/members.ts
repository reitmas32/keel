import { randomBytes } from "node:crypto";
import { isRole, type Role } from "@keel/shared";
import type { AuditActor } from "./access";
import { ApiError } from "./errors";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from "./passwords";
import { BOOTSTRAP_ADMIN } from "./postgres-schema.mjs";
import { normalizeGrantPatterns } from "./roles";
import { type Member, type MemberGrant, normalizeEmail, type Store } from "./store";
import { hashToken } from "./tokens";

export const INVITE_DAYS = 7;
export const MEMBER_NAME_MAX = 100;

const EMAIL = /^[^\s@]+@[^\s@]+$/;

const audit = (
  store: Store,
  actor: AuditActor,
  action: string,
  details: Record<string, unknown>,
  now: Date,
  target: { repo?: string | null; scope?: string | null } = {},
) => store.recordAudit({ actor: actor.name, actorMemberId: actor.memberId, action, details, ...target }, now);

function parseRole(value: string): Role {
  if (!isRole(value)) throw new ApiError(400, `Rol inválido: ${value}.`);
  return value;
}

async function getMemberOr404(store: Store, id: string): Promise<Member> {
  const member = await store.getMember(id);
  if (!member) throw new ApiError(404, "Miembro no encontrado.");
  return member;
}

/** Creates an invite link token for `member` (dropping older unused ones). Returns the plaintext token, once. */
async function issueInvite(store: Store, member: Member, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await store.deletePendingInvites(member.id);
  await store.createInvite({
    tokenHash: hashToken(token),
    memberId: member.id,
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
  });
  return token;
}

/** Invites someone: creates the member as `invited` and returns the token for `/invite/<token>`, shown once. */
export async function inviteMember(
  store: Store,
  actor: AuditActor,
  input: { name: string; email: string; role: string },
  now: Date,
): Promise<{ member: Member; token: string }> {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  if (!name || name.length > MEMBER_NAME_MAX) {
    throw new ApiError(400, `Escribe el nombre (hasta ${MEMBER_NAME_MAX} caracteres).`);
  }
  if (!EMAIL.test(email)) throw new ApiError(400, `Email inválido: ${input.email}.`);
  const role = parseRole(input.role);
  if (await store.getMemberByEmail(email)) throw new ApiError(409, `Ya existe un miembro con el email ${email}.`);

  return store.transaction(async (tx) => {
    const member = await tx.createMember({ name, email, role, status: "invited" }, now);
    const token = await issueInvite(tx, member, now);
    await audit(tx, actor, "member.invite", { memberId: member.id, name, email, role }, now);
    return { member, token };
  });
}

/** A new invite link for an invited member, or a password reset link for an active one. Older links stop working. */
export async function resendInvite(store: Store, actor: AuditActor, memberId: string, now: Date): Promise<string> {
  const member = await getMemberOr404(store, memberId);
  if (member.status === "disabled") throw new ApiError(409, `${member.name} está deshabilitado. Habilítalo primero.`);
  if (member.id === BOOTSTRAP_ADMIN.id) {
    throw new ApiError(409, "El admin de arranque entra con KEEL_ADMIN_PASSWORD; no usa invitaciones.");
  }
  return store.transaction(async (tx) => {
    const token = await issueInvite(tx, member, now);
    await audit(tx, actor, "member.invite", { memberId, email: member.email, resend: true }, now);
    return token;
  });
}

export type InviteCheck = { ok: true; member: Member } | { ok: false; reason: string };

/** Whether `/invite/<token>` can still be used, and by whom. */
export async function checkInvite(store: Store, token: string, now: Date): Promise<InviteCheck> {
  const invite = token ? await store.getInvite(hashToken(token)) : undefined;
  if (!invite) return { ok: false, reason: "Este enlace de invitación no existe o fue reemplazado por uno más nuevo." };
  if (invite.usedAt) return { ok: false, reason: "Este enlace ya se usó. Entra con tu email y contraseña." };
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: "Este enlace expiró. Pide a un admin de keel que te envíe uno nuevo." };
  }
  const member = await store.getMember(invite.memberId);
  if (!member || member.status === "disabled") return { ok: false, reason: "Tu acceso a keel está deshabilitado." };
  return { ok: true, member };
}

/** Sets the password of the invited member and activates it. Each invite works once, until it expires. */
export async function acceptInvite(
  store: Store,
  input: { token: string; password: string; confirm: string },
  now: Date,
): Promise<Member> {
  const check = await checkInvite(store, input.token, now);
  if (!check.ok) throw new ApiError(410, check.reason);
  if (input.password.length < PASSWORD_MIN || input.password.length > PASSWORD_MAX) {
    throw new ApiError(400, `La contraseña debe tener entre ${PASSWORD_MIN} y ${PASSWORD_MAX} caracteres.`);
  }
  if (input.password !== input.confirm) throw new ApiError(400, "Las contraseñas no coinciden.");
  const passwordHash = await hashPassword(input.password);
  return store.transaction(async (tx) => {
    if (!(await tx.useInvite(hashToken(input.token), now))) {
      throw new ApiError(410, "Este enlace ya se usó. Entra con tu email y contraseña.");
    }
    const { member } = check;
    await tx.setMemberPassword(member.id, passwordHash);
    await tx.setMemberStatus(member.id, "active");
    await tx.touchMemberLogin(member.id, now);
    await audit(tx, { name: member.name, memberId: member.id }, "member.activate", { memberId: member.id }, now);
    return (await tx.getMember(member.id)) as Member;
  });
}

/** Refuses to leave keel without an active admin. */
async function keepAnAdmin(store: Store, member: Member, what: string): Promise<void> {
  if (member.role === "admin" && member.status === "active" && (await store.countActiveAdmins()) <= 1) {
    throw new ApiError(409, `No puedes ${what} a ${member.name}: es el último admin activo de keel.`);
  }
}

export async function changeMemberRole(
  store: Store,
  actor: AuditActor,
  memberId: string,
  rawRole: string,
  now: Date,
): Promise<Member> {
  const role = parseRole(rawRole);
  return store.transaction(async (tx) => {
    const member = await getMemberOr404(tx, memberId);
    if (member.role === role) return member;
    if (role !== "admin") await keepAnAdmin(tx, member, "quitarle el rol de admin");
    await tx.setMemberRole(memberId, role);
    await audit(tx, actor, "member.role", { memberId, name: member.name, from: member.role, to: role }, now);
    return (await tx.getMember(memberId)) as Member;
  });
}

/** Disables a member (logs it out and its tokens stop working) or enables it again. */
export async function setMemberEnabled(
  store: Store,
  actor: AuditActor,
  memberId: string,
  enabled: boolean,
  now: Date,
): Promise<Member> {
  return store.transaction(async (tx) => {
    const member = await getMemberOr404(tx, memberId);
    if (!enabled) {
      if (member.status === "disabled") return member;
      await keepAnAdmin(tx, member, "deshabilitar");
      await tx.setMemberStatus(memberId, "disabled");
      await tx.deletePendingInvites(memberId);
      await audit(tx, actor, "member.disable", { memberId, name: member.name }, now);
    } else {
      if (member.status !== "disabled") return member;
      // Without a password it goes back to invited: a new invite link activates it.
      await tx.setMemberStatus(memberId, member.hasPassword ? "active" : "invited");
      await audit(tx, actor, "member.enable", { memberId, name: member.name }, now);
    }
    return (await tx.getMember(memberId)) as Member;
  });
}

export async function addMemberGrant(
  store: Store,
  actor: AuditActor,
  memberId: string,
  input: { repo: string; scope: string; role: string },
  now: Date,
): Promise<MemberGrant> {
  const member = await getMemberOr404(store, memberId);
  const { repoPattern, scopePattern } = normalizeGrantPatterns(input.repo, input.scope);
  const role = parseRole(input.role);
  const grant = await store.addGrant({ memberId, repoPattern, scopePattern, role }, now);
  await audit(
    store,
    actor,
    "member.grant",
    { op: "add", memberId, name: member.name, repo: repoPattern, scope: scopePattern, role },
    now,
  );
  return grant;
}

export async function removeMemberGrant(store: Store, actor: AuditActor, grantId: string, now: Date): Promise<void> {
  const grant = await store.getGrant(grantId);
  if (!grant) throw new ApiError(404, "Permiso no encontrado.");
  await store.deleteGrant(grantId);
  await audit(
    store,
    actor,
    "member.grant",
    {
      op: "remove",
      memberId: grant.memberId,
      repo: grant.repoPattern,
      scope: grant.scopePattern,
      role: grant.role,
    },
    now,
  );
}

/** Email + password login. Undefined for any failure, so the form can't tell which part was wrong. */
export async function loginWithPassword(
  store: Store,
  email: string,
  password: string,
  now: Date,
): Promise<Member | undefined> {
  const member = await store.getMemberByEmail(email);
  // Hash anyway when the member doesn't exist, so the response time doesn't reveal which emails do.
  const hash = member ? await store.getMemberPasswordHash(member.id) : null;
  const valid = await verifyPassword(password, hash ?? "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA");
  if (!member || !hash || !valid || member.status !== "active") return undefined;
  await store.touchMemberLogin(member.id, now);
  await audit(store, { name: member.name, memberId: member.id }, "login", { method: "password" }, now);
  return member;
}

/** `KEEL_ADMIN_PASSWORD` login: signs in as the bootstrap admin, unless an admin disabled it. */
export async function loginBreakGlass(store: Store, now: Date): Promise<Member | undefined> {
  const member = await store.ensureBootstrapAdmin(now);
  if (member.status !== "active") return undefined;
  await store.touchMemberLogin(member.id, now);
  await audit(store, { name: member.name, memberId: member.id }, "login", { method: "KEEL_ADMIN_PASSWORD" }, now);
  return member;
}
