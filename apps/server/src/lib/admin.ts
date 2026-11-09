import { LOCK_REASON_MAX, lockServiceRequestSchema, type Role, roleAtLeast } from "@keel/shared";
import { type AuditActor, actorOf, baseRole, isAdmin, type Principal, requireRoleOn } from "./access";
import { createApiToken } from "./api-auth";
import { ApiError } from "./errors";
import type { Target } from "./roles";
import { addService, createScope, rotateCiToken } from "./scopes";
import type { Scope, Service, Store } from "./store";

// What the admin's server actions do, with the role check and the audit entry, so they can be tested without Next.
// Every function throws ApiError (403 for a role that can't, 404 for something missing).

const record = (
  store: Store,
  actor: AuditActor,
  action: string,
  target: Partial<Target>,
  details: Record<string, unknown>,
  now: Date,
) =>
  store.recordAudit(
    {
      actor: actor.name,
      actorMemberId: actor.memberId,
      action,
      repo: target.repo ?? null,
      service: target.service ?? null,
      details: { ...details, via: "admin" },
    },
    now,
  );

/** Throws the 403 unless `p` is a global admin (base role admin, not from a grant). */
export function requireAdmin(p: Principal, action: string): void {
  if (!isAdmin(p)) {
    throw new ApiError(
      403,
      `Tu rol (${baseRole(p) ?? "none"}) no permite ${action} en keel. Pide a un admin de keel que te dé acceso.`,
    );
  }
}

async function scopeOr404(store: Store, scopeId: string): Promise<Scope> {
  const scope = await store.getScope(scopeId);
  if (!scope) throw new ApiError(404, "Scope no encontrado.");
  return scope;
}

async function serviceOr404(store: Store, scope: Scope, serviceId: string): Promise<Service> {
  const service = await store.getService(serviceId);
  if (service?.scopeId !== scope.id) throw new ApiError(404, "Servicio no encontrado.");
  return service;
}

export async function createScopeAs(store: Store, p: Principal, input: { name: string; repoUrl: string }, now: Date) {
  requireAdmin(p, "crear scopes");
  const result = await createScope(store, input, now);
  await record(store, actorOf(p), "scope.create", { repo: result.scope.repo }, { name: result.scope.name }, now);
  return result;
}

export async function deleteScopeAs(store: Store, p: Principal, scopeId: string, now: Date): Promise<void> {
  const scope = await scopeOr404(store, scopeId);
  requireRoleOn(p, "admin", "eliminar scopes", { repo: scope.repo });
  await store.deleteScope(scope.id);
  await record(store, actorOf(p), "scope.delete", { repo: scope.repo }, { name: scope.name }, now);
}

export async function linkServiceAs(
  store: Store,
  p: Principal,
  scopeId: string,
  input: { alias: string; dokployUrl: string; tagVariable?: string },
  now: Date,
): Promise<Service> {
  const scope = await scopeOr404(store, scopeId);
  requireRoleOn(p, "maintainer", "vincular servicios", { repo: scope.repo });
  const service = await addService(store, scope, input, now);
  await record(
    store,
    actorOf(p),
    "service.link",
    { repo: scope.repo, service: service.alias },
    { kind: service.kind, dokployId: service.dokployId, tagVariable: service.tagVariable },
    now,
  );
  return service;
}

export async function unlinkServiceAs(
  store: Store,
  p: Principal,
  scopeId: string,
  serviceId: string,
  now: Date,
): Promise<void> {
  const scope = await scopeOr404(store, scopeId);
  const service = await serviceOr404(store, scope, serviceId);
  requireRoleOn(p, "maintainer", "desvincular servicios", { repo: scope.repo, service: service.alias });
  await store.deleteService(service.id);
  await record(store, actorOf(p), "service.unlink", { repo: scope.repo, service: service.alias }, {}, now);
}

/** Returns the new plaintext CI token, shown once. */
export async function rotateCiTokenAs(store: Store, p: Principal, scopeId: string, now: Date): Promise<string> {
  const scope = await scopeOr404(store, scopeId);
  requireRoleOn(p, "maintainer", "rotar el token de CI", { repo: scope.repo });
  const token = await rotateCiToken(store, scope.id);
  await record(store, actorOf(p), "ci_token.rotate", { repo: scope.repo }, {}, now);
  return token;
}

export async function lockServiceAs(
  store: Store,
  p: Principal,
  scopeId: string,
  serviceId: string,
  rawReason: string,
  now: Date,
): Promise<void> {
  const scope = await scopeOr404(store, scopeId);
  const service = await serviceOr404(store, scope, serviceId);
  const target = { repo: scope.repo, service: service.alias };
  requireRoleOn(p, "maintainer", "bloquear servicios", target);
  const parsed = lockServiceRequestSchema.safeParse({ reason: rawReason });
  if (!parsed.success) throw new ApiError(400, `Escribe el motivo del bloqueo (1 a ${LOCK_REASON_MAX} caracteres).`);
  const actor = actorOf(p);
  await store.lockService({ serviceId, reason: parsed.data.reason, lockedBy: actor.name }, now);
  await record(store, actor, "lock.set", target, { reason: parsed.data.reason }, now);
}

export async function unlockServiceAs(
  store: Store,
  p: Principal,
  scopeId: string,
  serviceId: string,
  now: Date,
): Promise<void> {
  const scope = await scopeOr404(store, scopeId);
  const service = await serviceOr404(store, scope, serviceId);
  const target = { repo: scope.repo, service: service.alias };
  requireRoleOn(p, "maintainer", "desbloquear servicios", target);
  if (await store.unlockService(service.id)) await record(store, actorOf(p), "lock.clear", target, {}, now);
}

/** A token for the member signed in, optionally capped at `maxRole`. Returns the plaintext once. */
export async function createTokenAs(
  store: Store,
  p: Principal,
  input: { name: string; maxRole: Role | null },
  now: Date,
) {
  if (!p.member) throw new ApiError(401, "Inicia sesión para crear tokens.");
  const result = await createApiToken(store, { name: input.name, owner: p.member, maxRole: input.maxRole }, now);
  await record(
    store,
    actorOf(p),
    "token.create",
    {},
    { tokenId: result.record.id, name: result.record.name, maxRole: result.record.maxRole },
    now,
  );
  return result;
}

/** Members revoke their own tokens; admins revoke anyone's. */
export async function revokeTokenAs(store: Store, p: Principal, tokenId: string, now: Date): Promise<void> {
  const token = await store.getApiToken(tokenId);
  if (!token) throw new ApiError(404, "Token no encontrado.");
  if (token.memberId !== p.member?.id) requireAdmin(p, "revocar tokens de otros miembros");
  await store.deleteApiToken(token.id);
  await record(
    store,
    actorOf(p),
    "token.revoke",
    {},
    { tokenId: token.id, name: token.name, ownerId: token.memberId },
    now,
  );
}

/** The roles `p` may cap a new token at: up to its own base role. */
export const tokenRoleChoices = (p: Principal, roles: readonly Role[]) =>
  roles.filter((r) => p.member && roleAtLeast(p.member.role, r));
