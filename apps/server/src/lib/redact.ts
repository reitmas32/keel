/**
 * What never reaches a log line, modeled on Foundathyon Accounts' redaction (docs/observability/logging.md §5):
 * secret keys are replaced by `[REDACTED]`, emails are masked (`r***@example.com`) so a line stays traceable, and free
 * text loses Bearer credentials, JWTs, Slack tokens and the password of a DSN. The logger runs every field through
 * here, so a call site that forgets is still safe.
 */

export const REDACTED = "[REDACTED]";

/** Keys whose value is a secret, matched as a substring of the key lowercased without `-` and `_`. */
const SECRET_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "otp",
  "verificationcode",
  "credential",
  "dsn",
  "signature",
  "session",
];
/** Keys too short or too common to match as a substring; these match whole. */
const SECRET_EXACT = new Set(["code", "pin", "nonce", "sig", "key"]);
/** Identifiers of a row, never secrets: `tokenId`, `channelId`, `sessionId`… */
const ID_SUFFIX = /(?:^|[a-z])id$/;
/** Keys whose value is an email (or a list of them). */
const EMAIL_KEYS = new Set(["email", "useremail", "to", "from", "recipient"]);

const normalize = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

export function isSecretKey(key: string): boolean {
  const k = normalize(key);
  if (k === "id" || (ID_SUFFIX.test(k) && !k.endsWith("secretid") && !k.endsWith("passwordid"))) return false;
  if (k === "tokenname" || k === "tokens") return false;
  return SECRET_EXACT.has(k) || SECRET_KEYS.some((s) => k.includes(s));
}

/** `rafael@example.com` → `r***@example.com`. */
export function maskEmail(value: string): string {
  return value.replace(/([^\s@"'<>(),;:]{1})[^\s@"'<>(),;:]*@([^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+)/g, "$1***@$2");
}

/** Free text without credentials: Bearer/Basic, JWTs, Slack tokens, DSN passwords, `secret=…` pairs, emails. */
export function redactString(value: string): string {
  return maskEmail(
    value
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
      .replace(/\bxox[abposr]-[A-Za-z0-9-]+/g, REDACTED)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, `$1:${REDACTED}@`)
      .replace(
        /(["']?)([A-Za-z_-]*(?:password|secret|token|apikey|api_key|authorization|code|otp)[A-Za-z_-]*)\1(\s*[:=]\s*)(["']?)[^"'\s,&}]+\4/gi,
        (match, q, key: string, sep: string, vq: string) =>
          isSecretKey(key) ? `${q}${key}${q}${sep}${vq}${REDACTED}${vq}` : match,
      ),
  );
}

/** Any value made safe for a log: walks objects and arrays (4 levels, 64 items) and redacts by key and by content. */
export function redactValue(value: unknown, key = "", depth = 0): unknown {
  if (key && isSecretKey(key)) return value === null || value === undefined || value === "" ? value : REDACTED;
  if (typeof value === "string") {
    const clean = redactString(value);
    return key && EMAIL_KEYS.has(normalize(key)) ? maskEmail(clean) : clean;
  }
  if (value instanceof Error) return redactString(value.message);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return redactString(JSON.stringify(value) ?? "");
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => redactValue(v, key, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 64)) out[k] = redactValue(v, k, depth + 1);
  return out;
}

/** Headers safe to show whole; every other one (Authorization, Cookie, X-API-Key…) shows as `[REDACTED]`. */
const SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "user-agent",
  "referer",
  "origin",
  "host",
  "x-request-id",
  "traceparent",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-real-ip",
  "next-action",
  "next-router-state-tree",
]);

export function redactHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): Record<string, string> {
  const entries: [string, string][] =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers).map(([k, v]): [string, string] => [k, String(v)]);
  return Object.fromEntries(entries.map(([k, v]) => [k, SAFE_HEADERS.has(k.toLowerCase()) ? v : REDACTED]));
}

/** Query parameters known to be harmless keep their value; any other keeps its name with `[REDACTED]`. */
const SAFE_QUERY = new Set([
  "scope",
  "repo",
  "tag",
  "status",
  "limit",
  "page",
  "app",
  "action",
  "actor",
  "tab",
  "since",
]);

export function redactQuery(search: URLSearchParams): Record<string, string> {
  return Object.fromEntries([...search.entries()].map(([k, v]) => [k, SAFE_QUERY.has(k) ? redactString(v) : REDACTED]));
}

/** A path with its query reduced to safe values, e.g. `/api/versions?repo=a/b&token=[REDACTED]`. */
export function redactPath(path: string): string {
  const [pathname, query] = path.split("?", 2) as [string, string | undefined];
  if (!query) return pathname;
  const safe = new URLSearchParams(redactQuery(new URLSearchParams(query))).toString();
  return `${pathname}?${decodeURIComponent(safe)}`;
}

/** A body for a debug line: at most 2 KB, as redacted text (JSON bodies are redacted by key first). */
export function redactBody(text: string, limit = 2048): string {
  let out = text;
  try {
    out = JSON.stringify(redactValue(JSON.parse(text)));
  } catch {
    out = redactString(text);
  }
  return out.length > limit ? `${out.slice(0, limit)}… (${out.length - limit} más)` : out;
}
