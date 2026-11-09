import { minRole, type Role, roleAtLeast } from "@keel/shared";
import { effectiveRole, forbidden, type Target, tokenRole } from "./roles";
import type { Member, MemberGrant, Store } from "./store";

/**
 * Who is acting, as role checks need it: a member (from an API token or an admin session) with its grants and, for a
 * token, the token's cap; or nobody, with the role anonymous API calls get.
 */
export interface Principal {
  member: Member | null;
  grants: readonly MemberGrant[];
  /** The token's `max_role`; null for an admin session or an uncapped token. */
  maxRole: Role | null;
  /** The role without a member (`KEEL_ANONYMOUS_ROLE`); null for `none`. Ignored when there is a member. */
  anonymousRole: Role | null;
}

/** Who appears in the audit log. */
export interface AuditActor {
  name: string;
  memberId: string | null;
}

export const ANONYMOUS_ACTOR: AuditActor = { name: "anónimo", memberId: null };
export const CI_ACTOR: AuditActor = { name: "ci", memberId: null };

export const actorOf = (p: Principal): AuditActor =>
  p.member ? { name: p.member.name, memberId: p.member.id } : ANONYMOUS_ACTOR;

/** A member's principal for an admin session (no token cap). */
export async function memberPrincipal(store: Store, member: Member): Promise<Principal> {
  return { member, grants: await store.listGrants(member.id), maxRole: null, anonymousRole: null };
}

/** The base role, capped by the token: what `whoami` reports as `role`. */
export const baseRole = (p: Principal): Role | null => (p.member ? minRole(p.member.role, p.maxRole) : null);

/** The role `p` acts with on `target`. */
export function roleOn(p: Principal, target: Target): Role | null {
  if (!p.member) return p.anonymousRole;
  return tokenRole(effectiveRole(p.member.role, p.grants, target), p.maxRole);
}

export const can = (p: Principal, required: Role, target: Target) => roleAtLeast(roleOn(p, target), required);

/** Global admin: members, everyone's tokens, scopes, audit log. Grants don't make someone a global admin. */
export const isAdmin = (p: Principal) => baseRole(p) === "admin";

/**
 * Throws the 403 unless `p` has at least `required` on `target`. `action` is what the message says they can't do,
 * in Spanish ("desplegar", "registrar versiones"…).
 */
export function requireRoleOn(p: Principal, required: Role, action: string, target: Target): Role {
  const role = roleOn(p, target);
  if (!roleAtLeast(role, required)) throw forbidden(role ?? "none", action, target);
  return role as Role;
}
