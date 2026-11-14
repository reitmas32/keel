// The text keel posts to Slack and Discord, and how a channel's own template changes it. No server-only imports:
// the admin's drawer renders the same preview the notifier will send.

export const MESSAGE_EVENTS = [
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
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

/** What a message can say about a deploy. */
export interface MessageData {
  event: MessageEvent;
  repo: string;
  tag: string;
  sha: string;
  scope: string;
  error: string | null;
  requestedBy: string | null;
  actor: string | null;
  detail: string | null;
  link: string | null;
}

export const TEMPLATE_MAX = 1000;

const ICONS: Record<MessageEvent, string> = {
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

/** The event in a few words, for `{event}`. */
const EVENT_WORDS: Record<MessageEvent, string> = {
  "deploy.deployed": "desplegado",
  "deploy.failed": "falló",
  "deploy.ci_failed": "CI falló",
  "deploy.expired": "expiró",
  "deploy.rollback": "rollback automático",
  "deploy.approval_requested": "espera aprobación",
  "deploy.approved": "aprobado",
  "deploy.rejected": "rechazado",
  "deploy.forced": "deploy forzoso",
};

const isFailure = (e: MessageEvent) => e === "deploy.failed" || e === "deploy.expired" || e === "deploy.ci_failed";

/** keel's own message: one or two lines of plain text, in Spanish. */
export function defaultMessage(d: MessageData): string {
  const where = `${d.repo} ${d.tag} → ${d.scope}`;
  const by = d.requestedBy ? ` (pedido por ${d.requestedBy})` : "";
  const headline: Record<MessageEvent, string> = {
    "deploy.deployed": `${where} desplegado${by}`,
    "deploy.failed": `${where} falló${by}`,
    "deploy.ci_failed": `${where}: el CI falló, no se despliega${by}`,
    "deploy.expired": `${where} expiró${by}`,
    "deploy.rollback": `${where}: rollback automático`,
    "deploy.approval_requested": `${where} espera aprobación${by}`,
    "deploy.approved": `${where} aprobado por ${d.actor ?? "alguien"}`,
    "deploy.rejected": `${where} rechazado por ${d.actor ?? "alguien"}`,
    "deploy.forced": `${where}: deploy forzoso durante una ventana de congelamiento, por ${d.actor ?? "alguien"}`,
  };
  const lines = [`${ICONS[d.event]} ${headline[d.event]}`];
  if (isFailure(d.event) && d.error) lines.push(d.error);
  if (d.detail) lines.push(d.detail);
  if (d.link) lines.push(d.link);
  return lines.join("\n");
}

/** The variables a template can use, with what each one means, for the admin's hint. */
export const TEMPLATE_VARIABLES: { name: string; label: string }[] = [
  { name: "icon", label: "✅ ❌ ✋… según el evento" },
  { name: "event", label: "desplegado, falló, espera aprobación…" },
  { name: "repo", label: "el repo" },
  { name: "tag", label: "la versión" },
  { name: "scope", label: "el scope" },
  { name: "sha", label: "el commit (7 caracteres)" },
  { name: "by", label: "quién lo pidió" },
  { name: "actor", label: "quién aprobó, rechazó o forzó" },
  { name: "error", label: "por qué falló" },
  { name: "detail", label: "un motivo o nota extra" },
  { name: "link", label: "el deploy en el admin" },
  { name: "message", label: "el mensaje de siempre, completo" },
];

/**
 * A channel's message from its template: `{name}` is replaced by the variable of that name (empty when the event
 * has no value for it), unknown names stay as written, and a line that ends up empty is dropped. Without a template,
 * keel's own message.
 */
export function renderMessage(template: string | null | undefined, d: MessageData): string {
  if (!template?.trim()) return defaultMessage(d);
  const values: Record<string, string> = {
    icon: ICONS[d.event],
    event: EVENT_WORDS[d.event],
    repo: d.repo,
    tag: d.tag,
    scope: d.scope,
    sha: d.sha.slice(0, 7),
    by: d.requestedBy ?? "",
    actor: d.actor ?? "",
    error: d.error ?? "",
    detail: d.detail ?? "",
    link: d.link ?? "",
    message: defaultMessage(d),
  };
  return template
    .replace(/\{([a-z]+)\}/g, (whole, name: string) => (name in values ? (values[name] as string) : whole))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}

/** A failed deploy to preview a template with. */
export const SAMPLE_MESSAGE: MessageData = {
  event: "deploy.failed",
  repo: "fundathyon/core-api",
  tag: "v2.4.1",
  sha: "3f9c2a1b7e",
  scope: "api-prod",
  error: "El health check respondió 503.",
  requestedBy: "rafa",
  actor: null,
  detail: null,
  link: "https://keel.example.com/apps/…/deploys",
};
