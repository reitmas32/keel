import { FREEZE_KINDS, type FreezeKind, type Role } from "@keel/shared";
import { ApiError } from "./errors";
import { globMatch } from "./roles";

/**
 * A freeze window: while it is active keel refuses new deploys (423) and holds the queued ones, unless someone with
 * enough role forces them. Windows belong to the whole organization (`appId` null) or to one app, and can be limited
 * to some scopes with a glob. Times are wall-clock times in `timezone` (IANA, e.g. America/Mexico_City):
 *
 * - `range`: from `startsAt` to `endsAt`, both `YYYY-MM-DDTHH:mm`;
 * - `weekly`: on `days` (1 = lunes … 7 = domingo) from `startTime` to `endTime` (`HH:mm`). An end at or before the
 *   start crosses midnight into the next day (`18:00`–`08:00`; `00:00`–`00:00` is the whole day);
 * - `date`: on `startsAt` (`YYYY-MM-DD`), from `startTime` to `endTime`, the whole day when both are empty.
 */
export interface FreezeWindow {
  id: string;
  /** Null: the whole organization. */
  appId: string | null;
  name: string;
  kind: FreezeKind;
  timezone: string;
  startsAt: string | null;
  endsAt: string | null;
  days: number[];
  startTime: string | null;
  endTime: string | null;
  scopePattern: string;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

export type FreezeLevel = "org" | "app";

/** A window active right now, and until when (in its own time zone). */
export interface ActiveFreeze {
  window: FreezeWindow;
  level: FreezeLevel;
  /** `YYYY-MM-DD HH:mm` in the window's time zone. */
  until: string;
}

/** Who can deploy through an active window: admin for the organization's, maintainer for an app's. */
export const FORCE_ROLE: Record<FreezeLevel, Role> = { org: "admin", app: "maintainer" };

export const FREEZE_NAME_MAX = 100;
export const LEVEL_LABEL: Record<FreezeLevel, string> = { org: "organización", app: "app" };
export const WEEKDAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `tz` at `instant`: date, time and ISO weekday (1 = Monday). */
export function wallClock(instant: Date, tz: string): { date: string; time: string; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday as string) + 1;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

/** `YYYY-MM-DD` plus `days` (calendar arithmetic, no time zone involved). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const previousWeekday = (weekday: number) => (weekday === 1 ? 7 : weekday - 1);

/** When `window` is active at `instant`, the wall-clock moment it ends (`YYYY-MM-DD HH:mm`); else undefined. */
export function activeUntil(window: FreezeWindow, instant: Date): string | undefined {
  if (!window.enabled) return undefined;
  const now = wallClock(instant, window.timezone);
  const at = `${now.date}T${now.time}`;
  if (window.kind === "range") {
    if (!window.startsAt || !window.endsAt) return undefined;
    return window.startsAt <= at && at < window.endsAt ? window.endsAt.replace("T", " ") : undefined;
  }
  if (window.kind === "date") {
    if (window.startsAt !== now.date) return undefined;
    const start = window.startTime ?? "00:00";
    const end = window.endTime ?? "24:00";
    return start <= now.time && now.time < end
      ? end === "24:00"
        ? `${addDays(now.date, 1)} 00:00`
        : `${now.date} ${end}`
      : undefined;
  }
  const start = window.startTime ?? "00:00";
  const end = window.endTime ?? "00:00";
  if (start < end) {
    return window.days.includes(now.weekday) && start <= now.time && now.time < end ? `${now.date} ${end}` : undefined;
  }
  // Crosses midnight (or lasts a whole day): from `start` on a listed day until `end` the next day.
  if (window.days.includes(now.weekday) && now.time >= start) return `${addDays(now.date, 1)} ${end}`;
  if (window.days.includes(previousWeekday(now.weekday)) && now.time < end) return `${now.date} ${end}`;
  return undefined;
}

/**
 * The window that blocks deploys of `scope` in the app `appId` right now, if any. The organization's windows weigh
 * more: when both levels are active, the organization's is the one returned (and the one to force).
 */
export function activeFreeze(
  windows: readonly FreezeWindow[],
  target: { appId: string; scope: string },
  instant: Date,
): ActiveFreeze | undefined {
  let found: ActiveFreeze | undefined;
  for (const window of windows) {
    if (window.appId !== null && window.appId !== target.appId) continue;
    if (!globMatch(window.scopePattern, target.scope)) continue;
    const until = activeUntil(window, instant);
    if (!until) continue;
    const level: FreezeLevel = window.appId === null ? "org" : "app";
    if (level === "org") return { window, level, until };
    found ??= { window, level, until };
  }
  return found;
}

/** The 423 for a deploy into an active window. */
export function frozenError(active: ActiveFreeze, scope: string): ApiError {
  const { window, level, until } = active;
  return new ApiError(
    423,
    `${scope} está en la ventana de congelamiento «${window.name}» (${LEVEL_LABEL[level]}) hasta ${until} (${window.timezone}). ` +
      `Para desplegar igual: keel deploy --force-freeze "<motivo>" (necesita rol ${FORCE_ROLE[level]}).`,
  );
}

/** `lun–vie`, `sáb y dom`, `lun, mié y vie`, `todos los días`. */
export function describeDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "todos los días";
  const names = sorted.map((d) => WEEKDAYS[d - 1] as string);
  const consecutive = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] as number) + 1);
  if (sorted.length >= 3 && consecutive) return `${names[0]}–${names.at(-1)}`;
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}

