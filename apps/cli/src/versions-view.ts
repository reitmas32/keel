import type { Version, VersionCiStatus } from "@keel/shared";
import { createColors } from "picocolors";
import { formatDuration, formatWhen, type ViewOptions } from "./deploys-view.js";
import { compareSemverDesc, isSemverTag } from "./semver.js";

type Colors = ReturnType<typeof createColors>;
type Paint = (text: string) => string;

// Every icon is one terminal column wide so the table stays aligned.
const CI_STATUS: Record<VersionCiStatus, { icon: string; label: string; paint: (c: Colors) => Paint }> = {
  pending: { icon: "◌", label: "CI en curso", paint: (c) => c.yellow },
  success: { icon: "✔", label: "CI ok", paint: (c) => c.green },
  failure: { icon: "✖", label: "CI falló", paint: (c) => c.red },
  cancelled: { icon: "✖", label: "CI cancelado", paint: (c) => c.red },
  expired: { icon: "◷", label: "sin resultado del CI", paint: (c) => c.gray },
};

const padEnd = (text: string, width: number) => text + " ".repeat(Math.max(0, width - [...text].length));

const author = (v: Version) => v.createdByName ?? v.createdByEmail ?? null;

/** The highest semver version whose CI passed. */
export function latestReady(versions: Version[]): Version | undefined {
  return versions
    .filter((v) => v.ciStatus === "success" && isSemverTag(v.tag))
    .sort((a, b) => compareSemverDesc(a.tag, b.tag))[0];
}

/** `v1.5.0 · creada por Ana hoy 14:52 desde main · CI en curso`, for `keel deploy` to say what it picked. */
export function describeVersion(v: Version, options: ViewOptions): string {
  const who = author(v);
  const parts = [
    v.tag,
    `${who ? `creada por ${who} ` : "creada "}${formatWhen(v.createdAt, options)}${v.branch ? ` desde ${v.branch}` : ""}`,
    CI_STATUS[v.ciStatus].label,
  ];
  return parts.join(" · ");
}

export function renderVersionList(
  header: { repo: string; org: string; apiUrl: string },
  versions: Version[],
  options: ViewOptions,
): string {
  const c = createColors(options.color);
  const lines = [`${c.cyan("◇")}  ${c.bold(header.repo)} · ${header.org} · ${c.dim(header.apiUrl)}`, ""];

  if (versions.length === 0) {
    lines.push("  Todavía no hay versiones registradas. Crea una con `keel create-version`.");
    return lines.join("\n");
  }

  const rows = versions.map((v) => {
    const style = CI_STATUS[v.ciStatus];
    const ciTime = v.ciFinishedAt
      ? formatDuration(Date.parse(v.ciFinishedAt) - Date.parse(v.createdAt))
      : v.ciStatus === "pending"
        ? `${formatDuration(options.now.getTime() - Date.parse(v.createdAt))}…`
        : "—";
    return {
      version: v,
      style,
      cells: [
        v.tag,
        v.branch ?? "—",
        author(v) ?? "—",
        formatWhen(v.createdAt, options),
        `${style.icon} ${style.label}`,
        ciTime,
      ],
    };
  });

  const titles = ["VERSIÓN", "RAMA", "CREADA POR", "CREADA", "CI", "DURACIÓN DEL CI"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((r) => [...(r.cells[i] ?? "")].length)));
  const indent = "  ";
  const gap = "   ";

  lines.push(indent + c.dim(titles.map((t, i) => padEnd(t, widths[i] ?? 0)).join(gap)).trimEnd());
  for (const { version, style, cells } of rows) {
    const painted = cells.map((cell, i) => {
      const padded = padEnd(cell, widths[i] ?? 0);
      if (i === 4) return style.paint(c)(padded);
      return padded;
    });
    lines.push((indent + painted.join(gap)).trimEnd());
    if (version.runUrl && version.ciStatus !== "success") {
      lines.push(`${indent}${" ".repeat(widths[0] ?? 0)}${gap}${c.dim(`└ ${version.runUrl}`)}`);
    }
  }

  // The same version `keel deploy --latest-ready` would pick: the highest one with a green CI.
  const ready = latestReady(versions);
  lines.push(
    "",
    `${indent}${versions.length} ${versions.length === 1 ? "versión" : "versiones"}${ready ? ` · última lista para desplegar: ${ready.tag}` : " · ninguna con el CI en verde"}`,
  );
  return lines.join("\n");
}
