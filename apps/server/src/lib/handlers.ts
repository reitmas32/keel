import { ciResultRequestSchema, createDeployRequestSchema, type Deploy } from "@keel/shared";
import type { z } from "zod";
import type { AppContext } from "./context";
import { recordCiResult, requestDeploy } from "./deploys";
import { DokployError } from "./dokploy";
import { ApiError } from "./errors";
import type { DeployRecord } from "./store";
import { bearerToken } from "./tokens";

const toPublic = ({ serviceId: _s, deployStartedAt: _d, ...deploy }: DeployRecord): Deploy => deploy;

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
};
