"use client";

import { useActionState, useState } from "react";
import { type CodeState, type LoginState, login, loginWithCode } from "./actions";

function PasswordForm({ accounts }: { accounts: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <>
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
            Contraseña{accounts ? " (de Accounts o de keel)" : ""}
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
    </>
  );
}

function CodeForm() {
  const [state, action, pending] = useActionState<CodeState, FormData>(loginWithCode, {});
  return (
    <>
      <form action={action} className="form-stack">
        {!state.challengeId ? (
          <div className="field">
            <label className="label" htmlFor="code-email">
              Email
            </label>
            <input
              id="code-email"
              className="input"
              type="email"
              name="email"
              required
              autoComplete="username"
              defaultValue={state.email}
              placeholder="tu@empresa.com"
            />
          </div>
        ) : (
          <div className="field">
            <label className="label" htmlFor="code">
              Código
            </label>
            <input
              id="code"
              className="input"
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
            />
            <p className="hint">Si {state.email} es miembro de keel, te llegó un código por correo.</p>
          </div>
        )}
        <button type="submit" className="btn btn-block" disabled={pending}>
          {pending ? "Un momento…" : state.challengeId ? "Entrar" : "Enviarme un código"}
        </button>
        {state.challengeId && (
          <button type="submit" name="restart" value="1" className="btn btn-ghost btn-block" disabled={pending}>
            Usar otro email
          </button>
        )}
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}

/** Password login always; with Accounts, also a code by email. */
export function LoginForm({ accounts }: { accounts: boolean }) {
  const [mode, setMode] = useState<"password" | "code">("password");
  return (
    <>
      {accounts && (
        <nav className="filter-chips" aria-label="Cómo entrar">
          <button
            type="button"
            className="chip"
            aria-current={mode === "password" ? "page" : undefined}
            onClick={() => setMode("password")}
          >
            Contraseña
          </button>
          <button
            type="button"
            className="chip"
            aria-current={mode === "code" ? "page" : undefined}
            onClick={() => setMode("code")}
          >
            Código por correo
          </button>
        </nav>
      )}
      {mode === "code" && accounts ? <CodeForm /> : <PasswordForm accounts={accounts} />}
    </>
  );
}
