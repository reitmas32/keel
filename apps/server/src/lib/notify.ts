import { createHmac } from "node:crypto";
import { type Env, SLACK_TOKEN } from "./env";
import { ApiError } from "./errors";
import { logger } from "./log";
import { defaultMessage, type MessageData, renderMessage, TEMPLATE_MAX } from "./message-template";
import { metrics } from "./metrics";
import { type Dependency, tracedFetch } from "./outbound";
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
type Target = Pick<
  NotificationChannel,
  "name" | "kind" | "url" | "secret" | "target" | "template" | "events" | "repoPattern" | "scopePattern"
>;

/** Where a Slack bot posts. Its channels keep it as their `url`, so every channel has one. */
export const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

/** A Slack channel id (C0123ABCD, G…, D…) or a channel name, with or without its `#`. */
const SLACK_CHANNEL = /^(?:[CGD][A-Z0-9]{6,}|#?[a-z0-9][a-z0-9._-]{0,79})$/;

/** What Slack's `error` codes mean for whoever set the channel up. */
const SLACK_ERRORS: Record<string, string> = {
  not_in_channel: "el bot no está en el canal: invítalo con /invite @<bot>",
  channel_not_found: "Slack no encuentra el canal (usa su id, p. ej. C0123ABCD)",
  is_archived: "el canal está archivado",
  invalid_auth: "el token del bot no es válido",
  not_authed: "el token del bot no es válido",
  token_revoked: "el token del bot fue revocado",
  account_inactive: "el token del bot fue revocado",
  missing_scope: "al bot le falta el scope chat:write",
  ratelimited: "Slack limitó los envíos; reintenta en un momento",
};

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
  // One template for every channel of the environment; empty means keel's own message.
  const template = env.KEEL_NOTIFY_TEMPLATE?.trim() || null;
  const channels: Target[] = [];
  if (env.KEEL_SLACK_WEBHOOK_URL) {
    channels.push({
      ...base,
      name: "env:slack",
      kind: "slack",
      url: env.KEEL_SLACK_WEBHOOK_URL,
      secret: null,
      target: null,
      template,
    });
  }
  if (env.KEEL_SLACK_BOT_TOKEN && env.KEEL_SLACK_CHANNEL) {
    channels.push({
      ...base,
      name: "env:slack-bot",
      kind: "slack_bot",
      url: SLACK_POST_URL,
      secret: env.KEEL_SLACK_BOT_TOKEN,
      target: env.KEEL_SLACK_CHANNEL,
      template,
    });
  }
  if (env.KEEL_DISCORD_WEBHOOK_URL) {
    channels.push({
      ...base,
      name: "env:discord",
      kind: "discord",
      url: env.KEEL_DISCORD_WEBHOOK_URL,
      secret: null,
      target: null,
      template,
    });
  }
  if (env.KEEL_WEBHOOK_URL) {
    channels.push({
      ...base,
      name: "env:webhook",
      kind: "webhook",
      url: env.KEEL_WEBHOOK_URL,
      secret: env.KEEL_WEBHOOK_SECRET ?? null,
      target: null,
      template,
    });
  }
  return channels;
}

const wants = (channel: Target, n: DeployNotification) =>
  (channel.events.includes(ALL_EVENTS) || channel.events.includes(n.event)) &&
  globMatch(channel.repoPattern, n.deploy.repo) &&
  globMatch(channel.scopePattern, n.deploy.scope);

/** One or two lines of plain text, in Spanish, for Slack and Discord: keel's own message. */
export function formatMessage(n: DeployNotification, link?: string): string {
  return defaultMessage(messageData(n, link));
}

/** A notification as the message templates see it. */
const messageData = (n: DeployNotification, link?: string): MessageData => ({
  event: n.event,
  repo: n.deploy.repo,
  tag: n.deploy.tag,
  sha: n.deploy.sha,
  scope: n.deploy.scope,
  error: n.deploy.error,
  requestedBy: n.deploy.requestedBy ?? null,
  actor: n.actor ?? null,
  detail: n.detail ?? null,
  link: link ?? null,
});

