import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";

/**
 * At debug, a line for each admin page and server action (`http.page.request`): what was asked, by which action, and
 * how long Next.js took to start answering. The API logs its own lines with the status (see lib/request-log.ts), and
 * a page or action that fails shows up as `request.failed` (instrumentation.ts).
 */
export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (process.env.KEEL_LOG_LEVEL !== "debug") return NextResponse.next();
  const started = performance.now();
  const action = request.headers.get("next-action");
  event.waitUntil(
    (async () => {
      const { logger } = await import("./lib/log");
      const { redactPath } = await import("./lib/redact");
      logger.debug("http.page.request", {
        method: request.method,
        path: redactPath(`${request.nextUrl.pathname}${request.nextUrl.search}`),
        ...(action && { action: action.slice(0, 16) }),
        durationMs: Math.round(performance.now() - started),
      });
    })(),
  );
  return NextResponse.next();
}

export const config = {
  // Pages and actions only: the API logs itself, and static files are noise.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\.(?:png|svg|ico|css|js|woff2?)$).*)"],
};
