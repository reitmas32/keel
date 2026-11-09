"use client";

import { LOCK_REASON_MAX } from "@keel/shared";
import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { IconLock, IconPlus, IconRefresh } from "../icons";
import { TokenNotice } from "../ui-client";
import { addServiceAction, createScopeAction, type FormState, lockServiceAction, rotateTokenAction } from "./actions";

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

export function CreateScopeForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createScopeAction, {});
  return (
    <>
      <form action={action} className="form-stack">
        <div className="field">
          <label className="label" htmlFor="scope-name">
            Nombre
          </label>
          <input id="scope-name" className="input" name="name" placeholder="App de Konectus" />
        </div>
        <div className="field">
          <label className="label" htmlFor="scope-repo">
            URL del repo de GitHub
          </label>
          <input
            id="scope-repo"
            className="input"
            name="repoUrl"
            required
            placeholder="https://github.com/konectus-io/app"
          />
        </div>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Creando…" : "Crear scope"}
        </button>
      </form>
      <FormError error={state.error} />
      {state.token && (
        <TokenNotice token={state.token} hint={SECRET_HINT}>
          <Link className="link" href={`/scopes/${state.scopeId}`}>
            Vincular servicios de Dokploy a {state.repo} →
          </Link>
        </TokenNotice>
      )}
    </>
  );
}

export function AddServiceForm({ scopeId }: { scopeId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addServiceAction.bind(null, scopeId), {});
  return (
    <>
      <form action={action} className="form-row">
        <div className="field narrow">
          <label className="label" htmlFor="svc-alias">
            Alias
          </label>
          <input
            id="svc-alias"
            className="input"
            name="alias"
            required
            placeholder="api-prod"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="svc-url">
            URL del servicio en Dokploy
          </label>
          <input
            id="svc-url"
            className="input"
            name="dokployUrl"
            required
            type="url"
            placeholder="https://dokploy…/dashboard/project/…/services/compose/…"
          />
        </div>
        <div className="field narrow">
          <label className="label" htmlFor="svc-tag">
            Variable del tag (Compose)
          </label>
          <input
            id="svc-tag"
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

export function RotateTokenForm({ scopeId }: { scopeId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(rotateTokenAction.bind(null, scopeId), {});
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

/** "Bloquear" opens a dialog that asks for the reason; new deploys of the service then get a 423. */
export function LockServiceButton({
  scopeId,
  serviceId,
  alias,
}: {
  scopeId: string;
  serviceId: string;
  alias: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(
    lockServiceAction.bind(null, scopeId, serviceId),
    {},
  );
  useEffect(() => {
    if (state.ok) dialog.current?.close();
  }, [state]);

  return (
    <>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => dialog.current?.showModal()}>
        <IconLock />
        Bloquear
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby={`lock-${serviceId}`}>
        <form action={action}>
          <div className="dialog-header">
            <h2 className="dialog-title" id={`lock-${serviceId}`}>
              Bloquear {alias}
            </h2>
            <p className="muted">
              Mientras esté bloqueado, keel rechaza los deploys nuevos de este servicio. Los que ya están en curso
              terminan normalmente.
            </p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`reason-${serviceId}`}>
              Motivo
            </label>
            <textarea
              id={`reason-${serviceId}`}
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
              {pending ? "Bloqueando…" : "Bloquear servicio"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