/** One line describing when a window applies, for the admin. */
export function describeWindow(w: FreezeWindow): string {
  if (w.kind === "range") return `${w.startsAt?.replace("T", " ")} → ${w.endsAt?.replace("T", " ")}`;
  if (w.kind === "date") {
    return w.startTime || w.endTime
      ? `${w.startsAt}, ${w.startTime ?? "00:00"}–${w.endTime ?? "24:00"}`
      : `${w.startsAt}, todo el día`;
  }
  const allDay = w.startTime === w.endTime && w.startTime === "00:00";
  if (allDay) return `${describeDays(w.days)}, todo el día`;
  const crosses = (w.endTime ?? "") <= (w.startTime ?? "");
  return `${describeDays(w.days)}, ${w.startTime}–${w.endTime}${crosses ? " (+1 día)" : ""}`;
}

export type FreezeInput = {
  name: string;
  kind: string;
  timezone: string;
  startsAt?: string;
  endsAt?: string;
  days?: readonly (string | number)[];
  startTime?: string;
  endTime?: string;
  scope?: string;
};

/** Validates a window from the admin's form. Throws ApiError 400 with what is wrong. */
export function parseFreezeInput(
  input: FreezeInput,
): Omit<FreezeWindow, "id" | "appId" | "enabled" | "createdBy" | "createdAt"> {
  const name = input.name.trim();
  if (!name || name.length > FREEZE_NAME_MAX) {
    throw new ApiError(400, `Ponle un nombre a la ventana (1 a ${FREEZE_NAME_MAX} caracteres).`);
  }
  if (!FREEZE_KINDS.includes(input.kind as FreezeKind)) throw new ApiError(400, "Tipo de ventana inválido.");
  const kind = input.kind as FreezeKind;
  const timezone = input.timezone.trim() || "UTC";
  if (!isTimeZone(timezone))
    throw new ApiError(400, `Zona horaria desconocida: ${timezone}. Usa p.ej. America/Mexico_City.`);
  const scopePattern = input.scope?.trim().toLowerCase() || "*";
  if (!/^[a-z0-9*-]+$/.test(scopePattern)) throw new ApiError(400, `Patrón de scope inválido: ${scopePattern}.`);
  const time = (value: string | undefined, label: string) => {
    const v = value?.trim() || null;
    if (v && !TIME.test(v)) throw new ApiError(400, `${label} debe ser una hora HH:mm.`);
    return v;
  };
  const base = {
    name,
    kind,
    timezone,
    scopePattern,
    startsAt: null,
    endsAt: null,
    days: [],
    startTime: null,
    endTime: null,
  };

  if (kind === "range") {
    const startsAt = input.startsAt?.trim() ?? "";
    const endsAt = input.endsAt?.trim() ?? "";
    if (!DATETIME.test(startsAt) || !DATETIME.test(endsAt)) {
      throw new ApiError(400, "El inicio y el fin deben ser fecha y hora (YYYY-MM-DDTHH:mm).");
    }
    if (endsAt <= startsAt) throw new ApiError(400, "El fin debe ser posterior al inicio.");
    return { ...base, startsAt, endsAt };
  }
  if (kind === "date") {
    const date = input.startsAt?.trim() ?? "";
    if (!DATE.test(date)) throw new ApiError(400, "La fecha debe ser YYYY-MM-DD.");
    const startTime = time(input.startTime, "La hora de inicio");
    const endTime = time(input.endTime, "La hora de fin");
    if (startTime && endTime && endTime <= startTime) {
      throw new ApiError(400, "En una fecha, la hora de fin debe ser posterior a la de inicio.");
    }
    return { ...base, startsAt: date, startTime, endTime };
  }
  const days = [...new Set((input.days ?? []).map(Number))].filter((d) => d >= 1 && d <= 7).sort();
  if (days.length === 0) throw new ApiError(400, "Elige al menos un día de la semana.");
  const startTime = time(input.startTime, "La hora de inicio");
  const endTime = time(input.endTime, "La hora de fin");
  if (!startTime || !endTime) throw new ApiError(400, "Indica la hora de inicio y la de fin.");
  return { ...base, days, startTime, endTime };
}
