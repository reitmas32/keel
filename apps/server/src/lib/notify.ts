import { createHmac } from "node:crypto";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { logger } from "./log";
import { metrics } from "./metrics";
import { globMatch, normalizeGrantPatterns } from "./roles";
import { CHANNEL_KINDS, type ChannelKind, type DeployRecord, type NotificationChannel, type Store } from "./store";

/** What keel notifies about. Channels subscribe to some of them, or to all with `*`. */
export const NOTIFY_EVENTS = [
  "deploy.deployed",
  "deploy.failed",
  "deploy.ci_failed",
  "deploy.expired",
  "deploy.rollback",
  "deploy.approval_requested",
  "deploy.approved",
  "deploy.rejected",
  "deploy.forced",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  "deploy.deployed": "Deploy completado",
  "deploy.failed": "Deploy fallido",
  "deploy.ci_failed": "CI fallido",
  "deploy.expired": "Deploy expirado",
  "deploy.rollback": "Rollback automático",
  "deploy.approval_requested": "Aprobación pendiente",
  "deploy.approved": "Deploy aprobado",
  "deploy.rejected": "Deploy rechazado",
  "deploy.forced": "Deploy forzoso",
};

export const ALL_EVENTS = "*";
export const CHANNEL_NAME_MAX = 100;
const SEND_TIMEOUT_MS = 5_000;

export interface DeployNotification {
  event: NotifyEvent;
  deploy: Pick<DeployRecord, "id" | "repo" | "tag" | "sha" | "scope" | "status" | "error" | "requestedBy">;
  /** The person behind the event when it isn't who asked for the deploy (an approver, whoever forced it). */
  actor?: string | null;
  /** An extra line: a reason, the version rolled back to… */
  detail?: string | null;
}

/** What the worker and the handlers need: fire a notification and move on. It never throws. */
export interface Notifier {
  notify(notification: DeployNotification): void;
}

/** A channel as the notifier uses it; the ones from the environment have no id. */
type Target = Pick<NotificationChannel, "name" | "kind" | "url" | "secret" | "events" | "repoPattern" | "scopePattern">;

/** `https://hooks.slack.com/…a1b2`: enough to recognize a webhook, never enough to call it. */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = url.replace(/\/+$/, "").slice(-4);
    return `${parsed.protocol}//${parsed.host}/…${tail}`;
  } catch {
    return "…";
  }
}

/** Parses `a, b` into known events; empty or `*` means all. Throws the 400 the admin (or the env check) shows. */
export function parseEvents(input: string | readonly string[] | undefined): string[] {
  const names = (typeof input === "string" ? input.split(",") : [...(input ?? [])])
    .map((e) => e.trim())
    .filter(Boolean);
  if (names.length === 0 || names.includes(ALL_EVENTS)) return [ALL_EVENTS];
  const unknown = names.filter((e) => !NOTIFY_EVENTS.includes(e as NotifyEvent));
  if (unknown.length > 0) {
    throw new ApiError(400, `Evento desconocido: ${unknown.join(", ")}. Usa: ${NOTIFY_EVENTS.join(", ")} o *.`);
  }
  return [...new Set(names)];
}

/** The channels the environment defines. They always notify, on top of the ones created in the admin. */
export function envChannels(env: Partial<Env>): Target[] {
  const events = parseEvents(env.KEEL_NOTIFY_EVENTS);
  const base = { events, repoPattern: "*", scopePattern: "*" };
  const channels: Target[] = [];
  if (env.KEEL_SLACK_WEBHOOK_URL) {
    channels.push({ ...base, name: "env:slack", kind: "slack", url: env.KEEL_SLACK_WEBHOOK_URL, secret: null });
  }
  if (env.KEEL_DISCORD_WEBHOOK_URL) {
    channels.push({ ...base, name: "env:discord", kind: "discord", url: env.KEEL_DISCORD_WEBHOOK_URL, secret: null });
  }
  if (env.KEEL_WEBHOOK_URL) {
    channels.push({
      ...base,
      name: "env:webhook",
      kind: "webhook",
      url: env.KEEL_WEBHOOK_URL,
      secret: env.KEEL_WEBHOOK_SECRET ?? null,
    });
  }
  return channels;
}

const wants = (channel: Target, n: DeployNotification) =>
  (channel.events.includes(ALL_EVENTS) || channel.events.includes(n.event)) &&
  globMatch(channel.repoPattern, n.deploy.repo) &&
  globMatch(channel.scopePattern, n.deploy.scope);

const ICONS: Record<NotifyEvent, string> = {
  "deploy.deployed": "✅",
  "deploy.failed": "❌",
  "deploy.ci_failed": "❌",
  "deploy.expired": "⌛",
  "deploy.rollback": "↩️",
  "deploy.approval_requested": "✋",
  "deploy.approved": "👍",
  "deploy.rejected": "🚫",
  "deploy.forced": "⚠️",
};

/** One or two lines of plain text, in Spanish, for Slack and Discord. */
export function formatMessage(n: DeployNotification, link?: string): string {
  const { deploy: d } = n;
  const where = `${d.repo} ${d.tag} → ${d.scope}`;
  const by = d.requestedBy ? ` (pedido por ${d.requestedBy})` : "";
  const headline: Record<NotifyEvent, string> = {
    "deploy.deployed": `${where} desplegado${by}`,
    "deploy.failed": `${where} falló${by}`,
    "deploy.ci_failed": `${where}: el CI falló, no se despliega${by}`,
    "deploy.expired": `${where} expiró${by}`,
    "deploy.rollback": `${where}: rollback automático`,
    "deploy.approval_requested": `${where} espera aprobación${by}`,
    "deploy.approved": `${where} aprobado por ${n.actor ?? "alguien"}`,
    "deploy.rejected": `${where} rechazado por ${n.actor ?? "alguien"}`,
    "deploy.forced": `${where}: deploy forzoso durante una ventana de congelamiento, por ${n.actor ?? "alguien"}`,
  };
  const lines = [`${ICONS[n.event]} ${headline[n.event]}`];
  const failed = n.event === "deploy.failed" || n.event === "deploy.expired" || n.event === "deploy.ci_failed";
  if (failed && d.error) lines.push(d.error);
  if (n.detail) lines.push(n.detail);
  if (link) lines.push(link);
  return lines.join("\n");
}

