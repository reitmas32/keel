"use client";

import { useActionState } from "react";
import { type LoginState, login } from "./actions";

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <main className="login">
      <div className="card">
        <h1>keel admin</h1>
        <p className="muted">Ingresa la contraseña de esta instancia.</p>
        <form action={action} className="row">
          <label>
            Contraseña
            <input type="password" name="password" required autoComplete="current-password" />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Entrando…" : "Entrar"}
          </button>
        </form>
        {state.error && <p className="error">{state.error}</p>}
      </div>
    </main>
  );
}
