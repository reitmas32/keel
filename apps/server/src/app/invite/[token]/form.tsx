"use client";

import { useActionState } from "react";
import { acceptInviteAction, type InviteState } from "./actions";

export function AcceptInviteForm({ token, minLength }: { token: string; minLength: number }) {
  const [state, action, pending] = useActionState<InviteState, FormData>(acceptInviteAction.bind(null, token), {});
  return (
    <>
      <form action={action} className="form-stack">
        <div className="field">
          <label className="label" htmlFor="password">
            Contraseña
          </label>
          <input
            id="password"
            className="input"
            type="password"
            name="password"
            required
            minLength={minLength}
            autoComplete="new-password"
            // biome-ignore lint/a11y/noAutofocus: the first field of the only form on the page
            autoFocus
          />
          <p className="hint">Mínimo {minLength} caracteres.</p>
        </div>
        <div className="field">
          <label className="label" htmlFor="confirm">
            Confirma la contraseña
          </label>
          <input
            id="confirm"
            className="input"
            type="password"
            name="confirm"
            required
            minLength={minLength}
            autoComplete="new-password"
          />
        </div>
        <button type="submit" className="btn btn-block" disabled={pending}>
          {pending ? "Guardando…" : "Guardar y entrar"}
        </button>
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}
