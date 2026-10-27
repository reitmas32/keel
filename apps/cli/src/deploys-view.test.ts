import type { Deploy, DeployDetail } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { formatDuration, formatWhen, renderDeployDetail, renderDeployList } from "./deploys-view.js";

const TZ = "America/Mexico_City"; // UTC-6
const now = new Date("2026-10-27T20:54:10Z"); // 14:54:10 local
const view = { now, timeZone: TZ, color: false };

/** Local time in Mexico City as an ISO instant. */
const at = (local: string) => new Date(`${local}-06:00`).toISOString();

const base: Omit<Deploy, "id" | "tag" | "service" | "status" | "createdAt" | "updatedAt"> = {
  repo: "jalocompany/jalo-api",
  sha: "7e41c0a1b2c3d4e5f60718293a4b5c6d7e8f9012",
  error: null,
  ciPassedAt: null,
  deployStartedAt: null,
  finishedAt: null,
};

const deploys: Deploy[] = [
  {
    ...base,
    id: "a1b2c3d4-0000-4000-8000-000000000001",
    tag: "v1.4.0",
    service: "staging",
    status: "deploying",
    createdAt: at("2026-10-27T14:52:00"),
    updatedAt: at("2026-10-27T14:53:00"),
    ciPassedAt: at("2026-10-27T14:52:50"),
    deployStartedAt: at("2026-10-27T14:52:55"),
  },
  {
    ...base,
    id: "b2c3d4e5-0000-4000-8000-000000000002",
    tag: "v1.3.2",
    service: "production",
    status: "deployed",
    createdAt: at("2026-10-27T11:03:00"),
    updatedAt: at("2026-10-27T11:09:12"),
    finishedAt: at("2026-10-27T11:09:12"),
  },
  {
    ...base,
    id: "d3f1a9c2-0000-4000-8000-000000000003",
    tag: "v1.3.1",
    service: "staging",
    status: "deploy_failed",
    error: "pull access denied for registry.jalocompany.tech/jalo-api",
    createdAt: at("2026-10-26T12:15:02"),
    updatedAt: at("2026-10-26T12:21:31"),
    ciPassedAt: at("2026-10-26T12:18:40"),
    deployStartedAt: at("2026-10-26T12:18:43"),
    finishedAt: at("2026-10-26T12:21:31"),
  },
  {
    ...base,
    id: "e4f5a6b7-0000-4000-8000-000000000004",
    tag: "v1.2.9",
    service: "staging",
    status: "expired",
    error: "No llegó el resultado del CI en 60 min.",
    createdAt: at("2026-10-24T09:30:00"),
    updatedAt: at("2026-10-24T10:30:00"),
    finishedAt: at("2026-10-24T10:30:00"),
  },
];

const header = {
  repo: "jalocompany/jalo-api",
  org: "github.com:jalocompany",
  apiUrl: "http://keel.jalocompany.internal/api",
};

