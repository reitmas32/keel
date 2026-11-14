import { errorFields, logger } from "./log";

/** What keel talks to. One name per line in the logs, to filter by. */
export type Dependency = "dokploy" | "accounts" | "slack" | "discord" | "webhook" | "health_check";

/**
 * A `fetch` that logs each call keel makes: `dependency.call` at debug with the status and the duration, and
 * `dependency.failed` when it answers 5xx (error), 4xx (warn) or cannot be reached (error). `describe` says what to
 * show of the URL: by default its origin and path, which for a webhook can be a secret, so those pass a masked one.
 * The query never goes in: it can carry ids or tokens.
 */
export function tracedFetch(
  dependency: Dependency,
  fetchImpl: typeof fetch = fetch,
  describe: (url: URL) => string = (url) => `${url.origin}${url.pathname}`,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fields = {
      dependency,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      target: describe(url),
    };
    const started = performance.now();
    try {
      const response = await fetchImpl(input, init);
      const durationMs = Math.round(performance.now() - started);
      if (response.status >= 400) {
        logger.log(response.status >= 500 ? "error" : "warn", "dependency.failed", {
          ...fields,
          status: response.status,
          durationMs,
        });
      } else {
        logger.debug("dependency.call", { ...fields, status: response.status, durationMs });
      }
      return response;
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      logger.error("dependency.failed", {
        ...fields,
        durationMs: Math.round(performance.now() - started),
        reason: timedOut ? "timeout" : "connection",
        ...(cause?.code && { cause: cause.code }),
        ...errorFields(error),
      });
      throw error;
    }
  }) as typeof fetch;
}
