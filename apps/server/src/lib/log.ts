import { redactString, redactValue } from "./redact";

/**
 * Structured logs: one JSON object per line on stdout/stderr (`ts`, `level`, `msg` and the fields of the call), so a
 * log collector can index them. `KEEL_LOG_FORMAT=text` prints them for reading by eye instead.
 *
 * `KEEL_LOG_LEVEL` picks how much: `info` (default) has a line per API request and every failure; `debug` adds each
 * call keel makes (Dokploy, Accounts, Slack, webhooks, health checks), each admin page and action, and with
 * `KEEL_LOG_BODIES=true` the headers and bodies of API requests and responses.
 *
 * Every field goes through `redactValue`, like Accounts' logger: tokens, passwords, Bearer credentials, JWTs and DSN
 * passwords never reach a line, and emails are masked. Still, log identifiers, not objects.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const format = () => (process.env.KEEL_LOG_FORMAT === "text" ? "text" : "json");
const threshold = () => RANK[(process.env.KEEL_LOG_LEVEL as LogLevel) || "info"] ?? RANK.info;

/** Whether `level` would be written now; to skip building fields nobody reads. */
export const logEnabled = (level: LogLevel) => RANK[level] >= threshold();

/** Whether request and response bodies go to the log: `KEEL_LOG_BODIES=true` and the level at debug. */
export const bodiesLogged = () => process.env.KEEL_LOG_BODIES === "true" && logEnabled("debug");

/** An Error as fields (with its stack for unexpected ones); anything else as its string. */
export const errorFields = (error: unknown, withStack = false): LogFields =>
  error instanceof Error
    ? {
        error: error.message,
        errorName: error.name,
        ...(withStack &&
          error.stack && {
            stack: error.stack
              .split("\n")
              .slice(1, 16)
              .map((l) => l.trim()),
          }),
      }
    : { error: String(error) };

const pad = (n: number, size = 2) => String(n).padStart(size, "0");
const clock = (d: Date) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

export function formatLine(level: LogLevel, msg: string, fields: LogFields, now: Date, as: "json" | "text"): string {
  const safe = redactValue(fields) as LogFields;
  const text = redactString(msg);
  if (as === "text") {
    // Accounts' terminal layout: time, level, the message, then key=value; a stack goes below, one frame a line.
    const { stack, ...rest } = safe;
    const extra = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    const head = `${clock(now)} ${level.toUpperCase().padEnd(5)} keel  ${text}${extra ? ` ${extra}` : ""}`;
    return Array.isArray(stack) ? `${head}\n${stack.map((l) => `    ${l}`).join("\n")}` : head;
  }
  return JSON.stringify({ ts: now.toISOString(), level, msg: text, ...safe });
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (!logEnabled(level)) return;
  const line = formatLine(level, msg, fields, new Date(), format());
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
  log: (level: LogLevel, msg: string, fields?: LogFields) => write(level, msg, fields),
};

/**
 * The level of a request line by its status, as in Accounts: expected client errors are not incidents, rejected
 * credentials and throttling deserve a look, and every 5xx is an error.
 */
export function statusLevel(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status === 401 || status === 403 || status === 429) return "warn";
  if (status < 400 || [400, 404, 409, 422, 423].includes(status)) return "info";
  return "warn";
}

/**
 * An admin form that refused what was sent (a 400 from validation, a 403 for a role that can't): the page shows the
 * message, and this leaves `action.rejected` so the refusal is visible in the log too.
 */
export function rejectedAction(action: string, error: { message: string; status?: number }): { error: string } {
  const status = error.status ?? 400;
  logger.log(statusLevel(status), "action.rejected", { action, status, reason: error.message });
  return { error: error.message };
}
