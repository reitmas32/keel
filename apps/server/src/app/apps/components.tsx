"use client";

import { HEALTH_CHECK_LIMITS, type HealthCheck, LOCK_REASON_MAX } from "@keel/shared";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { IconLock, IconPlus, IconRefresh } from "../icons";
import { ConfirmButton, TokenNotice } from "../ui-client";
import {
  addScopeAction,
  createAppAction,
  decideDeployAction,
  type FormState,
  lockScopeAction,
  rotateTokenAction,
  setAppApprovalAction,
  updateScopeAction,
} from "./actions";

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
      <form action={action}>
        <ConfirmButton
          variant="outline"
          size="md"
          disabled={pending}
          title="¿Generar un nuevo token de CI?"
          message="El token actual dejará de funcionar en cuanto se genere el nuevo. Actualiza el secret del repo después."
          confirmLabel="Generar token"
        >
          <IconRefresh />
          {pending ? "Generando…" : "Generar nuevo token de CI"}
        </ConfirmButton>
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

/** A scope's health check, automatic rollback and approval. All start off. */
export function ScopeSettingsForm({
  appId,
  scopeId,
  healthCheck,
  autoRollback,
  requireApproval,
  appRequiresApproval,
}: {
  appId: string;
  scopeId: string;
  healthCheck: HealthCheck | null;
  autoRollback: boolean;
  requireApproval: boolean | null;
  appRequiresApproval: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    updateScopeAction.bind(null, appId, scopeId),
    {},
  );
  const [healthOn, setHealthOn] = useState(healthCheck?.enabled ?? false);
  const limits = HEALTH_CHECK_LIMITS;
  const approval = requireApproval === null ? "" : requireApproval ? "1" : "0";
  return (
    <form action={action} className="form-panel">
      <label className="option-row">
        <input
          type="checkbox"
          name="healthEnabled"
          checked={healthOn}
          onChange={(e) => setHealthOn(e.target.checked)}
        />
        <span>
          <span className="option-title">Health check</span>
          <span className="option-description" style={{ display: "block" }}>
            Cuando Dokploy termina, keel llama a una URL del servicio. Si no responde bien tras los intentos, el deploy
            queda <code>deploy_failed</code>.
          </span>
        </span>
      </label>

      {/* Hidden, not removed: a saved URL survives turning the check off. */}
      <div className="form-grid" hidden={!healthOn} style={{ paddingLeft: "1.75rem" }}>
        <div className="field">
          <label className="label" htmlFor="health-url">
            URL
          </label>
          <input
            id="health-url"
            className="input"
            name="healthUrl"
            type="url"
            defaultValue={healthCheck?.url ?? ""}
            placeholder="https://api.example.com/healthz"
          />
          <span className="field-hint">Puede no ser /health: la ruta que tenga el servicio.</span>
        </div>
        <div className="field span-3">
          <label className="label" htmlFor="health-status">
            Código esperado
          </label>
          <input
            id="health-status"
            className="input"
            name="healthStatus"
            type="number"
            min={100}
            max={599}
            defaultValue={healthCheck?.expectedStatus ?? ""}
            placeholder="Cualquier 2xx"
          />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor="health-retries">
            Intentos
          </label>
          <input
            id="health-retries"
            className="input"
            name="healthRetries"
            type="number"
            min={limits.retries.min}
            max={limits.retries.max}
            defaultValue={healthCheck?.retries ?? limits.retries.default}
          />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor="health-interval">
            Segundos entre intentos
          </label>
          <input
            id="health-interval"
            className="input"
            name="healthInterval"
            type="number"
            min={limits.intervalSeconds.min}
            max={limits.intervalSeconds.max}
            defaultValue={healthCheck?.intervalSeconds ?? limits.intervalSeconds.default}
          />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor="health-timeout">
            Timeout (s)
          </label>
          <input
            id="health-timeout"
            className="input"
            name="healthTimeout"
            type="number"
            min={limits.timeoutSeconds.min}
            max={limits.timeoutSeconds.max}
            defaultValue={healthCheck?.timeoutSeconds ?? limits.timeoutSeconds.default}
          />
        </div>
      </div>

      <label className="option-row">
        <input type="checkbox" name="autoRollback" defaultChecked={autoRollback} />
        <span>
          <span className="option-title">Rollback automático</span>
          <span className="option-description" style={{ display: "block" }}>
            Si un deploy falla, keel vuelve a desplegar la última versión que dejó bien este scope, sin pasar por
            bloqueos, ventanas ni aprobaciones.
          </span>
        </span>
      </label>

      <fieldset className="field">
        <legend className="label">Aprobación de otro miembro</legend>
        <div className="segmented" role="radiogroup">
          {[
            { value: "", label: `Como la app (${appRequiresApproval ? "obligatoria" : "no"})` },
            { value: "1", label: "Obligatoria" },
            { value: "0", label: "No" },
          ].map((o) => (
            <label key={o.value || "app"}>
              <input type="radio" name="requireApproval" value={o.value} defaultChecked={approval === o.value} />
              {o.label}
            </label>
          ))}
        </div>
        <span className="field-hint">Con aprobación, cada deploy espera a que otro maintainer lo apruebe.</span>
      </fieldset>

      <div className="form-actions">
        <span className="muted small">{state.ok ? "Guardado." : ""}</span>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
      <FormError error={state.error} />
    </form>
  );
}

/** The app-wide default for approvals; each scope can override it. */
export function AppApprovalForm({ appId, requireApproval }: { appId: string; requireApproval: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setAppApprovalAction.bind(null, appId), {});
  return (
    <form action={action} className="inline-form">
      <label className="check">
        <input type="checkbox" name="requireApproval" defaultChecked={requireApproval} /> Cada deploy necesita la
        aprobación de otro miembro (maintainer)
      </label>
      <button type="submit" className="btn btn-outline btn-sm" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </button>
      {state.ok && <span className="muted small">Guardado.</span>}
      <FormError error={state.error} />
    </form>
  );
}

/** "Aprobar" right away, or "Rechazar" with a reason in a dialog. */
export function ApprovalButtons({ appId, deployId, label }: { appId: string; deployId: string; label: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(
    decideDeployAction.bind(null, appId, deployId),
    {},
  );
  useEffect(() => {
    if (state.ok) dialog.current?.close();
  }, [state]);
  return (
    <div className="inline-form">
      <form action={action}>
        <input type="hidden" name="decision" value="approve" />
        <button type="submit" className="btn btn-sm" disabled={pending}>
          Aprobar
        </button>
      </form>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => dialog.current?.showModal()}>
        Rechazar
      </button>
      {!dialog.current?.open && <FormError error={state.error} />}
      <dialog ref={dialog} className="dialog" aria-labelledby={`reject-${deployId}`}>
        <form action={action}>
          <input type="hidden" name="decision" value="reject" />
          <div className="dialog-header">
            <h2 className="dialog-title" id={`reject-${deployId}`}>
              Rechazar {label}
            </h2>
            <p className="muted">El deploy termina como deploy_failed y no se despliega.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`reject-reason-${deployId}`}>
              Motivo
            </label>
            <textarea id={`reject-reason-${deployId}`} className="input" name="reason" required maxLength={500} />
          </div>
          <FormError error={state.error} />
          <div className="dialog-footer">
            <button type="button" className="btn btn-outline" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-destructive" disabled={pending}>
              Rechazar deploy
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
