import {
  ciResultRequestSchema,
  createDeployRequestSchema,
  type Deploy,
  type DeployDetail,
  registerVersionRequestSchema,
  VERSION_CI_STATUSES,
  type VersionCiStatus,
} from "@keel/shared";
import type { z } from "zod";
import type { AppContext } from "./context";
import { recordCiResult, registerVersion, requestDeploy } from "./deploys";
import { DokployError } from "./dokploy";
import { ApiError } from "./errors";
import type { DeployRecord } from "./store";
import { bearerToken } from "./tokens";

const toPublic = ({ serviceId: _s, ...deploy }: DeployRecord): Deploy => deploy;

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

export const handlers = {
  createDeploy: (ctx: AppContext, request: Request) =>
    handle(async () => {
      const body = await parseBody(request, createDeployRequestSchema);
      const deploy = requestDeploy(ctx.store, body, ctx.now());
      return Response.json(toPublic(deploy), { status: 202 });
    }),

  getDeploy: (ctx: AppContext, id: string) =>
    handle(() => {
      const deploy = ctx.store.getDeploy(id);
      if (!deploy) throw new ApiError(404, `Deploy ${id} no encontrado.`);
      return Response.json(toPublic(deploy));
    }),

  ciResult: (ctx: AppContext, request: Request) =>
    handle(async () => {
      const token = bearerToken(request.headers.get("authorization"));
      const body = await parseBody(request, ciResultRequestSchema);
      const { updated } = recordCiResult(ctx.store, body, token, ctx.now());
      return Response.json({ ok: true, updated: updated.map(toPublic) });
    }),

  listServices: (ctx: AppContext, owner: string, name: string) =>
    handle(() => {
      const scope = ctx.store.getScopeByRepo(`${owner}/${name}`);
      if (!scope) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ningún scope.`);
      const services = ctx.store.listServices(scope.id).map((s) => ({ alias: s.alias }));
      return Response.json({ repo: scope.repo, services });
    }),

  registerVersion: (ctx: AppContext, request: Request) =>
    handle(async () => {
      const body = await parseBody(request, registerVersionRequestSchema);
      return Response.json(registerVersion(ctx.store, body, ctx.now()), { status: 201 });
    }),

  listRepoVersions: (ctx: AppContext, owner: string, name: string, params: URLSearchParams) =>
    handle(() => {
      const scope = ctx.store.getScopeByRepo(`${owner}/${name}`);
      if (!scope) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ningún scope.`);

      const limitParam = params.get("limit");
      const limit = limitParam === null ? DEFAULT_LIST_LIMIT : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new ApiError(400, `limit debe ser un entero entre 1 y ${MAX_LIST_LIMIT}.`);
      }
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

  listRepoDeploys: (ctx: AppContext, owner: string, name: string, params: URLSearchParams) =>
    handle(() => {
      const scope = ctx.store.getScopeByRepo(`${owner}/${name}`);
      if (!scope) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ningún scope.`);

      const limitParam = params.get("limit");
      const limit = limitParam === null ? DEFAULT_LIST_LIMIT : Number(limitParam);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new ApiError(400, `limit debe ser un entero entre 1 y ${MAX_LIST_LIMIT}.`);
      }

      const alias = params.get("service");
      let serviceId: string | undefined;
      if (alias) {
        const service = ctx.store.getServiceByAlias(scope.id, alias);
        if (!service) {
          const available = ctx.store.listServices(scope.id).map((s) => s.alias);
          throw new ApiError(
            404,
            `El servicio ${alias} no existe en ${scope.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
          );
        }
        serviceId = service.id;
      }

      const deploys = ctx.store.listDeploys(
        { repo: scope.repo, ...(serviceId && { serviceId }) },
        { limit, newestFirst: true },
      );
      return Response.json({ repo: scope.repo, deploys: deploys.map(toPublic) });
    }),

  getRepoDeploy: (ctx: AppContext, owner: string, name: string, idPrefix: string) =>
    handle(() => {
      const scope = ctx.store.getScopeByRepo(`${owner}/${name}`);
      if (!scope) throw new ApiError(404, `El repo ${owner}/${name} no está vinculado a ningún scope.`);
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
