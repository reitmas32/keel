import { randomBytes } from "node:crypto";
import { bodiesLogged, errorFields, logEnabled, logger, statusLevel } from "./log";
import { redactBody, redactHeaders, redactPath, redactQuery } from "./redact";

/** Routes that only log when they fail: probes and scrapers call them all day. */
const QUIET = new Set(["/api/health", "/api/metrics"]);

/** The id of a request: the caller's `X-Request-Id` when it sends a sane one, else a new one. */
function requestIdOf(request: Request): string {
  const given = request.headers.get("x-request-id");
  return given && /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomBytes(8).toString("hex");
}

async function bodyText(source: Request | Response): Promise<string | undefined> {
  try {
    const text = await source.clone().text();
    return text ? redactBody(text) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps a route handler so every API request leaves one `http.request.completed` line (method, path, status,
 * duration, request id), at the level its status deserves. A handler that throws leaves `http.request.failed` with
 * the error and its stack, and the caller gets a 500 with only the request id to quote. With `KEEL_LOG_BODIES=true`
 * and debug, `http.request.debug` adds the redacted headers, query and both bodies.
 *
 * The response carries `X-Request-Id`, so a CLI error can be matched with its line.
 */
export function withRequestLog<A extends unknown[]>(
  handler: (request: Request, ...rest: A) => Promise<Response> | Response,
): (request: Request, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    const started = performance.now();
    const requestId = requestIdOf(request);
    const url = new URL(request.url);
    const base = {
      requestId,
      method: request.method,
      path: redactPath(`${url.pathname}${url.search}`),
      userAgent: request.headers.get("user-agent") ?? undefined,
    };
    const requestBody = bodiesLogged() && request.method !== "GET" ? await bodyText(request) : undefined;

    let response: Response;
    try {
      response = await handler(request, ...rest);
    } catch (error) {
      logger.error("http.request.failed", {
        ...base,
        status: 500,
        durationMs: Math.round(performance.now() - started),
        ...errorFields(error, true),
      });
      response = Response.json({ error: "Error interno de keel.", requestId }, { status: 500 });
    }

    const status = response.status;
    const durationMs = Math.round(performance.now() - started);
    if (!QUIET.has(url.pathname) || status >= 500 || logEnabled("debug")) {
      // A 4xx/5xx says why in its JSON `error`; that text is ours and safe, and it is what the caller saw.
      const reason = status >= 400 ? await errorOf(response) : undefined;
      logger.log(QUIET.has(url.pathname) && status < 500 ? "debug" : statusLevel(status), "http.request.completed", {
        ...base,
        status,
        durationMs,
        ...(reason && { reason }),
      });
    }
    if (bodiesLogged()) {
      logger.debug("http.request.debug", {
        requestId,
        headers: redactHeaders(request.headers),
        query: redactQuery(url.searchParams),
        ...(requestBody && { requestBody }),
        responseBody: await bodyText(response),
      });
    }
    try {
      response.headers.set("x-request-id", requestId);
    } catch {
      // Immutable headers (a fetched Response passed through): the line still has the id.
    }
    return response;
  };
}

async function errorOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}
