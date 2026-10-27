import { type Deploy, type DeployDetail, type DeployStatus, isTerminal } from "@keel/shared";
import { createColors } from "picocolors";

type Colors = ReturnType<typeof createColors>;
type Paint = (text: string) => string;

export interface ViewOptions {
  now: Date;
  /** IANA time zone for dates; defaults to the machine's. */
  timeZone?: string;
  color: boolean;
}

interface StatusStyle {
  icon: string;
  label: string;
  paint: (c: Colors) => Paint;
}

// Every icon is one terminal column wide so the table stays aligned.
export const STATUS: Record<DeployStatus, StatusStyle> = {
  waiting_ci: { icon: "◌", label: "esperando CI", paint: (c) => c.gray },
  ci_passed: { icon: "◌", label: "CI ok, en cola", paint: (c) => c.blue },
  deploying: { icon: "●", label: "en curso", paint: (c) => c.yellow },
  deployed: { icon: "✔", label: "desplegado", paint: (c) => c.green },
  ci_failed: { icon: "✖", label: "falló el CI", paint: (c) => c.red },
  deploy_failed: { icon: "✖", label: "falló el deploy", paint: (c) => c.red },
  expired: { icon: "◷", label: "expirado", paint: (c) => c.gray },
};

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a date in the given time zone, to compare calendar days. */
function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** `hoy 14:52`, `ayer 18:40`, `25 oct 10:02`, or with the year when it isn't the current one. */
export function formatWhen(iso: string, { now, timeZone }: ViewOptions, withSeconds = false): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds && { second: "2-digit" }),
    hourCycle: "h23",
  }).format(date);
  const day = dayKey(date, timeZone);
  if (day === dayKey(now, timeZone)) return `hoy ${time}`;
  if (day === dayKey(new Date(now.getTime() - DAY_MS), timeZone)) return `ayer ${time}`;
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const date_ = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    day: "numeric",
    month: "short",
    ...(!sameYear && { year: "numeric" }),
  })
    .format(date)
    .replace(".", "");
  return `${date_} ${time}`;
}

/** `45s`, `6m 12s`, `2h 05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** When the deploy reached its final state; servers before v0.3.0 only tell it through `updatedAt`. */
export const finishedAt = (d: Deploy): string | null => d.finishedAt ?? (isTerminal(d.status) ? d.updatedAt : null);

const elapsed = (from: string, to: string | Date) =>
  (typeof to === "string" ? Date.parse(to) : to.getTime()) - Date.parse(from);

const shortId = (id: string) => id.slice(0, 8);

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - [...text].length));

export function renderDeployList(
  header: { repo: string; org: string; apiUrl: string },
  deploys: Deploy[],
  options: ViewOptions & { service?: string },
): string {
  const c = createColors(options.color);
  const lines = [`${c.cyan("◇")}  ${c.bold(header.repo)} · ${header.org} · ${c.dim(header.apiUrl)}`, ""];

  if (deploys.length === 0) {
    lines.push(
      options.service
        ? `  No hay deploys de ${options.service} todavía.`
        : "  Todavía no hay deploys. Crea uno con `keel deploy`.",
    );
    return lines.join("\n");
  }

  const rows = deploys.map((d) => {
    const end = finishedAt(d);
    const style = STATUS[d.status];
    return {
      deploy: d,
      style,
      cells: [
        d.tag,
        d.service,
        `${style.icon} ${style.label}`,
        formatWhen(d.createdAt, options),
        end ? formatWhen(end, options) : "—",
        end ? formatDuration(elapsed(d.createdAt, end)) : `${formatDuration(elapsed(d.createdAt, options.now))}…`,
        shortId(d.id),
      ],
    };
  });

  const titles = ["VERSIÓN", "SERVICIO", "ESTADO", "PEDIDO", "TERMINÓ", "DURACIÓN", "ID"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((r) => [...(r.cells[i] ?? "")].length)));
  const indent = "  ";
  const gap = "   ";

  lines.push(indent + c.dim(titles.map((t, i) => padEnd(t, widths[i] ?? 0)).join(gap)).trimEnd());
  for (const { deploy, style, cells } of rows) {
    const painted = cells.map((cell, i) => {
      const padded = padEnd(cell, widths[i] ?? 0);
      if (i === 2) return style.paint(c)(padded);
      if (i === 6) return c.dim(padded);
      return padded;
    });
    lines.push((indent + painted.join(gap)).trimEnd());
    if (
      deploy.error &&
      (deploy.status === "ci_failed" || deploy.status === "deploy_failed" || deploy.status === "expired")
    ) {
      lines.push(`${indent}${" ".repeat(widths[0] ?? 0)}${gap}${c.dim(`└ ${deploy.error}`)}`);
    }
  }

  lines.push("", `${indent}${summary(deploys, c)}`);
  return lines.join("\n");
}

