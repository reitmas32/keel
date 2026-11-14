/**
 * Structured logs: one JSON object per line on stdout/stderr (`ts`, `level`, `msg` and the fields of the call), so a
 * log collector can index them. `KEEL_LOG_FORMAT=text` keeps the older `[keel] mensaje` lines for reading by eye.
 * Never pass secrets as fields.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const format = () => (process.env.KEEL_LOG_FORMAT === "text" ? "text" : "json");
const threshold = () => RANK[(process.env.KEEL_LOG_LEVEL as LogLevel) || "info"] ?? RANK.info;

/** An Error as fields; anything else as its string. */
export const errorFields = (error: unknown): LogFields =>
  error instanceof Error ? { error: error.message, errorName: error.name } : { error: String(error) };

export function formatLine(level: LogLevel, msg: string, fields: LogFields, now: Date, as: "json" | "text"): string {
  if (as === "text") {
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    return `[keel] ${msg}${extra ? ` ${extra}` : ""}`;
  }
  return JSON.stringify({ ts: now.toISOString(), level, msg, ...fields });
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (RANK[level] < threshold()) return;
  const line = formatLine(level, msg, fields, new Date(), format());
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
};
