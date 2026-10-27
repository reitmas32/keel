import { describe, expect, it } from "vitest";
import { knownVersion } from "./testing/fake-keel.js";
import { describeVersion, latestReady, renderVersionList } from "./versions-view.js";

const view = { now: new Date("2026-10-27T18:00:00Z"), color: false, timeZone: "America/Mexico_City" };
const header = {
  repo: "jalocompany/jalo-api",
  org: "github.com:jalocompany",
  apiUrl: "http://keel.jalocompany.internal/api",
};

describe("versions view", () => {
  it("describes the version a deploy picked", () => {
    const v = knownVersion("v1.5.0", "abc1234", {
      createdByName: "Ana",
      createdAt: "2026-10-27T17:52:00Z",
      branch: "hotfix/login",
      ciStatus: "pending",
    });
    expect(describeVersion(v, view)).toBe("v1.5.0 · creada por Ana hoy 11:52 desde hotfix/login · CI en curso");
    expect(describeVersion({ ...v, createdByName: null, createdByEmail: null, branch: null }, view)).toBe(
      "v1.5.0 · creada hoy 11:52 · CI en curso",
    );
  });

  it("picks the highest green version, not the newest", () => {
    const versions = [
      knownVersion("v1.2.0", "a", { createdAt: "2026-10-27T17:00:00Z" }),
      knownVersion("v1.10.0", "b", { createdAt: "2026-10-27T10:00:00Z" }),
      knownVersion("v2.0.0", "c", { ciStatus: "failure" }),
    ];
    expect(latestReady(versions)?.tag).toBe("v1.10.0");
    expect(latestReady([knownVersion("v1.0.0", "a", { ciStatus: "expired" })])).toBeUndefined();
  });

  it("renders a table with branch, author, CI and its duration, and the run of failed versions", () => {
    const out = renderVersionList(
      header,
      [
        knownVersion("v0.2.2", "a", {
          createdByName: "Ana",
          branch: "main",
          createdAt: "2026-10-27T17:58:00Z",
          ciStatus: "pending",
          ciFinishedAt: null,
        }),
        knownVersion("v0.2.1", "b", {
          createdByName: null,
          createdByEmail: null,
          branch: null,
          createdAt: "2026-10-27T15:00:00Z",
          ciStatus: "failure",
          ciFinishedAt: "2026-10-27T15:06:12Z",
          runUrl: "https://github.com/jalocompany/jalo-api/actions/runs/9",
        }),
        knownVersion("v0.2.0", "c", { createdAt: "2026-10-26T15:00:00Z", ciFinishedAt: "2026-10-26T15:04:30Z" }),
      ],
      view,
    );
    expect(out).toContain("VERSIÓN   RAMA   CREADA POR   CREADA");
    expect(out).toMatch(/v0\.2\.2 +main +Ana +hoy 11:58 +◌ CI en curso +2m 00s…/);
    expect(out).toMatch(/v0\.2\.1 +— +— +hoy 09:00 +✖ CI falló +6m 12s/);
    expect(out).toContain("└ https://github.com/jalocompany/jalo-api/actions/runs/9");
    expect(out).toMatch(/v0\.2\.0 +main +keel test +ayer 09:00 +✔ CI ok +4m 30s/);
    expect(out).toContain("3 versiones · última lista para desplegar: v0.2.0");
  });

  it("says so when there are no versions", () => {
    expect(renderVersionList(header, [], view)).toContain("Todavía no hay versiones registradas");
  });
});
