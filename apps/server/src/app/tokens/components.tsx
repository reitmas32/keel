"use client";

import { useActionState } from "react";
import { IconPlus } from "../icons";
import { TokenNotice } from "../ui-client";
import { createApiTokenAction, type TokenFormState } from "./actions";

export function CreateApiTokenForm({ maxLength }: { maxLength: number }) {
  const [state, action, pending] = useActionState<TokenFormState, FormData>(createApiTokenAction, {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field">
          <label className="label" htmlFor="token-name">
            Nombre
          </label>
          <input
            id="token-name"
            className="input"
            name="name"
            required
            maxLength={maxLength}
            placeholder="rafa-laptop"
            autoComplete="off"
          />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Creando…" : "Crear token"}
        </button>
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.token && (
        <TokenNotice
          token={state.token}
          hint={
            <>
              Token <strong>{state.name}</strong>. En tu máquina ejecuta <code>keel login --token &lt;token&gt;</code>.
            </>
          }
        />
      )}
    </>
  );
}
