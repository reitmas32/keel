import { minRole, type Role, roleRank } from "@keel/shared";
import { ApiError } from "./errors";

/** A grant as role resolution needs it: `role` on the repos and services matching both glob patterns. */
export interface GrantRule {
  repoPattern: string;
  servicePattern: string;
  role: Role;
}

/** Where an action happens: a repo (`owner/name`) and, when the action is on one service, its alias. */
export interface Target {
  repo: string;
  service?: string | undefined;
}

export const ANY = "*";

const regexCache = new Map<string, RegExp>();

/** Glob match where `*` is any run of characters (also `/`) and everything else is literal, ignoring case. */
export function globMatch(pattern: string, value: string): boolean {
  let regex = regexCache.get(pattern);
  if (!regex) {
    const source = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regex = new RegExp(`^${source}$`, "i");
    regexCache.set(pattern, regex);
  }
  return regex.test(value);
}

const stars = (pattern: string) => pattern.split("*").length - 1;

/**
 * Orders grants from most to least specific: more literal characters first, then fewer `*`, then the lower role
 * (so of two equally specific grants the stricter wins).
 */
export function compareSpecificity(a: GrantRule, b: GrantRule): number {
  const literals = (g: GrantRule) =>
    g.repoPattern.length + g.servicePattern.length - stars(g.repoPattern + g.servicePattern);
  return (
    literals(b) - literals(a) ||
    stars(a.repoPattern + a.servicePattern) - stars(b.repoPattern + b.servicePattern) ||
    roleRank(a.role) - roleRank(b.role)
  );
}

/**
 * A member's role for a target: the role of the most specific grant that matches it, or the base role when none
 * does. Grants can lower or raise it, but an `admin` stays `admin` everywhere. Without a service (registering a
 * version, reading a whole repo) only grants whose service pattern is `*` apply.
 */
export function effectiveRole(base: Role, grants: readonly GrantRule[], target: Target): Role {
  if (base === "admin") return base;
  const matching = grants.filter(
    (g) =>
      globMatch(g.repoPattern, target.repo) &&
      (target.service === undefined ? g.servicePattern === ANY : globMatch(g.servicePattern, target.service)),
  );
  if (matching.length === 0) return base;
  return [...matching].sort(compareSpecificity)[0]?.role ?? base;
}

/** The role a token acts with: its owner's role there, never above the token's `max_role`. */
export const tokenRole = (ownerRole: Role, maxRole: Role | null) => minRole(ownerRole, maxRole);

export const describeTarget = ({ repo, service }: Target) => (service ? `${repo}/${service}` : repo);

/** The 403 for a role that can't do `action` (in Spanish, e.g. "desplegar") on `target`. */
export const forbidden = (role: Role | "none" | null, action: string, target: Target) =>
  new ApiError(
    403,
    `Tu rol (${role ?? "none"}) no permite ${action} en ${describeTarget(target)}. Pide a un admin de keel que te dé acceso.`,
  );

const REPO_PATTERN = /^[a-z0-9._*-]+(\/[a-z0-9._*-]+)?$|^\*$/;
const SERVICE_PATTERN = /^[a-z0-9*-]+$/;

/** Validates and lowercases a grant's patterns; an empty pattern means `*`. */
export function normalizeGrantPatterns(repo: string, service: string): { repoPattern: string; servicePattern: string } {
  const repoPattern = repo.trim().toLowerCase() || ANY;
  const servicePattern = service.trim().toLowerCase() || ANY;
  if (!REPO_PATTERN.test(repoPattern)) {
    throw new ApiError(
      400,
      `Patrón de repo inválido: ${repoPattern}. Usa owner/nombre con *, p.ej. konectus-io/* o *.`,
    );
  }
  if (!SERVICE_PATTERN.test(servicePattern)) {
    throw new ApiError(400, `Patrón de servicio inválido: ${servicePattern}. Usa un alias con *, p.ej. prod* o *.`);
  }
  return { repoPattern, servicePattern };
}
