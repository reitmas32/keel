/**
 * Member roles, lowest to highest. Each one can do everything the ones before it can:
 * - viewer: read apps, their scopes, versions, deploys and locks;
 * - publisher: register versions (`POST /api/versions`);
 * - deployer: create deploys (deploy, rollback and promote);
 * - maintainer: lock and unlock scopes; in the admin, link and unlink scopes and rotate an app's CI token;
 * - admin: everything, including members, everyone's tokens, apps and the audit log.
 */
export const ROLES = ["viewer", "publisher", "deployer", "maintainer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** What an `/api` call without a token may do while `KEEL_API_AUTH=optional` (`KEEL_ANONYMOUS_ROLE`). */
export const ANONYMOUS_ROLES = ["none", "viewer", "publisher", "deployer"] as const;
export type AnonymousRole = (typeof ANONYMOUS_ROLES)[number];

export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/** Position in ROLES; higher can do more. */
export const roleRank = (role: Role): number => ROLES.indexOf(role);

/** Whether `role` can do what `required` can. A missing role can do nothing. */
export const roleAtLeast = (role: Role | null | undefined, required: Role): boolean =>
  role != null && roleRank(role) >= roleRank(required);

/** The lower of two roles; a null side doesn't limit. */
export function minRole(a: Role, b: Role | null | undefined): Role;
export function minRole(a: Role | null | undefined, b: Role | null | undefined): Role | null;
export function minRole(a: Role | null | undefined, b: Role | null | undefined): Role | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return roleRank(a) <= roleRank(b) ? a : b;
}