function bodyFor(channel: Target, n: DeployNotification, at: string, link?: string): string {
  // The channel's own template, or keel's message when it has none.
  const text = renderMessage(channel.template, messageData(n, link));
  if (channel.kind === "slack") return JSON.stringify({ text });
  if (channel.kind === "slack_bot") return JSON.stringify({ channel: channel.target, text, unfurl_links: false });
  if (channel.kind === "discord") return JSON.stringify({ content: text.slice(0, 2000) });
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
    text: renderMessage(channel.template, messageData(n)),
  });
}

export const signBody = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** Why Slack refused a chat.postMessage, or undefined when it posted it. Never the raw body: it is Slack's, not ours. */
async function slackFailure(response: Response): Promise<string | undefined> {
  let body: { ok?: boolean; error?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return "Slack respondió algo que no es JSON";
  }
  if (body.ok) return undefined;
  const code = String(body.error ?? "error desconocido");
  return SLACK_ERRORS[code] ? `${SLACK_ERRORS[code]} (${code})` : `Slack respondió ${code}`;
}

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
    // The same webhook (or the same Slack channel) configured in both places gets each event once.
    const seen = new Set<string>();
    const targets = [...this.fromEnv, ...saved].filter((c) => {
      const key = c.kind === "slack_bot" ? `slack:${c.target}` : c.url;
      if (!wants(c, n) || seen.has(key)) return false;
      seen.add(key);
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
    if (channel.kind === "slack_bot") {
      headers["content-type"] = "application/json; charset=utf-8";
      headers.authorization = `Bearer ${channel.secret ?? ""}`;
    }
    let failure: string | undefined;
    try {
      // A webhook's URL is a secret: its line shows the masked one.
      const dependency: Dependency = channel.kind === "slack_bot" || channel.kind === "slack" ? "slack" : channel.kind;
      const traced = tracedFetch(dependency, this.options.fetch ?? fetch, () => maskUrl(channel.url));
      const response = await traced(channel.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) failure = `respondió ${response.status}`;
      // Slack's Web API answers 200 with `ok: false` when it refuses the message.
      else if (channel.kind === "slack_bot") failure = await slackFailure(response);
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

/**
 * Validates what the admin's form sends for a channel. Throws ApiError 400. A Slack bot takes its token and channel
 * instead of a URL; any other kind takes a webhook URL.
 */
export function parseChannelInput(input: {
  name: string;
  kind: string;
  url?: string;
  secret?: string;
  /** Slack bots: the bot token (xoxb-…). */
  token?: string;
  /** Slack bots: the channel id or #name. */
  channel?: string;
  /** The message, with `{variables}`; empty means keel's own. */
  template?: string;
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
  const { repoPattern, scopePattern } = normalizeGrantPatterns(input.repo ?? "", input.scope ?? "");
  const template = input.template?.replace(/\r\n/g, "\n").trim() || null;
  if (template && template.length > TEMPLATE_MAX) {
    throw new ApiError(400, `El mensaje personalizado no puede pasar de ${TEMPLATE_MAX} caracteres.`);
  }
  const common = { name, kind, events: parseEvents(input.events), repoPattern, scopePattern, template };

  if (kind === "slack_bot") {
    const token = input.token?.trim() ?? "";
    // Never echo the token in the error: it is a credential.
    if (!SLACK_TOKEN.test(token)) throw new ApiError(400, "El token del bot de Slack debe empezar con xoxb-.");
    const channel = input.channel?.trim() ?? "";
    if (!SLACK_CHANNEL.test(channel)) {
      throw new ApiError(400, "Indica el canal de Slack: su id (p. ej. C0123ABCD) o su nombre (#deploys).");
    }
    return { ...common, url: SLACK_POST_URL, secret: token, target: channel };
  }

  let url: URL;
  try {
    url = new URL(input.url?.trim() ?? "");
  } catch {
    throw new ApiError(400, "La URL del webhook no es válida.");
  }
  // Slack and Discord only serve their webhooks over https; a generic one may be an internal http service.
  if (url.protocol !== "https:" && !(kind === "webhook" && url.protocol === "http:")) {
    throw new ApiError(400, "La URL del webhook debe empezar con https://.");
  }
  return {
    ...common,
    url: url.toString(),
    secret: kind === "webhook" ? input.secret?.trim() || null : null,
    target: null,
  };
}
