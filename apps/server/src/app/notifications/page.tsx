import { getContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { ALL_EVENTS, EVENT_LABELS, envChannels, maskUrl, NOTIFY_EVENTS, type NotifyEvent } from "@/lib/notify";
import { IconTrash } from "../icons";
import { requireRole } from "../session";
import { Card, Page, PageHeader, StatusBadge } from "../ui";
import { ConfirmButton } from "../ui-client";
import { deleteChannelAction, toggleChannelAction } from "./actions";
import { CreateChannelForm, TestChannelButton } from "./components";

const KIND_LABEL = { slack: "Slack", discord: "Discord", webhook: "Webhook" } as const;

const eventsLabel = (events: string[]) =>
  events.includes(ALL_EVENTS) ? "Todos" : events.map((e) => EVENT_LABELS[e as NotifyEvent] ?? e).join(", ");

export default async function NotificationsPage() {
  await requireRole("admin", undefined, { redirect: true });
  const { store, env } = await getContext();
  const channels = await store.listChannels();
  const fromEnv = envChannels(env);

  return (
    <Page crumbs={[{ label: "Notificaciones" }]}>
      <PageHeader
        title="Notificaciones"
        description="keel avisa de cada deploy que termina, falla, expira, se revierte o espera aprobación. Las URLs de webhook son secretos: aquí solo se ven enmascaradas."
      />
      <div className="stack">
        <Card
          title="Canales"
          description="Slack, Discord o cualquier servicio que acepte un POST con JSON. Cada canal puede limitarse a ciertos repos, scopes y eventos."
          footer={<CreateChannelForm events={NOTIFY_EVENTS.map((name) => ({ name, label: EVENT_LABELS[name] }))} />}
        >
          {channels.length === 0 ? (
            <p className="empty">Todavía no hay canales creados en el admin.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th>Webhook</th>
                    <th>Aplica a</th>
                    <th>Eventos</th>
                    <th>Estado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        <div className="sub">
                          {KIND_LABEL[c.kind]} · {formatDate(c.createdAt)}
                        </div>
                      </td>
                      <td>
                        <code>{maskUrl(c.url)}</code>
                        {c.secret && <div className="sub">firmado</div>}
                      </td>
                      <td>
                        <code>{c.repoPattern}</code> / <code>{c.scopePattern}</code>
                      </td>
                      <td className="small">{eventsLabel(c.events)}</td>
                      <td>
                        <StatusBadge tone={c.enabled ? "done" : "idle"}>{c.enabled ? "Activo" : "Pausado"}</StatusBadge>
                      </td>
                      <td>
                        <div className="row-actions">
                          <TestChannelButton channelId={c.id} />
                          <form action={toggleChannelAction}>
                            <input type="hidden" name="channelId" value={c.id} />
                            <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                            <button type="submit" className="btn btn-outline btn-sm">
                              {c.enabled ? "Pausar" : "Activar"}
                            </button>
                          </form>
                          <form action={deleteChannelAction}>
                            <input type="hidden" name="channelId" value={c.id} />
                            <ConfirmButton message={`¿Eliminar el canal ${c.name}? Deja de recibir notificaciones.`}>
                              <IconTrash />
                              Eliminar
                            </ConfirmButton>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card
          title="Canales del entorno"
          description={
            <>
              Definidos con <code>KEEL_SLACK_WEBHOOK_URL</code>, <code>KEEL_DISCORD_WEBHOOK_URL</code> y{" "}
              <code>KEEL_WEBHOOK_URL</code>. Se suman a los de arriba y solo cambian en el Environment del servicio; si
              la misma URL está en los dos sitios, recibe cada aviso una sola vez.
            </>
          }
        >
          {fromEnv.length === 0 ? (
            <p className="empty">Ninguno configurado.</p>
          ) : (
            <ul className="plain-list">
              {fromEnv.map((c) => (
                <li key={c.name}>
                  {KIND_LABEL[c.kind]} · <code>{maskUrl(c.url)}</code> ·{" "}
                  <span className="small">{eventsLabel(c.events)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