function summary(deploys: Deploy[], c: Colors): string {
  const count = (statuses: DeployStatus[]) => deploys.filter((d) => statuses.includes(d.status)).length;
  const parts = [
    `${deploys.length} deploy${deploys.length === 1 ? "" : "s"}`,
    [count(["deployed"]), c.green("✔")],
    [count(["ci_failed", "deploy_failed"]), c.red("✖")],
    [count(["expired"]), c.gray("◷")],
    [count(["waiting_ci", "ci_passed", "deploying"]), "en curso"],
  ];
  return parts
    .filter((p) => typeof p === "string" || p[0] !== 0)
    .map((p) => (typeof p === "string" ? p : `${p[0]} ${p[1]}`))
    .join(" · ");
}

export function renderDeployDetail(d: DeployDetail, options: ViewOptions): string {
  const c = createColors(options.color);
  const style = STATUS[d.status];
  const when = (iso: string) => formatWhen(iso, options, true);
  const end = finishedAt(d);

  const service =
    d.serviceKind === "compose"
      ? `${d.service}  (Compose, ${d.tagVariable ?? "DOCKER_TAG"})`
      : d.serviceKind === "application"
        ? `${d.service}  (Application)`
        : d.service;

  const fields: [string, string][] = [
    ["Versión", `${d.tag}  (commit ${d.sha.slice(0, 7)})`],
    ["Servicio", service],
    ["Estado", style.paint(c)(`${style.icon} ${style.label}`)],
  ];
  if (d.error) fields.push(["Error", d.error]);

  const lines = [`${c.cyan("◇")}  Deploy ${c.bold(shortId(d.id))} · ${d.repo}`, ""];
  for (const [label, value] of fields) lines.push(`  ${padEnd(label, 11)} ${value}`);
  lines.push("");

  const step = (icon: string, paint: Paint, label: string, at: string, note?: string) =>
    lines.push(`  ${paint(icon)} ${padEnd(label, 18)} ${when(at)}${note ? c.dim(`   (${note})`) : ""}`);
  const pending = (label: string, note: string) => lines.push(`  ${c.gray("◌")} ${padEnd(label, 18)} ${c.dim(note)}`);

  step("✔", c.green, "Pedido", d.createdAt);

  if (d.ciPassedAt) {
    const waited = elapsed(d.createdAt, d.ciPassedAt);
    step(
      "✔",
      c.green,
      "CI aprobado",
      d.ciPassedAt,
      waited < 1000 ? "el CI ya había pasado" : `${formatDuration(waited)} esperando la Action`,
    );
  } else if (d.status === "ci_failed" && end) {
    step("✖", c.red, "CI falló", end, `${formatDuration(elapsed(d.createdAt, end))} esperando la Action`);
  } else if (d.status === "expired" && end) {
    step("◷", c.gray, "Expiró sin CI", end, `${formatDuration(elapsed(d.createdAt, end))} esperando la Action`);
  } else if (d.status === "waiting_ci") {
    pending("Esperando CI", `desde hace ${formatDuration(elapsed(d.createdAt, options.now))}`);
  }

  if (d.deployStartedAt) {
    step("✔", c.green, "Enviado a Dokploy", d.deployStartedAt);
    if (d.status === "deploying") {
      lines.push(
        `  ${c.yellow("●")} ${padEnd("En Dokploy", 18)} ${c.dim(`desde hace ${formatDuration(elapsed(d.deployStartedAt, options.now))}`)}`,
      );
    } else if (end && (d.status === "deployed" || d.status === "deploy_failed")) {
      const ok = d.status === "deployed";
      step(
        ok ? "✔" : "✖",
        ok ? c.green : c.red,
        "Terminó",
        end,
        `${formatDuration(elapsed(d.deployStartedAt, end))} en Dokploy`,
      );
    }
  } else if (d.status === "ci_passed") {
    pending("En cola", "esperando su turno para Dokploy");
  }

  return lines.join("\n");
}
