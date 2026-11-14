"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { IconPlus } from "../icons";
import { type ChannelFormState, createChannelAction, testChannelAction } from "./actions";

const KINDS = [
  { value: "slack", label: "Slack", placeholder: "https://hooks.slack.com/services/…" },
  { value: "discord", label: "Discord", placeholder: "https://discord.com/api/webhooks/…" },
  { value: "webhook", label: "Webhook genérico", placeholder: "https://ops.example.com/keel" },
] as const;

export function CreateChannelForm({ events }: { events: { name: string; label: string }[] }) {
  const [state, action, pending] = useActionState<ChannelFormState, FormData>(createChannelAction, {});
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("slack");
  const [picked, setPicked] = useState<string[]>([]);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.ok) return;
    form.current?.reset();
    setPicked([]);
  }, [state]);
  const current = KINDS.find((k) => k.value === kind) ?? KINDS[0];
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  return (
    <form ref={form} action={action} className="form-panel">
      <div className="form-panel-head">
        <h3 className="form-panel-title">Nuevo canal</h3>
        <p className="hint">La URL del webhook es un secreto: después solo se verá enmascarada.</p>
      </div>

      <div className="form-grid">
        <fieldset className="field">
          <legend className="label">Tipo</legend>
          <div className="segmented" role="radiogroup">
            {KINDS.map((k) => (
              <label key={k.value}>
                <input
                  type="radio"
                  name="kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                />
                {k.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field span-4">
          <label className="label" htmlFor="channel-name">
            Nombre
          </label>
          <input id="channel-name" className="input" name="name" required maxLength={100} placeholder="#deploys" />
        </div>
        <div className="field span-8">
          <label className="label" htmlFor="channel-url">
            URL del webhook
          </label>
          <input
            id="channel-url"
            className="input"
            name="url"
            type="url"
            required
            autoComplete="off"
            placeholder={current.placeholder}
          />
        </div>
        {kind === "webhook" && (
          <div className="field span-6">
            <label className="label" htmlFor="channel-secret">
              Secreto para firmar
            </label>
            <input id="channel-secret" className="input" name="secret" type="password" autoComplete="off" />
            <span className="field-hint">
              Opcional. Se envía la firma en <code>X-Keel-Signature: sha256=…</code>.
            </span>
          </div>
        )}
        <div className="field span-3">
          <label className="label" htmlFor="channel-repo">
            Repos
          </label>
          <input id="channel-repo" className="input" name="repo" placeholder="Todos" />
        </div>
        <div className="field span-3">
          <label className="label" htmlFor="channel-scope">
            Scopes
          </label>
          <input id="channel-scope" className="input" name="scope" placeholder="Todos" />
        </div>
        <p className="field-hint">
          Filtros con <code>*</code>, p. ej. <code>konectus-io/*</code> o <code>prod*</code>. Vacíos = todos.
        </p>
        <fieldset className="field">
          <legend className="label">Eventos</legend>
          <div className="pill-group">
            {events.map((event) => (
              <label key={event.name} className="pill">
                <input
                  type="checkbox"
                  name="events"
                  value={event.name}
                  checked={picked.includes(event.name)}
                  onChange={() => toggle(event.name)}
                />
                {event.label}
              </label>
            ))}
          </div>
          <div className="pill-actions">
            <button
              type="button"
              onClick={() => setPicked(["deploy.failed", "deploy.ci_failed", "deploy.expired", "deploy.rollback"])}
            >
              Solo fallos
            </button>
            {picked.length > 0 && (
              <button type="button" onClick={() => setPicked([])}>
                Todos
              </button>
            )}
          </div>
        </fieldset>
      </div>

      <div className="form-actions">
        <p className="preview" aria-live="polite">
          {picked.length === 0 ? (
            <>
              Recibirá <strong>todos los eventos</strong>.
            </>
          ) : (
            <>
              Recibirá{" "}
              <strong>
                {picked.length} de {events.length} eventos
              </strong>
              .
            </>
          )}
        </p>
        <button type="submit" className="btn" disabled={pending}>
          <IconPlus />
          {pending ? "Agregando…" : "Agregar canal"}
        </button>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}

export function TestChannelButton({ channelId }: { channelId: string }) {
  const [state, action, pending] = useActionState<ChannelFormState, FormData>(
    testChannelAction.bind(null, channelId),
    {},
  );
  return (
    <form action={action} className="inline-form">
      <button type="submit" className="btn btn-outline btn-sm" disabled={pending}>
        {pending ? "Enviando…" : "Probar"}
      </button>
      {state.message && <span className="muted small">{state.message}</span>}
      {state.error && (
        <span className="error small" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
