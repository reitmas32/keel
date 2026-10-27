import type { ServiceSummary } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { renderScopes } from "./scopes-view.js";
import { pastDeploy } from "./testing/fake-keel.js";

const view = { now: new Date("2026-10-27T22:00:00Z"), color: false, timeZone: "America/Mexico_City" };
const header = {
  repo: "jalocompany/jalo-web",
  org: "github.com:jalocompany",
  apiUrl: "http://keel.jalocompany.internal/api",
};

const service = (alias: string, dokployName: string | null, overrides: Partial<ServiceSummary> = {}) => ({
  alias,
  kind: "compose" as const,
  tagVariable: "DOCKER_TAG",
  dokployId: `${alias}-id`,
  dokployUrl: `http://dokploy/services/compose/${alias}-id`,
  dokployName,
  current: null,
  last: null,
  ...overrides,
});

describe("scopes view", () => {
  it("shows each scope's Dokploy service, current version and last deploy", () => {
    const deployed = pastDeploy("p1", "v0.1.2", "prod", "2026-10-27T22:03:00Z".replace("22:03", "21:58"));
    const out = renderScopes(
      header,
      [service("prod", "DEV/production/jalo-web", { current: deployed, last: deployed })],
      view,
    );

    expect(out).toContain("SCOPE   DOKPLOY                   TIPO      VERSIÓN ACTUAL   ÚLTIMO DEPLOY");
    expect(out).toMatch(/prod +DEV\/production\/jalo-web +Compose +v0\.1\.2 +✔ hoy 15:59 · 1m 02s/);
    expect(out).toContain("1 scope · despliega con `keel deploy -s <scope> -v <versión>`");
  });

  it("shows a deploy in flight and a failed one with its reason", () => {
    const current = pastDeploy("s1", "v0.1.3", "stg", "2026-10-27T20:00:00Z");
    const out = renderScopes(
      header,
      [
        service("prod", "DEV/production/jalo-web", {
          current: pastDeploy("p1", "v0.1.2", "prod", "2026-10-27T19:00:00Z"),
          last: pastDeploy("p2", "v0.1.3", "prod", "2026-10-27T21:59:20Z", { status: "deploying", finishedAt: null }),
        }),
        service("stg", null, {
          tagVariable: "WEB_TAG",
          current,
          last: pastDeploy("s2", "v0.1.4", "stg", "2026-10-27T21:10:00Z", {
            status: "ci_failed",
            error: "El CI de v0.1.4 terminó con failure.",
          }),
        }),
      ],
      view,
    );

    expect(out).toMatch(/prod +DEV\/production\/jalo-web +Compose +v0\.1\.2 +● v0\.1\.3 en curso · hace 40s/);
    expect(out).toMatch(/stg +stg-id +Compose \(WEB_TAG\) +v0\.1\.3 +✖ v0\.1\.4 falló el CI · hoy 15:11/);
    expect(out).toContain("└ El CI de v0.1.4 terminó con failure.");
    expect(out).toContain("2 scopes");
  });

  it("falls back to the aliases with a server older than v0.5.0", () => {
    const out = renderScopes(header, [{ alias: "prod" }, { alias: "stg" }], view);
    expect(out).toContain("  SCOPE\n  prod\n  stg");
    expect(out).toContain("anterior a v0.5.0");
  });

  it("says so when the repo has no scopes", () => {
    expect(renderScopes(header, [], view)).toContain("no tiene scopes vinculados");
  });
});
