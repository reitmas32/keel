"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { IconPlus } from "../icons";
import { createFreezeAction, type FreezeFormState } from "./actions";

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

/** A new freeze window; the fields change with its kind. */
export function CreateFreezeForm({ appId, timezone }: { appId: string | null; timezone: string }) {
  const [state, action, pending] = useActionState<FreezeFormState, FormData>(createFreezeAction.bind(null, appId), {});
  const [kind, setKind] = useState("weekly");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <>
      <form ref={form} action={action} className="form-stack">
        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor={`freeze-name-${appId}`}>
              Nombre
            </label>
            <input
              id={`freeze-name-${appId}`}
              className="input"
              name="name"
              required
              maxLength={100}
              placeholder="Viernes por la tarde"
            />
          </div>
          <div className="field narrow">
            <label className="label" htmlFor={`freeze-kind-${appId}`}>
              Tipo
            </label>
            <select
              id={`freeze-kind-${appId}`}
              className="input"
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="weekly">Días de la semana</option>
              <option value="range">Rango de fechas</option>
              <option value="date">Una fecha</option>
            </select>
          </div>
          <div className="field narrow">
            <label className="label" htmlFor={`freeze-tz-${appId}`}>
              Zona horaria
            </label>
            <input id={`freeze-tz-${appId}`} className="input" name="timezone" defaultValue={timezone} required />
          </div>
          <div className="field narrow">
            <label className="label" htmlFor={`freeze-scope-${appId}`}>
              Scopes
            </label>
            <input id={`freeze-scope-${appId}`} className="input" name="scope" placeholder="* (todos), prod*" />
          </div>
        </div>
        {kind === "range" && (
          <div className="form-row">
            <div className="field narrow">
              <label className="label" htmlFor={`freeze-from-${appId}`}>
                Desde
              </label>
              <input id={`freeze-from-${appId}`} className="input" name="startsAt" type="datetime-local" required />
            </div>
            <div className="field narrow">
              <label className="label" htmlFor={`freeze-to-${appId}`}>
                Hasta
              </label>
              <input id={`freeze-to-${appId}`} className="input" name="endsAt" type="datetime-local" required />
            </div>
          </div>
        )}
        {kind === "weekly" && (
          <fieldset className="field">
            <legend className="label">Días</legend>
            <div className="check-grid">
              {DAYS.map((label, i) => (
                <label key={label} className="check">
                  <input type="checkbox" name="days" value={i + 1} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {kind === "date" && (
          <div className="field narrow">
            <label className="label" htmlFor={`freeze-date-${appId}`}>
              Fecha
            </label>
            <input id={`freeze-date-${appId}`} className="input" name="date" type="date" required />
          </div>
        )}
        {kind !== "range" && (
          <div className="form-row">
            <div className="field narrow">
              <label className="label" htmlFor={`freeze-start-${appId}`}>
                Desde las
              </label>
              <input
                id={`freeze-start-${appId}`}
                className="input"
                name="startTime"
                type="time"
                required={kind === "weekly"}
              />
            </div>
            <div className="field narrow">
              <label className="label" htmlFor={`freeze-end-${appId}`}>
                Hasta las
              </label>
              <input
                id={`freeze-end-${appId}`}
                className="input"
                name="endTime"
                type="time"
                required={kind === "weekly"}
              />
            </div>
            <p className="hint">
              {kind === "weekly"
                ? "Si la hora de fin es anterior a la de inicio, termina al día siguiente (18:00 → 08:00). 00:00 → 00:00 es el día entero."
                : "Vacías: todo el día."}
            </p>
          </div>
        )}
        <div>
          <button type="submit" className="btn" disabled={pending}>
            <IconPlus />
            {pending ? "Agregando…" : "Agregar ventana"}
          </button>
        </div>
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}
