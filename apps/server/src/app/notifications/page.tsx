import { getContext } from "@/lib/context";
import { EVENT_LABELS, envChannels, maskUrl, NOTIFY_EVENTS, type NotifyEvent } from "@/lib/notify";
import type { NotificationChannel } from "@/lib/store";
import { IconBell } from "../icons";
import { requireRole } from "../session";
import { EmptyState, Page, PageHeader, StatusBadge, When } from "../ui";
import { toggleChannelAction } from "./actions";
import { ChannelDrawer, type EditableChannel, TestChannelButton } from "./components";
import { type ChannelKindName, ChannelLogo, KIND_LABEL } from "./logo";
import { EVENT_PRESETS, presetOf } from "./presets";

const ENV_VAR: Record<ChannelKindName, string> = {
  slack: "KEEL_SLACK_WEBHOOK_URL",
  slack_bot: "KEEL_SLACK_BOT_TOKEN",
  discord: "KEEL_DISCORD_WEBHOOK_URL",
  webhook: "KEEL_WEBHOOK_URL",
};

const FAILURES: readonly string[] = EVENT_PRESETS.find((p) => p.id === "failures")?.events ?? [];

/** Failures read red, approvals amber, a finished deploy green. */
function eventTone(event: string): string {
  if (event === "deploy.deployed") return "event-chip-done";
  if (FAILURES.includes(event)) return "event-chip-error";
  return "event-chip-running";
}

/** A channel's events as chips: the preset's name when they match one, the events one by one otherwise. */
function EventChips({ events }: { events: string[] }) {
  const preset = EVENT_PRESETS.find((p) => p.id === presetOf(events));
  if (preset?.id === "all") return <span className="event-chip">Todos los eventos</span>;
  if (preset) {
    return (
      <span className={`event-chip ${eventTone(preset.events[0])}`}>
        {preset.label} ({preset.events.length})
      </span>
    );
  }
  return (
    <>
      {events.map((e) => (
        <span key={e} className={`event-chip ${eventTone(e)}`}>
          {EVENT_LABELS[e as NotifyEvent] ?? e}
        </span>
      ))}
    </>
  );
}

function AppliesTo({ repo, scope }: { repo: string; scope: string }) {
  return (
    <div className="channel-scope">
      <span className="channel-section-label">Aplica a</span>
      <span>
        {repo === "*" ? <span className="muted">todos los repos</span> : <code>{repo}</code>}
        <span className="muted"> · </span>
        {scope === "*" ? <span className="muted">todos los scopes</span> : <code>{scope}</code>}
      </span>
    </div>
  );
}

/** Where a channel posts, safe to show: a Slack bot's channel, or a webhook's masked URL. */
const destination = (c: Pick<NotificationChannel, "kind" | "url" | "target">) =>
  c.kind === "slack_bot" ? `${c.target} · bot` : maskUrl(c.url);

const editable = (c: NotificationChannel): EditableChannel => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  maskedUrl: maskUrl(c.url),
  target: c.target,
  signed: Boolean(c.secret),
  events: c.events,
  repoPattern: c.repoPattern,
  scopePattern: c.scopePattern,
});

export default async function NotificationsPage() {
  await requireRole("admin", undefined, { redirect: true });
  const { store, env } = await getContext();
  const channels = await store.listChannels();
  const fromEnv = envChannels(env);
  const events = NOTIFY_EVENTS.map((name) => ({ name, label: EVENT_LABELS[name] }));

  return (
    <Page crumbs={[{ label: "Notificaciones" }]}>
      <PageHeader
        title="Notificaciones"
        description="Dónde avisa keel cuando un deploy termina, falla, expira, se revierte o espera aprobación. Las URLs de webhook son secretos: aquí solo se ven enmascaradas."
        actions={<ChannelDrawer events={events} />}
      />
      {channels.length === 0 && fromEnv.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconBell />} title="Sin canales">
            Agrega uno con «Nuevo canal» para recibir los avisos de deploys en Slack, Discord o tu propio servicio.
          </EmptyState>
        </div>
      ) : (
        <div className="channel-grid">
          {channels.map((c) => (
            <article key={c.id} className={`card channel-card${c.enabled ? "" : " is-paused"}`}>
              <header className="channel-head">
                <ChannelLogo kind={c.kind} />
                <div className="channel-title">
                  <h2>{c.name}</h2>
                  <span className="mono muted channel-url">{destination(c)}</span>
                </div>
                <StatusBadge tone={c.enabled ? "done" : "idle"}>{c.enabled ? "Activo" : "Pausado"}</StatusBadge>
              </header>
              <AppliesTo repo={c.repoPattern} scope={c.scopePattern} />
              <div className="channel-events">
                <EventChips events={c.events} />
                {c.secret && c.kind === "webhook" && <span className="event-chip">Firmado</span>}
              </div>
              <footer className="channel-foot">
                <span className="small muted">
                  {KIND_LABEL[c.kind]} · <When iso={c.createdAt} />
                </span>
                <div className="channel-actions">
                  <TestChannelButton channelId={c.id} />
                  <form action={toggleChannelAction}>
                    <input type="hidden" name="channelId" value={c.id} />
                    <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                    <button type="submit" className="btn btn-ghost btn-sm">
                      {c.enabled ? "Pausar" : "Activar"}
                    </button>
                  </form>
                  <ChannelDrawer channel={editable(c)} events={events} />
                </div>
              </footer>
            </article>
          ))}
          {fromEnv.map((c) => (
            <article key={c.name} className="card channel-card is-env">
              <header className="channel-head">
                <ChannelLogo kind={c.kind} />
                <div className="channel-title">
                  <h2>
                    {KIND_LABEL[c.kind]} <span className="badge badge-outline">ENV</span>
                  </h2>
                  <span className="mono muted channel-url">{destination(c)}</span>
                </div>
              </header>
              <div className="channel-scope">
                <span className="channel-section-label">Definido en</span>
                <code>{ENV_VAR[c.kind]}</code>
                {c.kind === "slack_bot" && (
                  <>
                    {" "}
                    y <code>KEEL_SLACK_CHANNEL</code>
                  </>
                )}
              </div>
              <div className="channel-events">
                <EventChips events={c.events} />
              </div>
              <footer className="channel-foot">
                <span className="small muted">Solo cambia en el Environment del servicio</span>
              </footer>
            </article>
          ))}
        </div>
      )}
      {fromEnv.length > 0 && (
        <p className="small muted channel-note">
          Los canales <span className="badge badge-outline">ENV</span> se suman a los configurados aquí. Si la misma URL
          está en los dos sitios, recibe cada aviso una sola vez.
        </p>
      )}
    </Page>
  );
}
