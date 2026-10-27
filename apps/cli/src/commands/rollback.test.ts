import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeKeel, type FakeKeel, pastDeploy } from "../testing/fake-keel.js";
import { createGitFixture, type GitFixture } from "../testing/git-fixture.js";
import { rollback } from "./rollback.js";

let fx: GitFixture;
let keel: FakeKeel;

const now = new Date("2026-10-27T18:00:00Z");
const run = (opts: Parameters<typeof rollback>[0]) =>
  rollback({ cwd: fx.work, home: fx.home, fetch: keel.fetch, now, timeZone: "America/Mexico_City", ...opts });
const deployRequest = () => keel.requests.find((r) => r.method === "POST" && r.path === "/deploys");

beforeEach(async () => {
  fx = await createGitFixture();
  keel = createFakeKeel();
  // api-prod history, newest first: v1.2.0 now, a failed v1.3.0 before it, v1.1.0 and v1.0.0 earlier.
  keel.deploys = [
    pastDeploy("d4", "v1.2.0", "api-prod", "2026-10-27T16:00:00Z"),
    pastDeploy("d3", "v1.3.0", "api-prod", "2026-10-27T15:00:00Z", { status: "deploy_failed", error: "boom" }),
    pastDeploy("d2", "v1.1.0", "api-prod", "2026-10-26T15:00:00Z"),
    pastDeploy("d1", "v1.0.0", "api-prod", "2026-10-25T15:00:00Z"),
    pastDeploy("w1", "v0.9.0", "worker", "2026-10-20T15:00:00Z"),
  ];
});

afterEach(async () => {
  await fx.cleanup();
});

describe("rollback", () => {
  it("goes back to the previous version that service deployed, skipping failed ones", async () => {
    const result = await run({ service: "api-prod", yes: true });

    expect(result).toMatchObject({ service: "api-prod", from: { tag: "v1.2.0" }, to: { tag: "v1.1.0" } });
    expect(deployRequest()?.body).toEqual({
      repo: "konectus-io/app",
      tag: "v1.1.0",
      sha: keel.deploys.find((d) => d.id === "d2")?.sha,
      service: "api-prod",
    });
  });

  it("asks first, and stops if told no", async () => {
    const asked: string[] = [];
    const decline = async (message: string) => {
      asked.push(message);
      return false;
    };

    await expect(run({ service: "api-prod", confirm: decline })).rejects.toThrow("Cancelado.");
    expect(asked).toEqual(["Rollback de api-prod: v1.2.0 → v1.1.0 (desplegada ayer 09:01). ¿Continuar?"]);
    expect(deployRequest()).toBeUndefined();
  });

  it("requires -y without an interactive terminal", async () => {
    await expect(run({ service: "api-prod" })).rejects.toThrow(
      /Sin terminal interactiva hay que confirmar con -y\. Rollback de api-prod: v1\.2\.0 → v1\.1\.0/,
    );
    expect(deployRequest()).toBeUndefined();
  });

  it("--to goes back to an older version that was deployed there", async () => {
    const result = await run({ service: "api-prod", to: "v1.0.0", yes: true });
    expect(result.to.id).toBe("d1");
    expect(deployRequest()?.body).toMatchObject({ tag: "v1.0.0" });
  });

  it("--to refuses versions that never reached deployed on that service", async () => {
    await expect(run({ service: "api-prod", to: "v1.3.0", yes: true })).rejects.toThrow(
      "v1.3.0 nunca se desplegó en api-prod, así que no se puede volver a ella. Versiones que sí: v1.2.0, v1.1.0, v1.0.0.",
    );
    await expect(run({ service: "api-prod", to: "v0.9.0", yes: true })).rejects.toThrow(/nunca se desplegó/);
    await expect(run({ service: "api-prod", to: "v1.2.0", yes: true })).rejects.toThrow("api-prod ya está en v1.2.0.");
  });

  it("refuses while a deploy is in flight on that service", async () => {
    keel.deploys.unshift(pastDeploy("d5", "v1.4.0", "api-prod", "2026-10-27T17:59:00Z", { status: "deploying" }));
    await expect(run({ service: "api-prod", yes: true })).rejects.toThrow(
      /Hay un deploy en curso en api-prod \(v1\.4\.0, d5\)/,
    );
  });

  it("explains when there is nothing to go back to", async () => {
    await expect(run({ service: "worker", yes: true })).rejects.toThrow(
      "worker solo ha tenido v0.9.0: no hay una versión anterior a la que volver.",
    );
    keel.deploys = [];
    await expect(run({ service: "api-prod", yes: true })).rejects.toThrow(/todavía no tiene ningún deploy exitoso/);
  });

  it("rejects an unknown scope", async () => {
    await expect(run({ service: "nope", yes: true })).rejects.toThrow(/El scope nope no existe .* api-prod, worker/);
  });
});
