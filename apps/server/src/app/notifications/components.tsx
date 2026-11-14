"use client";

import { useActionState, useEffect, useRef } from "react";
import { IconPlus } from "../icons";
import { type ChannelFormState, createChannelAction, testChannelAction } from "./actions";

export function CreateChannelForm({ events }: { events: { name: string; label: string }[] }) {
  const [state, action, pending] = useActionState<ChannelFormState, FormData>(createChannelAction, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <>
      <form ref={form} action={action} className="form-stack">
        <div className="form-row">
          <div className="field narrow">
            <label className="label" htmlFor="channel-name">
              Nombre
            </label>
            <input id="channel-name" className="input" name="name" required maxLength={100} placeholder="#deploys" />
          </div>
          <div className="field narrow">
            <label className="label" htmlFor="channel-kind">
              Tipo
            </label>
            <select id="channel-kind" className="input" name="kind" defaultValue="slack">
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="webhook">Webhook genérico</option>
            </select>
          </div>
          <div className="field">
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
              placeholder="https://hooks.slack.com/services/…"
            />
          </div>
        </div>
        <div className="form-row">
          <div className="field narrow">
            <label className="label" htmlFor="channel-repo">
              Repos
            </label>
            <input id="channel-repo" className="input" name="repo" placeholder="* (todos)" />
          </div>
          <div className="field narrow">
            <label className="label" htmlFor="channel-scope">
              Scopes
            </label>
            <input id="channel-scope" className="input" name="scope" placeholder="* (todos), prod*" />
          </div>
          <div className="field">
            <label className="label" htmlFor="channel-secret">
              Secreto para firmar (solo webhook genérico)
            </label>
            <input id="channel-secret" className="input" name="secret" type="password" autoComplete="off" />
          </div>
        </div>
        <fieldset className="field">
          <legend className="label">Eventos (ninguno marcado = todos)</legend>
          <div className="check-grid">
            {events.map((event) => (
              <label key={event.name} className="check">
                <input type="checkbox" name="events" value={event.name} /> {event.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <button type="submit" className="btn" disabled={pending}>
            <IconPlus />
            {pending ? "Agregando…" : "Agregar canal"}
          </button>
        </div>
      </form>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
    </>
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
