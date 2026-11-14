"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { IconPlus } from "../icons";
import { createFreezeAction, type FreezeFormState } from "./actions";

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

const KINDS = [
  { value: "weekly", label: "Días de la semana" },
  { value: "range", label: "Rango de fechas" },
  { value: "date", label: "Una fecha" },
] as const;
type Kind = (typeof KINDS)[number]["value"];

/** "lunes a viernes", "sábado y domingo", "lunes, miércoles y viernes". */
function describeDays(days: number[]): string {
  if (days.length === 7) return "todos los días";
  const sorted = [...days].sort();
  const consecutive = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] as number) + 1);
  const names = sorted.map((d) => DAY_NAMES[d - 1] as string);
  if (sorted.length >= 3 && consecutive) return `${names[0]} a ${names.at(-1)}`;
  if (names.length === 1) return `los ${names[0]}`;
  return `${names.slice(0, -1).join(", ")} y ${names.at(-1)}`;
}

/** One sentence of what the window will block, or a nudge to fill what's missing. */
function preview(
  kind: Kind,
  f: { days: number[]; start: string; end: string; from: string; to: string; date: string },
) {
  if (kind === "weekly") {
    if (f.days.length === 0 || !f.start || !f.end) return null;
    const allDay = f.start === f.end && f.start === "00:00";
    const crosses = !allDay && f.end <= f.start;
    return allDay
      ? `${describeDays(f.days)}, todo el día`
      : `${describeDays(f.days)} de ${f.start} a ${f.end}${crosses ? " del día siguiente" : ""}`;
  }
  if (kind === "range") {
    if (!f.from || !f.to) return null;
    return `del ${f.from.replace("T", " ")} al ${f.to.replace("T", " ")}`;
  }
  if (!f.date) return null;
  return f.start || f.end ? `el ${f.date} de ${f.start || "00:00"} a ${f.end || "24:00"}` : `el ${f.date}, todo el día`;
}

/** A new freeze window; the fields change with its kind. */
export function CreateFreezeForm({ appId, timezone }: { appId: string | null; timezone: string }) {
  const [state, action, pending] = useActionState<FreezeFormState, FormData>(createFreezeAction.bind(null, appId), {});
  const [kind, setKind] = useState<Kind>("weekly");
  const [days, setDays] = useState<number[]>([]);
  const [times, setTimes] = useState({ start: "", end: "", from: "", to: "", date: "" });
  const [tz, setTz] = useState(timezone);
  const form = useRef<HTMLFormElement>(null);
  const id = (name: string) => `freeze-${name}-${appId ?? "org"}`;

  useEffect(() => {
    if (!state.ok) return;
    form.current?.reset();
    setDays([]);
    setTimes({ start: "", end: "", from: "", to: "", date: "" });
  }, [state]);

  const toggleDay = (day: number) => setDays((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day]));
  const time = (name: keyof typeof times) => ({
    value: times[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTimes((t) => ({ ...t, [name]: e.target.value })),
  });
  const sentence = preview(kind, { days, ...times });

  return (
    <form ref={form} action={action} className="form-panel">
      <div className="form-panel-head">
        <h3 className="form-panel-title">Nueva ventana</h3>
        <p className="hint">
          Mientras esté activa, nadie despliega en {appId ? "esta app" : "ninguna app"} sin forzarla.
        </p>
      </div>

      <div className="form-grid">
        <div className="field span-6">
          <label className="label" htmlFor={id("name")}>
            Nombre
          </label>
          <input
            id={id("name")}
            className="input"
            name="name"
            required
            maxLength={100}
            placeholder="Viernes por la tarde"
          />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor={id("tz")}>
            Zona horaria
          </label>
          <input
            id={id("tz")}
            className="input"
            name="timezone"
            required
            value={tz}
            onChange={(e) => setTz(e.target.value)}
          />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor={id("scope")}>
            Scopes
          </label>
          <input id={id("scope")} className="input" name="scope" placeholder="Todos" />
          <span className="field-hint">
            Vacío = todos; <code>prod*</code> solo producción.
          </span>
        </div>

        <fieldset className="field">
          <legend className="label">Cuándo</legend>
          <div className="segmented" role="radiogroup">
            {KINDS.map((k) => (
              <label key={k.value}>
                <input
                  type="radio"
                  name="kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                />
                {k.label}
              </label>
            ))}
          </div>
        </fieldset>

        {kind === "weekly" && (
          <fieldset className="field">
            <legend className="label">Días</legend>
            <div className="pill-group">
              {DAYS.map((label, i) => (
                <label key={label} className="pill">
                  <input
                    type="checkbox"
                    name="days"
                    value={i + 1}
                    checked={days.includes(i + 1)}
                    onChange={() => toggleDay(i + 1)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="pill-actions">
              <button type="button" onClick={() => setDays([1, 2, 3, 4, 5])}>
                Laborables
              </button>
              <button type="button" onClick={() => setDays([6, 7])}>
                Fin de semana
              </button>
              <button type="button" onClick={() => setDays([1, 2, 3, 4, 5, 6, 7])}>
                Todos
              </button>
              {days.length > 0 && (
                <button type="button" onClick={() => setDays([])}>
                  Ninguno
                </button>
              )}
            </div>
          </fieldset>
        )}

        {kind === "range" && (
          <>
            <div className="field span-4">
              <label className="label" htmlFor={id("from")}>
                Desde
              </label>
              <input
                id={id("from")}
                className="input"
                name="startsAt"
                type="datetime-local"
                required
                {...time("from")}
              />
            </div>
            <div className="field span-4">
              <label className="label" htmlFor={id("to")}>
                Hasta
              </label>
              <input id={id("to")} className="input" name="endsAt" type="datetime-local" required {...time("to")} />
            </div>
          </>
        )}

        {kind === "date" && (
          <div className="field span-4">
            <label className="label" htmlFor={id("date")}>
              Fecha
            </label>
            <input id={id("date")} className="input" name="date" type="date" required {...time("date")} />
          </div>
        )}

        {kind !== "range" && (
          <>
            <div className="field span-3">
              <label className="label" htmlFor={id("start")}>
                Desde las
              </label>
              <input
                id={id("start")}
                className="input"
                name="startTime"
                type="time"
                required={kind === "weekly"}
                {...time("start")}
              />
            </div>
            <div className="field span-3">
              <label className="label" htmlFor={id("end")}>
                Hasta las
              </label>
              <input
                id={id("end")}
                className="input"
                name="endTime"
                type="time"
                required={kind === "weekly"}
                {...time("end")}
              />
            </div>
            <p className="field-hint">
              {kind === "weekly"
                ? "Si la hora de fin es anterior a la de inicio, termina al día siguiente (18:00 → 08:00). 00:00 → 00:00 es el día entero."
                : "Sin horas, la ventana dura todo el día."}
            </p>
          </>
        )}
      </div>

      <div className="form-actions">
        <p className="preview" aria-live="polite">
          {sentence ? (
            <>
              Bloqueará los deploys <strong>{sentence}</strong> ({tz || "UTC"}).
            </>
          ) : (
            "Completa cuándo aplica para ver el resumen."
          )}
        </p>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Agregando…" : "Agregar ventana"}
        </button>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
