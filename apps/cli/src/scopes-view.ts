import { type Deploy, isTerminal, type ServiceSummary } from "@keel/shared";
import { createColors } from "picocolors";
import { finishedAt, formatDuration, formatWhen, STATUS, type ViewOptions } from "./deploys-view.js";

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - [...text].length));
const elapsed = (from: string, to: string | Date) =>
  (typeof to === "string" ? Date.parse(to) : to.getTime()) - Date.parse(from);

function kindLabel(s: ServiceSummary): string {
  if (s.kind === "application") return "Application";
  if (s.kind === "compose")
    return s.tagVariable && s.tagVariable !== "DOCKER_TAG" ? `Compose (${s.tagVariable})` : "Compose";
  return "—";
}

/** `✔ hoy 16:04 · 1m 02s` when the last deploy is the current version, else what that last deploy did. */
function lastDeployCell(s: ServiceSummary, options: ViewOptions): string {
  const last = s.last;
  if (!last) return "sin deploys";
  const style = STATUS[last.status];
  const end = finishedAt(last);
  if (!isTerminal(last.status)) {
    return `${style.icon} ${last.tag} ${style.label} · hace ${formatDuration(elapsed(last.createdAt, options.now))}`;
  }
  const when = formatWhen(end ?? last.updatedAt, options);
  if (last.id === s.current?.id)
    return `${style.icon} ${when} · ${formatDuration(elapsed(last.createdAt, end ?? last.updatedAt))}`;
  return `${style.icon} ${last.tag} ${style.label} · ${when}`;
}

/** Whether a server older than v0.5.0 sent only the aliases. */
const isLegacy = (services: ServiceSummary[]) => services.every((s) => s.kind === undefined);

export function renderScopes(
  header: { repo: string; org: string; apiUrl: string },
  services: ServiceSummary[],
  options: ViewOptions,
): string {
  const c = createColors(options.color);
  const lines = [`${c.cyan("◇")}  ${c.bold(header.repo)} · ${header.org} · ${c.dim(header.apiUrl)}`, ""];
  const indent = "  ";

  if (services.length === 0) {
    lines.push(`${indent}${header.repo} no tiene scopes vinculados. Agrégalos en el admin de keel.`);
    return lines.join("\n");
  }

  if (isLegacy(services)) {
    lines.push(`${indent}${c.dim("SCOPE")}`, ...services.map((s) => `${indent}${s.alias}`), "");
    lines.push(`${indent}${c.yellow("▲")} Tu servidor de keel es anterior a v0.5.0: solo muestra los nombres.`);
    return lines.join("\n");
  }

  const rows = services.map((s) => ({
    service: s,
    cells: [
      s.alias,
      s.dokployName ?? s.dokployId ?? "—",
      kindLabel(s),
      s.current?.tag ?? "—",
      lastDeployCell(s, options),
    ],
  }));
  const titles = ["SCOPE", "DOKPLOY", "TIPO", "VERSIÓN ACTUAL", "ÚLTIMO DEPLOY"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((r) => [...(r.cells[i] ?? "")].length)));
  const gap = "   ";
  const failed = (d: Deploy | null | undefined) =>
    Boolean(d?.error) && (d?.status === "ci_failed" || d?.status === "deploy_failed" || d?.status === "expired");

  lines.push(indent + c.dim(titles.map((t, i) => padEnd(t, widths[i] ?? 0)).join(gap)).trimEnd());
  for (const { service, cells } of rows) {
    const painted = cells.map((cell, i) => {
      const padded = padEnd(cell, widths[i] ?? 0);
      if (i === 4 && service.last) return STATUS[service.last.status].paint(c)(padded);
      if (i === 1 && !service.dokployName) return c.dim(padded);
      return padded;
    });
    lines.push((indent + painted.join(gap)).trimEnd());
    if (failed(service.last)) {
      const offset = widths.slice(0, 4).reduce((sum, w) => sum + w + gap.length, 0);
      lines.push(`${indent}${" ".repeat(offset)}${c.dim(`└ ${service.last?.error}`)}`);
    }
  }

  lines.push(
    "",
    `${indent}${services.length} ${services.length === 1 ? "scope" : "scopes"} · despliega con \`keel deploy -s <scope> -v <versión>\``,
  );
  return lines.join("\n");
}
