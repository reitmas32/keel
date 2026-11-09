"use client";

import { LOCK_REASON_MAX } from "@keel/shared";
import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { IconLock, IconPlus, IconRefresh } from "../icons";
import { TokenNotice } from "../ui-client";
import { addScopeAction, createAppAction, type FormState, lockScopeAction, rotateTokenAction } from "./actions";

const SECRET_HINT = (
  <>
    Agrégalo como secret <code>DEPLOY_API_TOKEN</code> en el repo de GitHub.
  </>
);

function FormError({ error }: { error: string | undefined }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function CreateAppForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createAppAction, {});
  return (
    <>
      <form action={action} className="form-stack">
        <div className="field">
          <label className="label" htmlFor="app-name">
            Nombre
          </label>
          <input id="app-name" className="input" name="name" placeholder="App de Konectus" />
        </div>
        <div className="field">
          <label className="label" htmlFor="app-repo">
            URL del repo de GitHub
          </label>
          <input
            id="app-repo"
            className="input"
            name="repoUrl"
            required
            placeholder="https://github.com/konectus-io/app"
          />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Creando…" : "Crear app"}
        </button>
      </form>
      <FormError error={state.error} />
      {state.token && (
        <TokenNotice token={state.token} hint={SECRET_HINT}>
          <Link className="link" href={`/apps/${state.appId}`}>
            Agregar los scopes de {state.repo} →
          </Link>
        </TokenNotice>
      )}
    </>
  );
}

export function AddScopeForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addScopeAction.bind(null, appId), {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field narrow">
          <label className="label" htmlFor="scope-alias">
            Scope
          </label>
          <input
            id="scope-alias"
            className="input"
            name="alias"
            required
            placeholder="prod"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="scope-url">
            URL del servicio en Dokploy
          </label>
          <input
            id="scope-url"
            className="input"
            name="dokployUrl"
            required
            type="url"
            placeholder="https://dokploy…/dashboard/project/…/services/compose/…"
          />
        </div>
        <div className="field narrow">
          <label className="label" htmlFor="scope-tag">
            Variable del tag (Compose)
          </label>
          <input
            id="scope-tag"
            className="input"
            name="tagVariable"
            placeholder="DOCKER_TAG"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
          />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Vinculando…" : "Vincular"}
        </button>
      </form>
      <FormError error={state.error} />
    </>
  );
}

export function RotateTokenForm({ appId }: { appId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(rotateTokenAction.bind(null, appId), {});
  return (
    <>
      <form
        action={action}
        onSubmit={(e) => {
          if (!confirm("El token actual dejará de funcionar. ¿Generar uno nuevo?")) e.preventDefault();
        }}
      >
        <button type="submit" className="btn btn-outline" disabled={pending}>
          <IconRefresh />
          {pending ? "Generando…" : "Generar nuevo token de CI"}
        </button>
      </form>
      <FormError error={state.error} />
      {state.token && <TokenNotice token={state.token} hint={SECRET_HINT} />}
    </>
  );
}

/** "Bloquear" opens a dialog that asks for the reason; new deploys of the scope then get a 423. */
export function LockScopeButton({ appId, scopeId, alias }: { appId: string; scopeId: string; alias: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(lockScopeAction.bind(null, appId, scopeId), {});
  useEffect(() => {
    if (state.ok) dialog.current?.close();
  }, [state]);

  return (
    <>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => dialog.current?.showModal()}>
        <IconLock />
        Bloquear
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={`lock-${scopeId}`}>
        <form action={action}>
          <div className="dialog-header">
            <h2 className="dialog-title" id={`lock-${scopeId}`}>
              Bloquear {alias}
            </h2>
            <p className="muted">
              Mientras esté bloqueado, keel rechaza los deploys nuevos de este scope. Los que ya están en curso terminan
              normalmente.
            </p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`reason-${scopeId}`}>
              Motivo
            </label>
            <textarea
              id={`reason-${scopeId}`}
              className="input"
              name="reason"
              required
              maxLength={LOCK_REASON_MAX}
              placeholder="Migración de base de datos en curso"
            />
          </div>
          <FormError error={state.error} />
          <div className="dialog-footer">
            <button type="button" className="btn btn-outline" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-destructive" disabled={pending}>
              <IconLock />
              {pending ? "Bloqueando…" : "Bloquear scope"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