describe("formatWhen", () => {
  it("says hoy / ayer / the date, in the given time zone", () => {
    expect(formatWhen(at("2026-10-27T14:52:00"), view)).toBe("hoy 14:52");
    expect(formatWhen(at("2026-10-26T18:40:00"), view)).toBe("ayer 18:40");
    expect(formatWhen(at("2026-10-25T10:02:00"), view)).toBe("25 oct 10:02");
    expect(formatWhen(at("2025-12-31T23:59:00"), view)).toBe("31 dic 2025 23:59");
    expect(formatWhen(at("2026-10-26T12:15:02"), view, true)).toBe("ayer 12:15:02");
  });

  it("uses the local day, not the UTC one", () => {
    // 23:30 local on the 26th is already the 27th in UTC.
    expect(formatWhen(at("2026-10-26T23:30:00"), view)).toBe("ayer 23:30");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [372_000, "6m 12s"],
    [3_600_000, "1h 00m"],
    [7_500_000, "2h 05m"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("renderDeployList", () => {
  it("renders the table, failure reasons and the summary", () => {
    expect(renderDeployList(header, deploys, view)).toBe(
      [
        "◇  jalocompany/jalo-api · github.com:jalocompany · http://keel.jalocompany.internal/api",
        "",
        "  VERSIÓN   SERVICIO     ESTADO              PEDIDO         TERMINÓ        DURACIÓN   ID",
        "  v1.4.0    staging      ● en curso          hoy 14:52      —              2m 10s…    a1b2c3d4",
        "  v1.3.2    production   ✔ desplegado        hoy 11:03      hoy 11:09      6m 12s     b2c3d4e5",
        "  v1.3.1    staging      ✖ falló el deploy   ayer 12:15     ayer 12:21     6m 29s     d3f1a9c2",
        "            └ pull access denied for registry.jalocompany.tech/jalo-api",
        "  v1.2.9    staging      ◷ expirado          24 oct 09:30   24 oct 10:30   1h 00m     e4f5a6b7",
        "            └ No llegó el resultado del CI en 60 min.",
        "",
        "  4 deploys · 1 ✔ · 1 ✖ · 1 ◷ · 1 en curso",
      ].join("\n"),
    );
  });

  it("falls back to updatedAt for finished deploys from servers without finishedAt", () => {
    const old = { ...deploys[1], finishedAt: undefined } as Deploy;
    expect(renderDeployList(header, [old], view)).toContain("hoy 11:09   6m 12s");
  });

  it("explains an empty list", () => {
    expect(renderDeployList(header, [], view)).toContain("Todavía no hay deploys. Crea uno con `keel deploy`.");
    expect(renderDeployList(header, [], { ...view, service: "staging" })).toContain("No hay deploys de staging");
  });

  it("adds ANSI colors only when asked", () => {
    expect(renderDeployList(header, deploys, view)).not.toContain("\u001b[");
    expect(renderDeployList(header, deploys, { ...view, color: true })).toContain("\u001b[");
  });
});

describe("renderDeployDetail", () => {
  const failed: DeployDetail = {
    ...(deploys[2] as Deploy),
    serviceKind: "compose",
    tagVariable: "DOCKER_TAG",
  };

  it("shows the fields and the timeline of a failed deploy", () => {
    expect(renderDeployDetail(failed, view)).toBe(
      [
        "◇  Deploy d3f1a9c2 · jalocompany/jalo-api",
        "",
        "  Versión     v1.3.1  (commit 7e41c0a)",
        "  Servicio    staging  (Compose, DOCKER_TAG)",
        "  Estado      ✖ falló el deploy",
        "  Error       pull access denied for registry.jalocompany.tech/jalo-api",
        "",
        "  ✔ Pedido             ayer 12:15:02",
        "  ✔ CI aprobado        ayer 12:18:40   (3m 38s esperando la Action)",
        "  ✔ Enviado a Dokploy  ayer 12:18:43",
        "  ✖ Terminó            ayer 12:21:31   (2m 48s en Dokploy)",
      ].join("\n"),
    );
  });

  it("says when the CI had already passed and shows a deploy still in Dokploy", () => {
    const running: DeployDetail = {
      ...(deploys[0] as Deploy),
      ciPassedAt: (deploys[0] as Deploy).createdAt,
      serviceKind: "application",
      tagVariable: null,
    };
    const text = renderDeployDetail(running, view);
    expect(text).toContain("staging  (Application)");
    expect(text).toContain("(el CI ya había pasado)");
    expect(text).toContain("● En Dokploy         desde hace 1m 15s");
  });

  it("shows a deploy still waiting for the CI", () => {
    const waiting: DeployDetail = {
      ...(deploys[0] as Deploy),
      status: "waiting_ci",
      ciPassedAt: null,
      deployStartedAt: null,
      serviceKind: "compose",
      tagVariable: "DOCKER_TAG",
    };
    expect(renderDeployDetail(waiting, view)).toContain("◌ Esperando CI       desde hace 2m 10s");
  });
});
