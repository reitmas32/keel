import {
  type AppInfo,
  type CreateAppResponse,
  ciResultRequestSchema,
  createAppRequestSchema,
  createDeployRequestSchema,
  type Deploy,
  type DeployDetail,
  type DokployService,
  type DokployServicesResponse,
  linkScopeRequestSchema,
  lockScopeRequestSchema,
  type RepoResponse,
  type RotateCiTokenResponse,
  registerVersionRequestSchema,
  roleAtLeast,
  type ScopeLock,
  type ScopeLockInfo,
  type ScopeSummary,
  type UnlockScopeResponse,
  VERSION_CI_STATUSES,
  type VersionCiStatus,
  type WhoamiResponse,
} from "@keel/shared";
import type { z } from "zod";
import { actorOf, baseRole, CI_ACTOR, type Principal, requireRoleOn } from "./access";
import { authenticate, type Caller } from "./api-auth";
import {
  addScope,
  assertScopeAliasFree,
  createApp,
  normalizeScopeAlias,
  parseGithubRepoUrl,
  resolveDokployService,
  rotateCiToken,
} from "./apps";
import type { AppContext } from "./context";
import { recordCiResult, registerVersion, requestDeploy } from "./deploys";
import { DokployError } from "./dokploy";
import { ApiError } from "./errors";
import { type Target, tokenRole } from "./roles";
import { type App, type DeployRecord, normalizeRepo, type Scope, type ScopeLockRecord } from "./store";
import { bearerToken } from "./tokens";

/** A deploy as the API returns it: with `service`, the name of `scope` before v0.7.0, for older clients. */
const toPublic = ({ scopeId: _s, ...deploy }: DeployRecord): Deploy => ({ ...deploy, service: deploy.scope });

const toLockInfo = ({ reason, lockedBy, createdAt }: ScopeLockRecord): ScopeLockInfo => ({
  reason,
  lockedBy,
  createdAt,
});

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const MIN_ID_PREFIX = 4;

async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new ApiError(400, "El cuerpo debe ser JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new ApiError(400, `Petición inválida: ${issues}`);
  }
  return parsed.data;
}

async function findApp(ctx: AppContext, owner: string, name: string): Promise<App> {
  const app = await ctx.store.getAppByRepo(`${owner}/${name}`);
  if (!app) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ninguna app de keel.`);
  return app;
}

async function findScope(ctx: AppContext, app: App, alias: string): Promise<Scope> {
  const scope = await ctx.store.getScopeByAlias(app.id, alias);
  if (!scope) {
    const available = (await ctx.store.listScopes(app.id)).map((s) => s.alias);
    throw new ApiError(
      404,
      `El scope ${alias} no existe en ${app.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
    );
  }
  return scope;
}

const toAppInfo = ({ id, name, repo, createdAt }: App): AppInfo => ({ id, name, repo, createdAt });

/** A scope as `GET …/scopes` lists it: with its Dokploy name, current and last deploy, and lock. */
async function scopeSummary(ctx: AppContext, s: Scope): Promise<ScopeSummary> {
  const [current] = await ctx.store.listDeploys({ scopeId: s.id, status: "deployed" }, { limit: 1, newestFirst: true });
  const [last] = await ctx.store.listDeploys({ scopeId: s.id }, { limit: 1, newestFirst: true });
  const lock = await ctx.store.getScopeLock(s.id);
  return {
    alias: s.alias,
    kind: s.kind,
    tagVariable: s.tagVariable,
    dokployId: s.dokployId,
    dokployUrl: s.dokployUrl,
    dokployName: (await ctx.dokploy.describe({ kind: s.kind, id: s.dokployId, tagVariable: s.tagVariable })) ?? null,
    current: current ? toPublic(current) : null,
    last: last ? toPublic(last) : null,
    lock: lock ? toLockInfo(lock) : null,
  };
}

const scopeSummaries = async (ctx: AppContext, app: App) =>
  Promise.all((await ctx.store.listScopes(app.id)).map((s) => scopeSummary(ctx, s)));

/**
 * Seeing Dokploy's services is for whoever can link them: maintainer as base role, or through any grant (both
 * capped by the token). Anonymous calls never can: their role is at most deployer.
 */
function requireDokployReader(caller: Caller): void {
  const base = caller.member ? baseRole(caller) : caller.anonymousRole;
  const byGrant =
    caller.member !== null && caller.grants.some((g) => roleAtLeast(tokenRole(g.role, caller.maxRole), "maintainer"));
  if (!roleAtLeast(base, "maintainer") && !byGrant) {
    throw new ApiError(
      403,
      `Tu rol (${base ?? "none"}) no permite ver los servicios de Dokploy en keel. Pide a un admin de keel que te dé acceso.`,
    );
  }
}

