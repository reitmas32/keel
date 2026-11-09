import {
  ciResultRequestSchema,
  createDeployRequestSchema,
  type Deploy,
  type DeployDetail,
  lockServiceRequestSchema,
  registerVersionRequestSchema,
  type ServiceLock,
  type ServiceLockInfo,
  type ServiceSummary,
  type UnlockServiceResponse,
  VERSION_CI_STATUSES,
  type VersionCiStatus,
  type WhoamiResponse,
} from "@keel/shared";
import type { z } from "zod";
import { authenticate, type Caller } from "./api-auth";
import type { AppContext } from "./context";
import { recordCiResult, registerVersion, requestDeploy } from "./deploys";
import { DokployError } from "./dokploy";
import { ApiError } from "./errors";
import type { DeployRecord, Scope, Service, ServiceLockRecord } from "./store";
import { bearerToken } from "./tokens";

const toPublic = ({ serviceId: _s, ...deploy }: DeployRecord): Deploy => deploy;

const toLockInfo = ({ reason, lockedBy, createdAt }: ServiceLockRecord): ServiceLockInfo => ({
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

function findScope(ctx: AppContext, owner: string, name: string): Scope {
  const scope = ctx.store.getScopeByRepo(`${owner}/${name}`);
  if (!scope) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ningún scope.`);
  return scope;
}

function findService(ctx: AppContext, scope: Scope, alias: string): Service {
  const service = ctx.store.getServiceByAlias(scope.id, alias);
  if (!service) {
    const available = ctx.store.listServices(scope.id).map((s) => s.alias);
    throw new ApiError(
      404,
      `El servicio ${alias} no existe en ${scope.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
    );
  }
  return service;
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

/** Like `handle`, for the routes that need the caller's API token (all but /health and /ci-result). */
function authed(ctx: AppContext, request: Request, fn: (caller: Caller) => Promise<Response> | Response) {
  return handle(() => fn(authenticate(ctx, request)));
}

export const handlers = {
  createDeploy: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async (caller) => {
      const body = await parseBody(request, createDeployRequestSchema);
      const deploy = requestDeploy(ctx.store, body, ctx.now(), caller.name);
      return Response.json(toPublic(deploy), { status: 202 });
    }),

  getDeploy: (ctx: AppContext, request: Request, id: string) =>
    authed(ctx, request, () => {
      const deploy = ctx.store.getDeploy(id);
      if (!deploy) throw new ApiError(404, `Deploy ${id} no encontrado.`);
      return Response.json(toPublic(deploy));
    }),

  /** Authenticated with the repo's CI token, not with an API token. */
  ciResult: (ctx: AppContext, request: Request) =>
    handle(async () => {
      const token = bearerToken(request.headers.get("authorization"));
      const body = await parseBody(request, ciResultRequestSchema);
      const { updated } = recordCiResult(ctx.store, body, token, ctx.now());
      return Response.json({ ok: true, updated: updated.map(toPublic) });
    }),

  whoami: (ctx: AppContext, request: Request) =>
    authed(ctx, request, (caller) => {
      const body: WhoamiResponse = { name: caller.name, auth: ctx.env.KEEL_API_AUTH };
      return Response.json(body);
    }),

  listServices: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, async () => {
      const scope = findScope(ctx, owner, name);
      const services: ServiceSummary[] = await Promise.all(
        ctx.store.listServices(scope.id).map(async (s) => {
          const [current] = ctx.store.listDeploys(
            { serviceId: s.id, status: "deployed" },
            { limit: 1, newestFirst: true },
          );
          const [last] = ctx.store.listDeploys({ serviceId: s.id }, { limit: 1, newestFirst: true });
          const lock = ctx.store.getServiceLock(s.id);
          return {
            alias: s.alias,
            kind: s.kind,
            tagVariable: s.tagVariable,
            dokployId: s.dokployId,
            dokployUrl: s.dokployUrl,
            dokployName:
              (await ctx.dokploy.describe({ kind: s.kind, id: s.dokployId, tagVariable: s.tagVariable })) ?? null,
            current: current ? toPublic(current) : null,
            last: last ? toPublic(last) : null,
            lock: lock ? toLockInfo(lock) : null,
          };
        }),
      );
      return Response.json({ repo: scope.repo, services });
    }),

  lockService: (ctx: AppContext, request: Request, owner: string, name: string, alias: string) =>
    authed(ctx, request, async (caller) => {
      const service = findService(ctx, findScope(ctx, owner, name), alias);
      const { reason } = await parseBody(request, lockServiceRequestSchema);
      const lock = ctx.store.lockService({ serviceId: service.id, reason, lockedBy: caller.name }, ctx.now());
      const body: ServiceLock = { alias: service.alias, ...toLockInfo(lock) };
      return Response.json(body);
    }),

  unlockService: (ctx: AppContext, request: Request, owner: string, name: string, alias: string) =>
    authed(ctx, request, () => {
      const service = findService(ctx, findScope(ctx, owner, name), alias);
      const body: UnlockServiceResponse = { ok: true, wasLocked: ctx.store.unlockService(service.id) };
      return Response.json(body);
    }),

  registerVersion: (ctx: AppContext, request: Request) =>
    authed(ctx, request, async () => {
      const body = await parseBody(request, registerVersionRequestSchema);
      return Response.json(registerVersion(ctx.store, body, ctx.now()), { status: 201 });
    }),

  listRepoVersions: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, () => {
      const scope = findScope(ctx, owner, name);
      const params = new URL(request.url).searchParams;
      const limit = parseLimit(params);
      const status = params.get("status");
      if (status !== null && !VERSION_CI_STATUSES.includes(status as VersionCiStatus)) {
        throw new ApiError(400, `status debe ser uno de: ${VERSION_CI_STATUSES.join(", ")}.`);
      }

      const versions = ctx.store.listVersions(scope.repo, {
        limit,
        ...(status !== null && { status: status as VersionCiStatus }),
      });
      return Response.json({ repo: scope.repo, versions });
    }),

  listRepoDeploys: (ctx: AppContext, request: Request, owner: string, name: string) =>
    authed(ctx, request, () => {
      const scope = findScope(ctx, owner, name);
      const params = new URL(request.url).searchParams;
      const limit = parseLimit(params);
      const alias = params.get("service");
      const serviceId = alias ? findService(ctx, scope, alias).id : undefined;

      const deploys = ctx.store.listDeploys(
        { repo: scope.repo, ...(serviceId && { serviceId }) },
        { limit, newestFirst: true },
      );
      return Response.json({ repo: scope.repo, deploys: deploys.map(toPublic) });
    }),

  getRepoDeploy: (ctx: AppContext, request: Request, owner: string, name: string, idPrefix: string) =>
    authed(ctx, request, () => {
      const scope = findScope(ctx, owner, name);
      if (idPrefix.length < MIN_ID_PREFIX) {
        throw new ApiError(400, `Usa al menos ${MIN_ID_PREFIX} caracteres del id del deploy.`);
      }

      const matches = ctx.store.findDeploysByPrefix(scope.repo, idPrefix.toLowerCase());
      if (matches.length === 0) throw new ApiError(404, `No hay ningún deploy ${idPrefix} en ${scope.repo}.`);
      if (matches.length > 1) {
        const ids = matches.map((d) => `${d.id.slice(0, 8)} (${d.tag} → ${d.service})`).join(", ");
        throw new ApiError(409, `${idPrefix} coincide con varios deploys: ${ids}. Usa más caracteres.`);
      }

      const deploy = matches[0] as DeployRecord;
      const service = ctx.store.getService(deploy.serviceId);
      const detail: DeployDetail = {
        ...toPublic(deploy),
        serviceKind: service?.kind ?? null,
        tagVariable: service?.tagVariable ?? null,
      };
      return Response.json(detail);
    }),
};
