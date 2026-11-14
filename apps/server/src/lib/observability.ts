import { DEPLOY_STATUSES } from "@keel/shared";
import type { AppContext } from "./context";
import { errorFields, logger } from "./log";
import { metrics } from "./metrics";
import { bearerToken, hashToken, verifyToken } from "./tokens";

/**
 * `GET /api/health`: 200 `{ ok: true, db: "ok" }` when the database answers, 503 otherwise. Never says why it failed
 * (the log does): the route is public.
 */
export async function healthResponse(getCtx: () => Promise<AppContext>): Promise<Response> {
  try {
    const ctx = await getCtx();
    await ctx.store.ping();
    return Response.json({ ok: true, db: "ok" });
  } catch (error) {
    logger.error("health: la base de datos no responde", errorFields(error));
    return Response.json({ ok: false, db: "error" }, { status: 503 });
  }
}

/**
 * `GET /api/metrics` in Prometheus' text format. Off (404) until KEEL_METRICS_TOKEN is set; then it needs
 * `Authorization: Bearer <KEEL_METRICS_TOKEN>`, so the counts never leak through a public domain.
 */
export async function metricsResponse(ctx: AppContext, request: Request): Promise<Response> {
  const expected = ctx.env.KEEL_METRICS_TOKEN;
  if (!expected)
    return Response.json({ error: "Las métricas están desactivadas: define KEEL_METRICS_TOKEN." }, { status: 404 });
  const token = bearerToken(request.headers.get("authorization"));
  if (!token || !verifyToken(token, hashToken(expected))) {
    return Response.json({ error: "Token de métricas inválido." }, { status: 401 });
  }
  const byStatus = await ctx.store.countDeploysByStatus();
  const extra = [
    "# HELP keel_deploys Deploys en la base, por estado.",
    "# TYPE keel_deploys gauge",
    ...DEPLOY_STATUSES.map((status) => `keel_deploys{status="${status}"} ${byStatus[status] ?? 0}`),
    "# HELP keel_deploys_awaiting_approval Deploys que esperan aprobación.",
    "# TYPE keel_deploys_awaiting_approval gauge",
    `keel_deploys_awaiting_approval ${await ctx.store.countPendingApprovals()}`,
  ];
  return new Response(metrics.render(extra), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}
