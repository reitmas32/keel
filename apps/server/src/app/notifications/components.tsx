"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { IconPencil, IconPlus, IconTrash } from "../icons";
import { ConfirmButton } from "../ui-client";
import { type ChannelFormState, deleteChannelAction, saveChannelAction, testChannelAction } from "./actions";
import { type ChannelKindName, ChannelLogo, KIND_LABEL } from "./logo";
import { EVENT_PRESETS, type PresetId, presetOf } from "./presets";

const KINDS = [
  { value: "slack", placeholder: "https://hooks.slack.com/services/…" },
  { value: "discord", placeholder: "https://discord.com/api/webhooks/…" },
  { value: "webhook", placeholder: "https://ops.example.com/keel" },
] as const;

const PRESET_OPTIONS: { id: PresetId; label: string; hint: string }[] = [
  { id: "all", label: "Todo", hint: "Los 9 eventos" },
  { id: "failures", label: "Solo fallos", hint: "Fallido, CI fallido, expirado y rollback" },
  { id: "approvals", label: "Aprobaciones", hint: "Pendiente, aprobado, rechazado y forzoso" },
  { id: "custom", label: "Personalizado", hint: "Elige los eventos uno a uno" },
];

/** What the drawer needs of a channel it edits. Never the URL or the secret: only their masked hint. */
export interface EditableChannel {
  id: string;
  name: string;
  kind: ChannelKindName;
  maskedUrl: string;
  signed: boolean;
  events: string[];
  repoPattern: string;
  scopePattern: string;
}

const blankIfAll = (pattern: string) => (pattern === "*" ? "" : pattern);
const presetEvents = (id: PresetId): readonly string[] => EVENT_PRESETS.find((p) => p.id === id)?.events ?? [];

/**
 * A side panel that creates a channel or, given `channel`, edits it. It is a modal `<dialog>`, like ConfirmButton,
 * so focus, Escape and the backdrop behave the same everywhere.
 */