/**
 * The `scope` query parameter, or `service`, its name before v0.7.0. When both come they must match, like the body
 * of `POST /deploys`.
 */
function scopeParam(params: URLSearchParams): string | undefined {
  const scope = params.get("scope") || undefined;
  const service = params.get("service") || undefined;
  if (scope && service && scope !== service) {
    throw new ApiError(400, `scope (${scope}) y service (${service}) no coinciden; usa solo scope.`);
  }
  return scope ?? service;
}

function parseLimit(params: URLSearchParams): number {
  const limitParam = params.get("limit");
  const limit = limitParam === null ? DEFAULT_LIST_LIMIT : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ApiError(400, `limit debe ser un entero entre 1 y ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

/** Wraps a handler so ApiErrors become JSON responses and anything else is a logged 500. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof DokployError) return Response.json({ error: error.message }, { status: 502 });
    console.error("[keel] error no controlado", error);
    return Response.json({ error: "Error interno." }, { status: 500 });
  }
}

/** Records an API mutation in the audit log, as the caller (or `anónimo`). */
const audit = (
  ctx: AppContext,
  caller: Principal & { tokenName?: string | null },
  action: string,
  target: Target,
  details: Record<string, unknown>,
) => {
  const actor = actorOf(caller);
  return ctx.store.recordAudit(
    {
      actor: actor.name,
      actorMemberId: actor.memberId,
      action,
      repo: target.repo,
      scope: target.scope ?? null,
      details: { ...details, via: "api", ...(caller.tokenName && { token: caller.tokenName }) },
    },
    ctx.now(),
  );
};

const repoOf = (owner: string, name: string) => normalizeRepo(`${owner}/${name}`);

/** Like `handle`, for the routes that need the caller's API token (all but /health and /ci-result). */
function authed(ctx: AppContext, request: Request, fn: (caller: Caller) => Promise<Response> | Response) {
  return handle(async () => fn(await authenticate(ctx, request)));
}

export const handlers = {
  createDeploy: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async (caller) => {
      const body = await parseBody(request, createDeployRequestSchema);
      const target = { repo: normalizeRepo(body.repo), scope: body.scope };
      requireRoleOn(caller, "deployer", "desplegar", target);
      const deploy = await requestDeploy(ctx.store, body, ctx.now(), caller.name);
      await audit(ctx, caller, "deploy.create", target, {
        deployId: deploy.id,
        tag: deploy.tag,
        sha: deploy.sha,
        status: deploy.status,
      });
      return Response.json(toPublic(deploy), { status: 202 });
    }),

  getDeploy: (ctx: AppContext, request: Request, id: string) =>
    authed(ctx, request, async (caller) => {
      const deploy = await ctx.store.getDeploy(id);
      if (!deploy) throw new ApiError(404, `Deploy ${id} no encontrado.`);
      requireRoleOn(caller, "viewer", "ver deploys", { repo: deploy.repo, scope: deploy.scope });
      return Response.json(toPublic(deploy));
    }),

  /** Authenticated with the repo's CI token, not with an API token. */
  ciResult: (ctx: AppContext, request: Request) =>
    handle(async () => {
      const token = bearerToken(request.headers.get("authorization"));
      const body = await parseBody(request, ciResultRequestSchema);
      const { updated } = await recordCiResult(ctx.store, body, token, ctx.now());
      await ctx.store.recordAudit(
        {
          actor: CI_ACTOR.name,
          action: "ci.result",
          repo: body.repo,
          details: { tag: body.tag, sha: body.sha, status: body.status, deploys: updated.map((d) => d.id) },
        },
        ctx.now(),
      );
      return Response.json({ ok: true, updated: updated.map(toPublic) });
    }),

  whoami: (ctx: AppContext, request: Request) =>
    authed(ctx, request, (caller) => {
      const body: WhoamiResponse = {
        name: caller.name,
        email: caller.member?.email ?? null,
        role: baseRole(caller),
        grants: caller.grants.map((g) => ({
          repo: g.repoPattern,
          scope: g.scopePattern,
          service: g.scopePattern,
          role: g.role,
        })),
        tokenMaxRole: caller.maxRole,
        auth: ctx.env.KEEL_API_AUTH,
        anonymousRole: ctx.env.KEEL_ANONYMOUS_ROLE ?? "deployer",
      };
      return Response.json(body);
    }),

  /** `GET …/scopes`, and `GET …/services` for clients before v0.7.0: the same list under both keys. */
  listScopes: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      requireRoleOn(caller, "viewer", "ver scopes", { repo: repoOf(owner, name) });
      const app = await findApp(ctx, owner, name);
      const scopes = await scopeSummaries(ctx, app);
      return Response.json({ repo: app.repo, scopes, services: scopes });
    }),

  /** `GET /repos/:owner/:name`: the app linked to the repo, with its scopes. */
  getRepo: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      requireRoleOn(caller, "viewer", "ver la app", { repo: repoOf(owner, name) });
      const app = await findApp(ctx, owner, name);
      const body: RepoResponse = { app: toAppInfo(app), scopes: await scopeSummaries(ctx, app) };
      return Response.json(body);
    }),

  /** `POST /apps`: links a repo. Needs admin on that repo; the CI token is returned here and never again. */
  createApp: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async (caller) => {
      const body = await parseBody(request, createAppRequestSchema);
      const repo = parseGithubRepoUrl(body.repo);
      if (!repo) throw new ApiError(400, `URL de repo de GitHub inválida: ${body.repo}`);
      requireRoleOn(caller, "admin", "crear apps", { repo });
      const { app, ciToken } = await createApp(ctx.store, { name: body.name ?? "", repoUrl: repo }, ctx.now());
      await audit(ctx, caller, "app.create", { repo: app.repo }, { name: app.name });
      const response: CreateAppResponse = { app: toAppInfo(app), ciToken };
      return Response.json(response, { status: 201 });
    }),

  /** `POST /repos/:owner/:name/ci-token`: a new CI token, shown once; the previous one stops working. */
  rotateCiToken: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      const target = { repo: repoOf(owner, name) };
      requireRoleOn(caller, "maintainer", "rotar el token de CI", target);
      const app = await findApp(ctx, owner, name);
      const ciToken = await rotateCiToken(ctx.store, app.id);
      await audit(ctx, caller, "ci_token.rotate", { repo: app.repo }, {});
      const body: RotateCiTokenResponse = { ciToken };
      return Response.json(body);
    }),

  /**
   * `POST /repos/:owner/:name/scopes`: links a Dokploy service, by its dashboard URL (as in the admin) or by
   * `kind` + `dokployId`, which Dokploy must confirm.
   */
  linkScope: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      const body = await parseBody(request, linkScopeRequestSchema);
      const alias = normalizeScopeAlias(body.alias);
      const target = { repo: repoOf(owner, name), scope: alias };
      requireRoleOn(caller, "maintainer", "vincular scopes", target);
      const app = await findApp(ctx, owner, name);
      await assertScopeAliasFree(ctx.store, app, alias);
      const dokployUrl =
        body.dokployUrl ??
        (await resolveDokployService(ctx.dokploy, body.kind as "application" | "compose", body.dokployId as string));
      const scope = await addScope(
        ctx.store,
        app,
        { alias, dokployUrl, ...(body.tagVariable !== undefined && { tagVariable: body.tagVariable }) },
        ctx.now(),
      );
      await audit(
        ctx,
        caller,
        "scope.link",
        { repo: app.repo, scope: scope.alias },
        { kind: scope.kind, dokployId: scope.dokployId, tagVariable: scope.tagVariable },
      );
      return Response.json(await scopeSummary(ctx, scope), { status: 201 });
    }),

  /** `GET /dokploy/services`: Dokploy's applications and composes, and which keel scope points at each. */
  listDokployServices: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async (caller) => {
      requireDokployReader(caller);
      const found = await ctx.dokploy.listServices();
      const linked = new Map<string, { repo: string; scope: string }>();
      for (const s of await ctx.store.listAllScopes()) {
        const key = `${s.kind}:${s.dokployId}`;
        if (!linked.has(key)) linked.set(key, { repo: s.repo, scope: s.alias });
      }
      const services: DokployService[] = found.map((s) => ({
        kind: s.kind,
        id: s.id,
        name: s.name,
        ...(s.appName && { appName: s.appName }),
        project: s.project,
        environment: s.environment,
        dashboardUrl: s.dashboardUrl,
        linked: linked.get(`${s.kind}:${s.id}`) ?? null,
      }));
      const body: DokployServicesResponse = { services };
      return Response.json(body);
    }),

  lockScope: (ctx: AppContext, request: Request, owner: string, name: string, alias: string) =>
    authed(ctx, request, async (caller) => {
      const target = { repo: repoOf(owner, name), scope: alias };
      requireRoleOn(caller, "maintainer", "bloquear scopes", target);
      const scope = await findScope(ctx, await findApp(ctx, owner, name), alias);
      const { reason } = await parseBody(request, lockScopeRequestSchema);
      const lock = await ctx.store.lockScope({ scopeId: scope.id, reason, lockedBy: caller.name }, ctx.now());
      await audit(ctx, caller, "lock.set", target, { reason });
      const body: ScopeLock = { alias: scope.alias, ...toLockInfo(lock) };
      return Response.json(body);
    }),

  unlockScope: (ctx: AppContext, request: Request, owner: string, name: string, alias: string) =>
    authed(ctx, request, async (caller) => {
      const target = { repo: repoOf(owner, name), scope: alias };
      requireRoleOn(caller, "maintainer", "desbloquear scopes", target);
      const scope = await findScope(ctx, await findApp(ctx, owner, name), alias);
      const body: UnlockScopeResponse = { ok: true, wasLocked: await ctx.store.unlockScope(scope.id) };
      if (body.wasLocked) await audit(ctx, caller, "lock.clear", target, {});
      return Response.json(body);
    }),

  registerVersion: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async (caller) => {
      const body = await parseBody(request, registerVersionRequestSchema);
      const target = { repo: normalizeRepo(body.repo) };
      requireRoleOn(caller, "publisher", "registrar versiones", target);
      const version = await registerVersion(ctx.store, body, ctx.now());
      await audit(ctx, caller, "version.register", target, { tag: body.tag, sha: body.sha });
      return Response.json(version, { status: 201 });
    }),

  listRepoVersions: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      requireRoleOn(caller, "viewer", "ver versiones", { repo: repoOf(owner, name) });
      const app = await findApp(ctx, owner, name);
      const params = new URL(request.url).searchParams;
      const limit = parseLimit(params);
      const status = params.get("status");
      if (status !== null && !VERSION_CI_STATUSES.includes(status as VersionCiStatus)) {
        throw new ApiError(400, `status debe ser uno de: ${VERSION_CI_STATUSES.join(", ")}.`);
      }

      const versions = await ctx.store.listVersions(app.repo, {
        limit,
        ...(status !== null && { status: status as VersionCiStatus }),
      });
      return Response.json({ repo: app.repo, versions });
    }),

  listRepoDeploys: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async (caller) => {
      const params = new URL(request.url).searchParams;
      const alias = scopeParam(params);
      requireRoleOn(caller, "viewer", "ver deploys", { repo: repoOf(owner, name), scope: alias ?? undefined });
      const app = await findApp(ctx, owner, name);
      const limit = parseLimit(params);
      const scopeId = alias ? (await findScope(ctx, app, alias)).id : undefined;

      const deploys = await ctx.store.listDeploys(
        { repo: app.repo, ...(scopeId && { scopeId }) },
        { limit, newestFirst: true },
      );
      return Response.json({ repo: app.repo, deploys: deploys.map(toPublic) });
    }),

  getRepoDeploy: (ctx: AppContext, request: Request, owner: string, name: string, idPrefix: string) =>
    authed(ctx, request, async (caller) => {
      requireRoleOn(caller, "viewer", "ver deploys", { repo: repoOf(owner, name) });
      const app = await findApp(ctx, owner, name);
      if (idPrefix.length < MIN_ID_PREFIX) {
        throw new ApiError(400, `Usa al menos ${MIN_ID_PREFIX} caracteres del id del deploy.`);
      }

      const matches = await ctx.store.findDeploysByPrefix(app.repo, idPrefix.toLowerCase());
      if (matches.length === 0) throw new ApiError(404, `No hay ningún deploy ${idPrefix} en ${app.repo}.`);
      if (matches.length > 1) {
        const ids = matches.map((d) => `${d.id.slice(0, 8)} (${d.tag} → ${d.scope})`).join(", ");
        throw new ApiError(409, `${idPrefix} coincide con varios deploys: ${ids}. Usa más caracteres.`);
      }

      const deploy = matches[0] as DeployRecord;
      const scope = await ctx.store.getScope(deploy.scopeId);
      const detail: DeployDetail = {
        ...toPublic(deploy),
        scopeKind: scope?.kind ?? null,
        serviceKind: scope?.kind ?? null,
        tagVariable: scope?.tagVariable ?? null,
      };
      return Response.json(detail);
    }),
};
