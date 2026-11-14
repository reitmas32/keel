import type { Instrumentation } from "next";

export async function register() {
  // The worker uses the database drivers (node:sqlite, pg) and timers, so it only runs in the Node.js runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getContext, startWorker } = await import("./lib/context");
    // Open the database at boot so a bad config or an unreachable Postgres shows up in the logs right away.
    const { errorFields, logger } = await import("./lib/log");
    getContext().catch((error) => logger.error("no se pudo abrir la base de datos", errorFields(error)));
    startWorker();
  }
}

/**
 * Every server error Next.js catches (a page that fails to render, a route handler or a server action that throws)
 * leaves `request.failed` with where it happened and its stack. The page only shows the digest; this line has the
 * rest, under the same digest.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { errorFields, logger } = await import("./lib/log");
  const { redactPath } = await import("./lib/redact");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  logger.error("request.failed", {
    method: request.method,
    path: redactPath(request.path),
    route: context.routePath,
    routeType: context.routeType,
    ...(digest && { digest }),
    ...errorFields(error, true),
  });
};
