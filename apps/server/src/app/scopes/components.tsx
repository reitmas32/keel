"use client";

import Link from "next/link";
import { type ReactNode, useActionState, useState } from "react";
import { addServiceAction, createScopeAction, type FormState, rotateTokenAction } from "./actions";

function TokenNotice({ token, children }: { token: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice" role="status">
      <strong>Guarda este token ahora: no se vuelve a mostrar.</strong>
      <div>
        Agrégalo como secret <code>DEPLOY_API_TOKEN</code> en el repo de GitHub.
      </div>
      <div className="row" style={{ alignItems: "center" }}>
        <code>{token}</code>
        <button
          type="button"
          className="secondary"
          onClick={() => navigator.clipboard.writeText(token).then(() => setCopied(true))}
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      {children}
    </div>
  );
}

export function CreateScopeForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createScopeAction, {});
  return (
    <>
      <form action={action} className="row">
        <label>
          Nombre
          <input name="name" placeholder="App de Konectus" />
        </label>
        <label>
          URL del repo de GitHub
          <input name="repoUrl" required placeholder="https://github.com/konectus-io/app" />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Creando…" : "Crear scope"}
        </button>
      </form>
      {state.error && <p className="error">{state.error}</p>}
      {state.token && (
        <TokenNotice token={state.token}>
          <div style={{ marginTop: 8 }}>
            <Link href={`/scopes/${state.scopeId}`}>Vincular servicios de Dokploy a {state.repo} →</Link>
          </div>
        </TokenNotice>
      )}
    </>
  );
}

export function AddServiceForm({ scopeId }: { scopeId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addServiceAction.bind(null, scopeId), {});
  return (
    <>
      <form action={action} className="row">
        <label style={{ flex: "0 1 180px" }}>
          Alias
          <input name="alias" required placeholder="api-prod" pattern="[a-z0-9][a-z0-9\-]*" />
        </label>
        <label>
          URL del servicio en Dokploy
          <input
            name="dokployUrl"
            required
            type="url"
            placeholder="https://dokploy…/dashboard/project/…/services/compose/…"
          />
        </label>
        <label style={{ flex: "0 1 180px" }}>
          Variable del tag (Compose)
          <input name="tagVariable" placeholder="DOCKER_TAG" pattern="[A-Za-z_][A-Za-z0-9_]*" />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Vinculando…" : "Vincular"}
        </button>
      </form>
      {state.error && <p className="error">{state.error}</p>}
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
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Generando…" : "Generar nuevo token de CI"}
        </button>
      </form>
      {state.error && <p className="error">{state.error}</p>}
      {state.token && <TokenNotice token={state.token} />}
    </>
  );
}

/** A submit button that asks for confirmation before a destructive form action runs. */
export function ConfirmButton({ message, children }: { message: string; children: ReactNode }) {
  return (
    <button
      type="submit"
      className="danger"
      onClick={(e) => {
        if (!confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
