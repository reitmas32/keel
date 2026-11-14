import { LOCK_REASON_MAX, lockScopeRequestSchema, type Role, roleAtLeast } from "@keel/shared";
import { type AuditActor, actorOf, baseRole, isAdmin, type Principal, requireRoleOn } from "./access";
import { createApiToken } from "./api-auth";
import { addScope, createApp, rotateCiToken } from "./apps";
import { ApiError } from "./errors";
import { maskUrl, parseChannelInput } from "./notify";
import type { Target } from "./roles";
import type { App, NotificationChannel, Scope, Store } from "./store";

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
      scope: target.scope ?? null,
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

async function appOr404(store: Store, appId: string): Promise<App> {
  const app = await store.getApp(appId);
  if (!app) throw new ApiError(404, "App no encontrada.");
  return app;
}

async function scopeOr404(store: Store, app: App, scopeId: string): Promise<Scope> {
  const scope = await store.getScope(scopeId);
  if (scope?.appId !== app.id) throw new ApiError(404, "Scope no encontrado.");
  return scope;
}

export async function createAppAs(store: Store, p: Principal, input: { name: string; repoUrl: string }, now: Date) {
  requireAdmin(p, "crear apps");
  const result = await createApp(store, input, now);
  await record(store, actorOf(p), "app.create", { repo: result.app.repo }, { name: result.app.name }, now);
  return result;
}

export async function deleteAppAs(store: Store, p: Principal, appId: string, now: Date): Promise<void> {
  const app = await appOr404(store, appId);
  requireRoleOn(p, "admin", "eliminar apps", { repo: app.repo });
  await store.deleteApp(app.id);
  await record(store, actorOf(p), "app.delete", { repo: app.repo }, { name: app.name }, now);
}

export async function linkScopeAs(
  store: Store,
  p: Principal,
  appId: string,
  input: { alias: string; dokployUrl: string; tagVariable?: string },
  now: Date,
): Promise<Scope> {
  const app = await appOr404(store, appId);
  requireRoleOn(p, "maintainer", "vincular scopes", { repo: app.repo });
  const scope = await addScope(store, app, input, now);
  await record(
    store,
    actorOf(p),
    "scope.link",
    { repo: app.repo, scope: scope.alias },
    { kind: scope.kind, dokployId: scope.dokployId, tagVariable: scope.tagVariable },
    now,
  );
  return scope;
}

export async function unlinkScopeAs(
  store: Store,
  p: Principal,
  appId: string,
  scopeId: string,
  now: Date,
): Promise<void> {
  const app = await appOr404(store, appId);
  const scope = await scopeOr404(store, app, scopeId);
  requireRoleOn(p, "maintainer", "desvincular scopes", { repo: app.repo, scope: scope.alias });
  await store.deleteScope(scope.id);
  await record(store, actorOf(p), "scope.unlink", { repo: app.repo, scope: scope.alias }, {}, now);
}

/** Returns the new plaintext CI token, shown once. */
export async function rotateCiTokenAs(store: Store, p: Principal, appId: string, now: Date): Promise<string> {
  const app = await appOr404(store, appId);
  requireRoleOn(p, "maintainer", "rotar el token de CI", { repo: app.repo });
  const token = await rotateCiToken(store, app.id);
  await record(store, actorOf(p), "ci_token.rotate", { repo: app.repo }, {}, now);
  return token;
}

export async function lockScopeAs(
  store: Store,
  p: Principal,
  appId: string,
  scopeId: string,
  rawReason: string,
  now: Date,
): Promise<void> {
  const app = await appOr404(store, appId);
  const scope = await scopeOr404(store, app, scopeId);
  const target = { repo: app.repo, scope: scope.alias };
  requireRoleOn(p, "maintainer", "bloquear scopes", target);
  const parsed = lockScopeRequestSchema.safeParse({ reason: rawReason });
  if (!parsed.success) throw new ApiError(400, `Escribe el motivo del bloqueo (1 a ${LOCK_REASON_MAX} caracteres).`);
  const actor = actorOf(p);
  await store.lockScope({ scopeId, reason: parsed.data.reason, lockedBy: actor.name }, now);
  await record(store, actor, "lock.set", target, { reason: parsed.data.reason }, now);
}

export async function unlockScopeAs(
  store: Store,
  p: Principal,
  appId: string,
  scopeId: string,
  now: Date,
): Promise<void> {
  const app = await appOr404(store, appId);
  const scope = await scopeOr404(store, app, scopeId);
  const target = { repo: app.repo, scope: scope.alias };
  requireRoleOn(p, "maintainer", "desbloquear scopes", target);
  if (await store.unlockScope(scope.id)) await record(store, actorOf(p), "lock.clear", target, {}, now);
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

// --- notification channels (global admins only) ---

/** What the audit log keeps of a channel: never its URL or secret, only a masked hint. */
const channelDetails = (c: NotificationChannel) => ({
  channelId: c.id,
  name: c.name,
  kind: c.kind,
  url: maskUrl(c.url),
  events: c.events,
  repo: c.repoPattern,
  scope: c.scopePattern,
});

export async function createChannelAs(
  store: Store,
  p: Principal,
  input: Parameters<typeof parseChannelInput>[0],
  now: Date,
): Promise<NotificationChannel> {
  requireAdmin(p, "configurar notificaciones");
  const channel = await store.createChannel(parseChannelInput(input), now);
  await record(store, actorOf(p), "channel.create", {}, channelDetails(channel), now);
  return channel;
}

async function channelOr404(store: Store, id: string): Promise<NotificationChannel> {
  const channel = await store.getChannel(id);
  if (!channel) throw new ApiError(404, "Canal no encontrado.");
  return channel;
}

export async function setChannelEnabledAs(
  store: Store,
  p: Principal,
  id: string,
  enabled: boolean,
  now: Date,
): Promise<void> {
  requireAdmin(p, "configurar notificaciones");
  const channel = await channelOr404(store, id);
  if (channel.enabled === enabled) return;
  await store.setChannelEnabled(id, enabled);
  await record(store, actorOf(p), enabled ? "channel.enable" : "channel.disable", {}, channelDetails(channel), now);
}

export async function deleteChannelAs(store: Store, p: Principal, id: string, now: Date): Promise<void> {
  requireAdmin(p, "configurar notificaciones");
  const channel = await channelOr404(store, id);
  await store.deleteChannel(id);
  await record(store, actorOf(p), "channel.delete", {}, channelDetails(channel), now);
}