function bodyFor(channel: Target, n: DeployNotification, at: string, link?: string): string {
  if (channel.kind === "slack") return JSON.stringify({ text: formatMessage(n, link) });
  if (channel.kind === "discord") return JSON.stringify({ content: formatMessage(n, link).slice(0, 2000) });
  return JSON.stringify({
    event: n.event,
    at,
    deploy: {
      id: n.deploy.id,
      repo: n.deploy.repo,
      tag: n.deploy.tag,
      sha: n.deploy.sha,
      scope: n.deploy.scope,
      status: n.deploy.status,
      error: n.deploy.error,
      requestedBy: n.deploy.requestedBy ?? null,
    },
    actor: n.actor ?? null,
    detail: n.detail ?? null,
    ...(link && { url: link }),
    text: formatMessage(n),
  });
}

export const signBody = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/**
 * Sends notifications to the channels of the environment and of the admin. `notify` returns right away and never
 * throws: a channel that fails is logged (with its URL masked) and counted, and the deploy goes on.
 */
export class WebhookNotifier implements Notifier {
  private readonly pending = new Set<Promise<void>>();
  private readonly fromEnv: Target[];

  constructor(
    private readonly store: Store,
    private readonly env: Partial<Env>,
    private readonly options: { fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.fromEnv = envChannels(env);
  }

  notify(notification: DeployNotification): void {
    const task = this.dispatch(notification).catch((error) => {
      logger.error("no se pudo notificar", { event: notification.event, error: (error as Error).message });
    });
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }

  /** Waits for the notifications in flight. For tests and for a clean shutdown. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async dispatch(n: DeployNotification): Promise<void> {
    const saved = (await this.store.listChannels()).filter((c) => c.enabled);
    // The same webhook configured in both places gets each event once.
    const seen = new Set<string>();
    const targets = [...this.fromEnv, ...saved].filter((c) => {
      if (!wants(c, n) || seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
    if (targets.length === 0) return;
    const link = await this.linkFor(n);
    const at = (this.options.now?.() ?? new Date()).toISOString();
    await Promise.all(targets.map((channel) => this.send(channel, n, at, link)));
  }

  private async linkFor(n: DeployNotification): Promise<string | undefined> {
    if (!this.env.KEEL_PUBLIC_URL) return undefined;
    const app = await this.store.getAppByRepo(n.deploy.repo);
    return app ? `${this.env.KEEL_PUBLIC_URL.replace(/\/+$/, "")}/apps/${app.id}/deploys` : undefined;
  }

  /** Posts one notification to one channel. Resolves to an error message instead of throwing. */
  async send(channel: Target, n: DeployNotification, at: string, link?: string): Promise<string | undefined> {
    const body = bodyFor(channel, n, at, link);
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "keel" };
    if (channel.kind === "webhook") {
      headers["x-keel-event"] = n.event;
      if (channel.secret) headers["x-keel-signature"] = signBody(body, channel.secret);
    }
    let failure: string | undefined;
    try {
      const response = await (this.options.fetch ?? fetch)(channel.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) failure = `respondió ${response.status}`;
    } catch (error) {
      // Never the raw error of fetch: it can carry the URL.
      failure = (error as Error).name === "TimeoutError" ? "no respondió a tiempo" : "no se pudo conectar";
    }
    metrics.notification(channel.kind, failure === undefined);
    if (failure) {
      logger.warn("notificación fallida", {
        channel: channel.name,
        kind: channel.kind,
        url: maskUrl(channel.url),
        event: n.event,
        error: failure,
      });
    }
    return failure;
  }
}

/** Validates what the admin's form sends for a new channel. Throws ApiError 400. */
export function parseChannelInput(input: {
  name: string;
  kind: string;
  url: string;
  secret?: string;
  events?: string | readonly string[];
  repo?: string;
  scope?: string;
}): Omit<NotificationChannel, "id" | "createdAt" | "enabled"> {
  const name = input.name.trim();
  if (!name || name.length > CHANNEL_NAME_MAX) {
    throw new ApiError(400, `Ponle un nombre al canal (1 a ${CHANNEL_NAME_MAX} caracteres).`);
  }
  if (!CHANNEL_KINDS.includes(input.kind as ChannelKind)) {
    throw new ApiError(400, `Tipo de canal inválido. Usa: ${CHANNEL_KINDS.join(", ")}.`);
  }
  const kind = input.kind as ChannelKind;
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new ApiError(400, "La URL del webhook no es válida.");
  }
  // Slack and Discord only serve their webhooks over https; a generic one may be an internal http service.
  if (url.protocol !== "https:" && !(kind === "webhook" && url.protocol === "http:")) {
    throw new ApiError(400, "La URL del webhook debe empezar con https://.");
  }
  const { repoPattern, scopePattern } = normalizeGrantPatterns(input.repo ?? "", input.scope ?? "");
  return {
    name,
    kind,
    url: url.toString(),
    secret: kind === "webhook" ? input.secret?.trim() || null : null,
    events: parseEvents(input.events),
    repoPattern,
    scopePattern,
  };
}