export function ChannelDrawer({
  channel,
  events,
}: {
  channel?: EditableChannel;
  events: { name: string; label: string }[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const uid = useId();
  const [state, action, pending] = useActionState<ChannelFormState, FormData>(saveChannelAction, {});
  const [kind, setKind] = useState<ChannelKindName>(channel?.kind ?? "slack");
  const [preset, setPreset] = useState<PresetId>(channel ? presetOf(channel.events) : "all");
  const [picked, setPicked] = useState<string[]>(channel?.events.filter((e) => e !== "*") ?? []);

  useEffect(() => {
    if (!state.ok) return;
    dialog.current?.close();
    if (!channel) {
      form.current?.reset();
      setKind("slack");
      setPreset("all");
      setPicked([]);
    }
  }, [state, channel]);

  const current = KINDS.find((k) => k.value === kind) ?? KINDS[0];
  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  const choosePreset = (id: PresetId) => {
    setPreset(id);
    // Switching to "Personalizado" starts from what the preset had, so it is a tweak and not a blank slate.
    if (id !== "custom") setPicked(presetEvents(id).filter((e) => e !== "*"));
  };
  const id = (name: string) => `${uid}-${name}`;

  return (
    <>
      {channel ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => dialog.current?.showModal()}>
          <IconPencil />
          Editar
        </button>
      ) : (
        <button type="button" className="btn" onClick={() => dialog.current?.showModal()}>
          <IconPlus />
          Nuevo canal
        </button>
      )}
      <dialog ref={dialog} className="dialog drawer" aria-labelledby={id("title")}>
        <form ref={form} action={action} className="drawer-form">
          <div className="drawer-head">
            <div>
              <h2 className="dialog-title" id={id("title")}>
                {channel ? `Editar ${channel.name}` : "Nuevo canal"}
              </h2>
              <p className="hint">
                {channel
                  ? "Deja la URL vacía para conservar la actual."
                  : "La URL del webhook es un secreto: después solo se verá enmascarada."}
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
            {channel && <input type="hidden" name="channelId" value={channel.id} />}
            <fieldset className="field">
              <legend className="label">Tipo</legend>
              <div className="segmented kind-picker" role="radiogroup">
                {KINDS.map((k) => (
                  <label key={k.value}>
                    <input
                      type="radio"
                      name="kind"
                      value={k.value}
                      checked={kind === k.value}
                      onChange={() => setKind(k.value)}
                    />
                    <ChannelLogo kind={k.value} size="sm" />
                    {KIND_LABEL[k.value]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="field">
              <label className="label" htmlFor={id("name")}>
                Nombre
              </label>
              <input
                id={id("name")}
                className="input"
                name="name"
                required
                maxLength={100}
                placeholder="#deploys"
                defaultValue={channel?.name}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor={id("url")}>
                URL del webhook
              </label>
              <input
                id={id("url")}
                className="input"
                name="url"
                type="url"
                required={!channel}
                autoComplete="off"
                placeholder={channel ? channel.maskedUrl : current.placeholder}
              />
            </div>

            {kind === "webhook" && (
              <div className="field">
                <label className="label" htmlFor={id("secret")}>
                  Secreto para firmar
                </label>
                <input
                  id={id("secret")}
                  className="input"
                  name="secret"
                  type="password"
                  autoComplete="off"
                  placeholder={channel?.signed ? "•••••••• (sin cambios)" : undefined}
                />
                <span className="field-hint">
                  Opcional. Se envía la firma en <code>X-Keel-Signature: sha256=…</code>.
                </span>
              </div>
            )}

            <div className="field">
              <div className="drawer-pair">
                <div className="field">
                  <label className="label" htmlFor={id("repo")}>
                    Repos
                  </label>
                  <input
                    id={id("repo")}
                    className="input"
                    name="repo"
                    placeholder="Todos"
                    defaultValue={channel ? blankIfAll(channel.repoPattern) : undefined}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor={id("scope")}>
                    Scopes
                  </label>
                  <input
                    id={id("scope")}
                    className="input"
                    name="scope"
                    placeholder="Todos"
                    defaultValue={channel ? blankIfAll(channel.scopePattern) : undefined}
                  />
                </div>
              </div>
              <p className="field-hint">
                Filtros con <code>*</code>, p. ej. <code>konectus-io/*</code> o <code>prod*</code>. Vacíos = todos.
              </p>
            </div>

            <fieldset className="field">
              <legend className="label">Qué avisa</legend>
              <div className="preset-list" role="radiogroup">
                {PRESET_OPTIONS.map((p) => (
                  <label key={p.id} className="preset-option">
                    <input
                      type="radio"
                      name={`${uid}-preset`}
                      checked={preset === p.id}
                      onChange={() => choosePreset(p.id)}
                    />
                    <span>
                      <span className="option-title">{p.label}</span>
                      <span className="option-description">{p.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {preset === "custom" ? (
                <>
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
                  <p className="preview" aria-live="polite">
                    {picked.length === 0 ? (
                      <>
                        Sin ninguno marcado recibirá <strong>todos los eventos</strong>.
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
                </>
              ) : (
                presetEvents(preset).map((e) => <input key={e} type="hidden" name="events" value={e} />)
              )}
            </fieldset>
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
            <button type="submit" className="btn" disabled={pending}>
              {pending ? "Guardando…" : channel ? "Guardar" : "Agregar canal"}
            </button>
          </div>
        </form>
        {channel && (
          <form action={deleteChannelAction} className="drawer-danger">
            <input type="hidden" name="channelId" value={channel.id} />
            <span className="small muted">Deja de recibir avisos al momento.</span>
            <ConfirmButton message={`¿Eliminar el canal ${channel.name}? Deja de recibir notificaciones.`}>
              <IconTrash />
              Eliminar canal
            </ConfirmButton>
          </form>
        )}
      </dialog>
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
      <button type="submit" className="btn btn-ghost btn-sm" disabled={pending}>
        {pending ? "Enviando…" : "Probar"}
      </button>
      {state.message && <span className="muted small test-result">{state.message}</span>}
      {state.error && (
        <span className="error small test-result" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
