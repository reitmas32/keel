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
            <p className="card-description">Entra con tu email y contraseña de keel.</p>
          </div>
        </div>
        <div className="card-content">
          <form action={action} className="form-stack">
            <div className="field">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                name="email"
                autoComplete="username"
                defaultValue={state.email}
                placeholder="tu@empresa.com"
                // biome-ignore lint/a11y/noAutofocus: the first field of the only form on the page
                autoFocus
              />
            </div>
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
          <p className="hint login-hint">
            Acceso de emergencia: deja el email vacío y usa <code>KEEL_ADMIN_PASSWORD</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
