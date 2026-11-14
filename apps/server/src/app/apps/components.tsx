"use client";

import { HEALTH_CHECK_LIMITS, type HealthCheck, LOCK_REASON_MAX } from "@keel/shared";
import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { IconLock, IconPlus, IconRefresh, IconRocket } from "../icons";
import { ConfirmButton, TokenNotice, useBackdropClose } from "../ui-client";
import {
  addScopeAction,
  createAppAction,
  decideDeployAction,
  type FormState,
  lockScopeAction,
  requestDeployAction,
  rotateTokenAction,
  type ScopeSetting,
  setAppApprovalAction,
  setScopeSettingAction,
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

export function AddScopeForm({
  appId,
  compact = false,
  onLinked,
}: {
  appId: string;
  /** Inside the drawer: one column, no title (the drawer has it). */
  compact?: boolean;
  onLinked?: () => void;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(addScopeAction.bind(null, appId), {});
  const [url, setUrl] = useState("");
  const form = useRef<HTMLFormElement>(null);
  // Only a new result runs this, not a new `onLinked` from a re-render (which would close the drawer again).
  const linked = useRef(onLinked);
  linked.current = onLinked;
  useEffect(() => {
    if (!state.ok) return;
    form.current?.reset();
    setUrl("");
    linked.current?.();
  }, [state]);
  const isCompose = /\/services\/compose\//.test(url);
  return (
    <form ref={form} action={action} className="form-panel">
      {!compact && (
        <div className="form-panel-head">
          <h3 className="form-panel-title">Vincular un scope</h3>
          <p className="hint">Copia la URL del servicio desde el dashboard de Dokploy.</p>
        </div>
      )}
      <div className={compact ? "form-stack" : "form-grid"}>
        <div className="field span-3">
          <label className="label" htmlFor="scope-alias">
            Nombre del scope
          </label>
          <input
            id="scope-alias"
            className="input"
            name="alias"
            required
            placeholder="prod"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
          <span className="field-hint">
            Lo que eliges en <code>keel deploy -s</code>.
          </span>
        </div>
        <div className="field span-6">
          <label className="label" htmlFor="scope-url">
            URL del servicio en Dokploy
          </label>
          <input
            id="scope-url"
            className="input"
            name="dokployUrl"
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://dokploy…/dashboard/project/…/services/compose/…"
          />
          <span className="field-hint">
            {isCompose
              ? "Compose: keel cambia la variable del tag en su Environment y lo redespliega."
              : "Application: keel cambia el tag de su imagen Docker."}
          </span>
        </div>
        <div className="field span-3" hidden={!isCompose}>
          <label className="label" htmlFor="scope-tag">
            Variable del tag
          </label>
          <input
            id="scope-tag"
            className="input"
            name="tagVariable"
            placeholder="DOCKER_TAG"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
          />
          <span className="field-hint">
            La imagen debe usarla:{" "}
            <code>
              image: ${"{DOCKER_IMAGE}"}:${"{DOCKER_TAG}"}
            </code>
          </span>
        </div>
      </div>
      <div className="form-actions">
        <span />
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Vinculando…" : "Vincular scope"}
        </button>
      </div>
      <FormError error={state.error} />
    </form>
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
  useBackdropClose(dialog);
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
  useBackdropClose(dialog);
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

const SETTING_LABEL: Record<ScopeSetting, string> = {
  healthEnabled: "el health check",
  autoRollback: "el rollback automático",
  requireApproval: "la aprobación",
};

/**
 * One scope setting changed in place from the scopes table: a switch, or the three-way approval select. On a scope
 * whose name says `prod` it asks first, so a stray click does not change production.
 */
export function InlineScopeSetting({
  appId,
  scopeId,
  alias,
  setting,
  value,
  appRequiresApproval = false,
  disabledHint,
}: {
  appId: string;
  scopeId: string;
  alias: string;
  setting: ScopeSetting;
  /** "1"/"0" for switches; "", "1" or "0" for the approval. */
  value: string;
  appRequiresApproval?: boolean;
  /** Shown instead of the control when it cannot be switched yet. */
  disabledHint?: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    setScopeSettingAction.bind(null, appId, scopeId, setting),
    {},
  );
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useBackdropClose(dialog);
  const [next, setNext] = useState(value);
  const id = useId();
  const confirm = alias.includes("prod");
  useEffect(() => setNext(value), [value]);

  const change = (to: string) => {
    // Render the hidden input with the new value before submitting, or the form would send the old one.
    flushSync(() => setNext(to));
    if (confirm) dialog.current?.showModal();
    else form.current?.requestSubmit();
  };
  const describe = (v: string) =>
    setting === "requireApproval"
      ? v === ""
        ? `como la app (${appRequiresApproval ? "obligatoria" : "no"})`
        : v === "1"
          ? "obligatoria"
          : "no"
      : v === "1"
        ? "activado"
        : "apagado";

  if (disabledHint) return <span className="muted small">{disabledHint}</span>;
  return (
    <form ref={form} action={action} className="inline-setting">
      <input type="hidden" name="value" value={next} />
      {setting === "requireApproval" ? (
        <select
          className="input input-sm"
          aria-label={`Aprobación de ${alias}`}
          value={confirm ? value : next}
          disabled={pending}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">Como la app ({appRequiresApproval ? "sí" : "no"})</option>
          <option value="1">Obligatoria</option>
          <option value="0">No</option>
        </select>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={value === "1"}
          aria-label={`${SETTING_LABEL[setting]} de ${alias}`}
          className="switch"
          disabled={pending}
          onClick={() => change(value === "1" ? "0" : "1")}
        />
      )}
      {state.error && (
        <span className="error small" role="alert">
          {state.error}
        </span>
      )}
      {confirm && (
        <dialog ref={dialog} className="dialog" aria-labelledby={`${id}-title`}>
          <div className="dialog-header">
            <h2 className="dialog-title" id={`${id}-title`}>
              ¿Cambiar {alias}?
            </h2>
            <p className="muted">
              {SETTING_LABEL[setting][0]?.toUpperCase()}
              {SETTING_LABEL[setting].slice(1)} pasa a <strong>{describe(next)}</strong>. Aplica desde el próximo
              deploy.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                setNext(value);
                dialog.current?.close();
              }}
            >
              Cancelar
            </button>
            <button type="submit" className="btn" onClick={() => dialog.current?.close()}>
              Cambiar
            </button>
          </div>
        </dialog>
      )}
    </form>
  );
}

/** The link form in a side drawer, like the channels and freeze windows; it closes once the scope is linked. */
export function LinkScopeDrawer({ appId }: { appId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useBackdropClose(dialog);
  const id = useId();
  return (
    <>
      <button type="button" className="btn" onClick={() => dialog.current?.showModal()}>
        <IconPlus />
        Vincular scope
      </button>
      <dialog ref={dialog} className="dialog drawer" aria-labelledby={`${id}-title`}>
        <div className="drawer-head">
          <div>
            <h2 className="dialog-title" id={`${id}-title`}>
              Vincular un scope
            </h2>
            <p className="hint">Copia la URL del servicio desde el dashboard de Dokploy.</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm drawer-close"
            aria-label="Cerrar"
            onClick={() => dialog.current?.close()}
          >
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <AddScopeForm appId={appId} compact onLinked={() => dialog.current?.close()} />
        </div>
      </dialog>
    </>
  );
}

/** A scope as the deploy drawer offers it: what runs there now and what would stop or slow a deploy. */
export interface DeployableScope {
  id: string;
  alias: string;
  running: string | null;
  needsApproval: boolean;
  /** The lock's reason, when the scope is locked: nobody deploys until it is unlocked. */
  locked: string | null;
  /** The freeze window active right now, if any, and whether this member may force it. */
  freeze: { name: string; level: string; until: string; canForce: boolean } | null;
}

export interface DeployableVersion {
  tag: string;
  /** "CI pasó", "CI en curso"… */
  ciLabel: string;
  /** Whether a deploy of it can go out: its CI passed or is still running. */
  usable: boolean;
  branch: string | null;
}

/**
 * "Nuevo deploy": a scope and a version, and a reason when a freeze window has to be forced. The server decides the
 * rest exactly as for `keel deploy`; the drawer only says beforehand what will happen.
 */
export function DeployDrawer({
  appId,
  scopes,
  versions,
  defaultScopeId,
}: {
  appId: string;
  scopes: DeployableScope[];
  versions: DeployableVersion[];
  defaultScopeId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useBackdropClose(dialog);
  const form = useRef<HTMLFormElement>(null);
  const uid = useId();
  const [state, action, pending] = useActionState<FormState, FormData>(requestDeployAction.bind(null, appId), {});
  const firstOpen = scopes.find((s) => !s.locked);
  const [scopeId, setScopeId] = useState(
    scopes.find((s) => s.id === defaultScopeId && !s.locked)?.id ?? firstOpen?.id ?? "",
  );
  const [tag, setTag] = useState(versions.find((v) => v.usable)?.tag ?? "");
  useEffect(() => {
    if (state.ok) dialog.current?.close();
  }, [state]);

  const scope = scopes.find((s) => s.id === scopeId);
  const version = versions.find((v) => v.tag === tag);
  const blockedByFreeze = Boolean(scope?.freeze && !scope.freeze.canForce);
  const id = (name: string) => `${uid}-${name}`;

  return (
    <div className="deploy-launch">
      {state.notice && (
        <span className="small muted" role="status">
          {state.notice}
        </span>
      )}
      <button type="button" className="btn" onClick={() => dialog.current?.showModal()}>
        <IconRocket />
        Nuevo deploy
      </button>
      <dialog ref={dialog} className="dialog drawer" aria-labelledby={id("title")}>
        <form ref={form} action={action} className="drawer-form">
          <div className="drawer-head">
            <div>
              <h2 className="dialog-title" id={id("title")}>
                Nuevo deploy
              </h2>
              <p className="hint">
                Lo mismo que <code>keel deploy</code>: respeta bloqueos, ventanas de congelamiento y aprobaciones.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm drawer-close"
              aria-label="Cerrar"
              onClick={() => dialog.current?.close()}
            >
              ✕
            </button>
          </div>

          <div className="drawer-body">
            <fieldset className="field">
              <legend className="label">Scope</legend>
              {scopes.length === 0 ? (
                <p className="hint">No puedes desplegar en ningún scope de esta app.</p>
              ) : (
                <div className="preset-list" role="radiogroup">
                  {scopes.map((s) => (
                    <label key={s.id} className={`preset-option${s.locked ? " is-disabled" : ""}`}>
                      <input
                        type="radio"
                        name="scopeId"
                        value={s.id}
                        checked={scopeId === s.id}
                        disabled={Boolean(s.locked)}
                        onChange={() => setScopeId(s.id)}
                      />
                      <span>
                        <span className="option-title">{s.alias}</span>
                        <span className="option-description">
                          {s.running ? `Corre ${s.running}` : "Sin deploys todavía"}
                          {s.needsApproval && " · pide aprobación"}
                          {s.locked && ` · bloqueado: ${s.locked}`}
                          {s.freeze && ` · ventana «${s.freeze.name}» hasta ${s.freeze.until}`}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <div className="field">
              <label className="label" htmlFor={id("tag")}>
                Versión
              </label>
              {versions.length === 0 ? (
                <p className="hint">
                  Esta app no tiene versiones todavía: créalas con <code>keel create-version</code>.
                </p>
              ) : (
                <select
                  id={id("tag")}
                  className="input"
                  name="tag"
                  required
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  {versions.map((v) => (
                    <option key={v.tag} value={v.tag} disabled={!v.usable}>
                      {v.tag} · {v.ciLabel}
                      {v.branch ? ` · ${v.branch}` : ""}
                    </option>
                  ))}
                </select>
              )}
              <span className="field-hint">
                Las 30 más recientes. Las que fallaron en el CI no se pueden desplegar.
              </span>
            </div>

            {scope?.freeze && (
              <div className="field">
                <label className="label" htmlFor={id("reason")}>
                  Motivo para forzar la ventana
                </label>
                {scope.freeze.canForce ? (
                  <>
                    <textarea
                      id={id("reason")}
                      className="input"
                      name="forceReason"
                      required
                      maxLength={500}
                      placeholder="Hotfix de pagos"
                    />
                    <span className="field-hint">Queda en la auditoría y se notifica como deploy forzoso.</span>
                  </>
                ) : (
                  <p className="error">
                    {scope.alias} está en la ventana «{scope.freeze.name}» ({scope.freeze.level}) y tu rol no puede
                    forzarla.
                  </p>
                )}
              </div>
            )}

            {scope && version && (
              <p className="preview freeze-preview" aria-live="polite">
                <span>
                  Desplegará <strong>{version.tag}</strong> en <strong>{scope.alias}</strong>
                  {scope.running && scope.running !== version.tag ? ` (ahora corre ${scope.running})` : ""}
                  {scope.running === version.tag ? " (ya es la que corre)" : ""}.
                  {version.ciLabel !== "CI pasó" && version.usable && " Esperará a que termine su CI."}
                  {scope.needsApproval && " Otro miembro tendrá que aprobarlo."}
                </span>
              </p>
            )}
            {state.error && (
              <p className="error" role="alert">
                {state.error}
              </p>
            )}
          </div>

          <div className="drawer-foot">
            <button type="button" className="btn btn-outline" onClick={() => dialog.current?.close()}>
              Cancelar
            </button>
            <button
              type="submit"
              className="btn"
              disabled={pending || !scope || !version || blockedByFreeze || scopes.length === 0}
            >
              <IconRocket />
              {pending ? "Pidiendo…" : "Desplegar"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
