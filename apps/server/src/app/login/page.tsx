"use client";

import { useActionState } from "react";
import { KeelMark } from "../icons";
import { type LoginState, login } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <main className="login">
      <div className="card">
        <div className="card-header">
          <div>
            <span className="brand">
              <span className="brand-mark">
                <KeelMark />
              </span>
            </span>
            <h1 className="card-title">keel admin</h1>
            <p className="card-description">Ingresa la contraseña de esta instancia.</p>
          </div>
        </div>
        <div className="card-content">
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
                autoComplete="current-password"
                // biome-ignore lint/a11y/noAutofocus: the only field on the page
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-block" disabled={pending}>
              {pending ? "Entrando…" : "Entrar"}
            </button>
          </form>
          {state.error && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
