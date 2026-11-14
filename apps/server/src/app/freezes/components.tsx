"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FreezeWindow } from "@/lib/freeze";
import { IconPencil, IconPlus, IconTrash } from "../icons";
import { ConfirmButton, useBackdropClose } from "../ui-client";
import { deleteFreezeAction, type FreezeFormState, saveFreezeAction } from "./actions";

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

const KINDS = [
  { value: "weekly", label: "Cada semana" },
  { value: "range", label: "Rango de fechas" },
  { value: "date", label: "Un día" },
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

/** One sentence of what the window will block, or null while something is missing. */
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

const timesOf = (w?: FreezeWindow) => ({
  start: w?.startTime ?? "",
  end: w?.endTime ?? "",
  from: w?.kind === "range" ? (w.startsAt ?? "") : "",
  to: w?.kind === "range" ? (w.endsAt ?? "") : "",
  date: w?.kind === "date" ? (w.startsAt ?? "") : "",
});

/**
 * A side panel that creates a window for the organization (`appId` null) or an app, or, given `window`, edits it.
 * Same modal `<dialog>` drawer as the notification channels.
 */
export function FreezeDrawer({
  appId,
  timezone,
  window,
}: {
  appId: string | null;
  timezone: string;
  window?: FreezeWindow;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useBackdropClose(dialog);
  const form = useRef<HTMLFormElement>(null);
  const uid = useId();
  const [state, action, pending] = useActionState<FreezeFormState, FormData>(saveFreezeAction.bind(null, appId), {});
  const [kind, setKind] = useState<Kind>(window?.kind ?? "weekly");
  const [days, setDays] = useState<number[]>(window?.days ?? []);
  const [times, setTimes] = useState(timesOf(window));
  const [tz, setTz] = useState(window?.timezone ?? timezone);
  const id = (name: string) => `${uid}-${name}`;

  useEffect(() => {
    if (!state.ok) return;
    dialog.current?.close();
    if (!window) {
      form.current?.reset();
      setKind("weekly");
      setDays([]);
      setTimes(timesOf());
      setTz(timezone);
    }
  }, [state, window, timezone]);

  const toggleDay = (day: number) => setDays((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day]));
  const time = (name: keyof typeof times) => ({
    value: times[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTimes((t) => ({ ...t, [name]: e.target.value })),
  });
  const sentence = preview(kind, { days, ...times });
  const where = appId ? "esta app" : "ninguna app";

  return (
    <>
      {window ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => dialog.current?.showModal()}>
          <IconPencil />
          Editar
        </button>
      ) : (
        <button type="button" className="btn" onClick={() => dialog.current?.showModal()}>
          <IconPlus />
          Nueva ventana
        </button>
      )}
      <dialog ref={dialog} className="dialog drawer" aria-labelledby={id("title")}>
        <form ref={form} action={action} className="drawer-form">
          <div className="drawer-head">
            <div>
              <h2 className="dialog-title" id={id("title")}>
                {window ? `Editar ${window.name}` : "Nueva ventana"}
              </h2>
              <p className="hint">Mientras esté activa, nadie despliega en {where} sin forzarla.</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm drawer-close"
              aria-label="Cerrar"
              onClick={() => dialog.current?.close()}
            >
              ✕
            </button>
          </div>

          <div className="drawer-body">
            {window && <input type="hidden" name="freezeId" value={window.id} />}
            <div className="field">
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
                defaultValue={window?.name}
              />
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
              <div className="drawer-pair">
                <div className="field">
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
                <div className="field">
                  <label className="label" htmlFor={id("to")}>
                    Hasta
                  </label>
                  <input id={id("to")} className="input" name="endsAt" type="datetime-local" required {...time("to")} />
                </div>
              </div>
            )}

            {kind === "date" && (
              <div className="field">
                <label className="label" htmlFor={id("date")}>
                  Fecha
                </label>
                <input id={id("date")} className="input" name="date" type="date" required {...time("date")} />
              </div>
            )}

            {kind !== "range" && (
              <div className="field">
                <div className="drawer-pair">
                  <div className="field">
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
                  <div className="field">
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
                </div>
                <p className="field-hint">
                  {kind === "weekly"
                    ? "Si la hora de fin es anterior a la de inicio, termina al día siguiente (18:00 → 08:00). 00:00 → 00:00 es el día entero."
                    : "Sin horas, la ventana dura todo el día."}
                </p>
              </div>
            )}

            <div className="field">
              <div className="drawer-pair">
                <div className="field">
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
                <div className="field">
                  <label className="label" htmlFor={id("scope")}>
                    Scopes
                  </label>
                  <input
                    id={id("scope")}
                    className="input"
                    name="scope"
                    placeholder="Todos"
                    defaultValue={window && window.scopePattern !== "*" ? window.scopePattern : undefined}
                  />
                </div>
              </div>
              <p className="field-hint">
                Scopes vacío = todos; <code>prod*</code> solo producción.
              </p>
            </div>

            <p className="preview freeze-preview" aria-live="polite">
              {sentence ? (
                <span>
                  Bloqueará los deploys <strong>{sentence}</strong> ({tz || "UTC"}).
                </span>
              ) : (
                "Completa cuándo aplica para ver el resumen."
              )}
            </p>
            {state.error && (
              <p className="error" role="alert">
                {state.error}
              </p>
            )}
          </div>

          <div className="drawer-foot">
            <button type="button" className="btn btn-outline" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            <button type="submit" className="btn" disabled={pending}>
              {pending ? "Guardando…" : window ? "Guardar" : "Agregar ventana"}
            </button>
          </div>
        </form>
        {window && (
          <form action={deleteFreezeAction} className="drawer-danger">
            <input type="hidden" name="freezeId" value={window.id} />
            <input type="hidden" name="appId" value={window.appId ?? ""} />
            <span className="small muted">Los deploys retenidos salen en cuanto se elimine.</span>
            <ConfirmButton message={`¿Eliminar la ventana ${window.name}?`}>
              <IconTrash />
              Eliminar ventana
            </ConfirmButton>
          </form>
        )}
      </dialog>
    </>
  );
}
