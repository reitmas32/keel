import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveOrg } from "../config.js";
import { createFakeKeel, type FakeKeel, knownVersion } from "../testing/fake-keel.js";
import { createGitFixture, type GitFixture, git } from "../testing/git-fixture.js";
import { createVersion } from "./create-version.js";
import { deploy } from "./deploy.js";

let fx: GitFixture;
let keel: FakeKeel;

const sha = (tag: string) => git(fx.work, "rev-parse", `${tag}^{commit}`);
const deployRequest = () => keel.requests.find((r) => r.method === "POST" && r.path === "/deploys");
const run = (opts: Parameters<typeof deploy>[0], k: FakeKeel = keel) =>
  deploy({ cwd: fx.work, home: fx.home, fetch: k.fetch, ...opts });

beforeEach(async () => {
  fx = await createGitFixture();
  // Tags created against a legacy keel so they start unknown; each test seeds what keel knows.
  const setup = createFakeKeel({ legacy: true });
  const create = (version: string) => createVersion({ version, cwd: fx.work, home: fx.home, fetch: setup.fetch });
  await create("v1.0.0");
  await fx.commit(fx.work, "b.txt");
  git(fx.work, "push", "-q", "origin", "main");
  // v1.10.0 must win over v1.2.0: numeric, not lexical, ordering.
  await create("v1.2.0");
  await create("v1.10.0");
  keel = createFakeKeel();
});

afterEach(async () => {
  await fx.cleanup();
});

describe("deploy", () => {
  it("--latest picks the highest semver tag and sends its commit", async () => {
    const { deploy: d } = await run({ service: "api-prod", latest: true });

    expect(d.status).toBe("waiting_ci");
    expect(deployRequest()?.body).toEqual({
      repo: "konectus-io/app",
      tag: "v1.10.0",
      sha: sha("v1.10.0"),
      service: "api-prod",
    });
  });

  it("sends the commit of an explicit version", async () => {
    await run({ service: "worker", version: "v1.0.0" });

    expect(deployRequest()?.body).toMatchObject({ tag: "v1.0.0", sha: sha("v1.0.0") });
  });

  it("describes the version it deploys when keel knows it", async () => {
    keel.versions.set("v1.10.0", knownVersion("v1.10.0", sha("v1.10.0"), { ciStatus: "pending", ciFinishedAt: null }));

    const result = await run({ service: "api-prod", latest: true });

    expect(result.version).toMatchObject({ tag: "v1.10.0", ciStatus: "pending", createdByName: "keel test" });
    expect(result.createdByOther).toBeUndefined();
  });

  it("asks before deploying a --latest version someone else created, and stops if told no", async () => {
    keel.versions.set(
      "v1.10.0",
      knownVersion("v1.10.0", sha("v1.10.0"), { createdByName: "Ana", createdByEmail: "ana@jalo.mx" }),
    );
    const asked: string[] = [];
    const decline = async (message: string) => {
      asked.push(message);
      return false;
    };

    await expect(run({ service: "api-prod", latest: true, confirm: decline })).rejects.toThrow(/Cancelado/);
    expect(asked).toEqual(["v1.10.0 es la última versión, pero la creó Ana. ¿Desplegarla en api-prod?"]);
    expect(deployRequest()).toBeUndefined();

    const confirmed = await run({ service: "api-prod", latest: true, confirm: async () => true });
    expect(confirmed).toMatchObject({ createdByOther: true, deploy: { tag: "v1.10.0" } });
  });

  it("without a terminal, deploys someone else's --latest version but flags it", async () => {
    keel.versions.set("v1.10.0", knownVersion("v1.10.0", sha("v1.10.0"), { createdByEmail: "ana@jalo.mx" }));

    const result = await run({ service: "api-prod", latest: true });

    expect(result.createdByOther).toBe(true);
    expect(deployRequest()?.body).toMatchObject({ tag: "v1.10.0" });
  });

  it("--latest-ready picks the highest version whose CI passed and still exists", async () => {
    keel.versions.set("v1.0.0", knownVersion("v1.0.0", sha("v1.0.0")));
    keel.versions.set("v1.2.0", knownVersion("v1.2.0", sha("v1.2.0")));
    keel.versions.set("v1.10.0", knownVersion("v1.10.0", sha("v1.10.0"), { ciStatus: "failure" }));
    // Green but its tag no longer exists on the remote.
    keel.versions.set("v2.0.0", knownVersion("v2.0.0", "deadbee"));

    const { deploy: d } = await run({ service: "api-prod", latestReady: true });

    expect(d).toMatchObject({ tag: "v1.2.0", status: "ci_passed" });
    expect(deployRequest()?.body).toMatchObject({ tag: "v1.2.0", sha: sha("v1.2.0") });
  });

  it("--latest-ready fails clearly when no version passed or the server predates versions", async () => {
    keel.versions.set("v1.10.0", knownVersion("v1.10.0", sha("v1.10.0"), { ciStatus: "failure" }));
    await expect(run({ service: "api-prod", latestReady: true })).rejects.toThrow(/ninguna versión con el CI en verde/);

    await expect(run({ service: "api-prod", latestReady: true }, createFakeKeel({ legacy: true }))).rejects.toThrow(
      /anterior a v0.4.0/,
    );
  });

  it("keeps working against a keel server older than v0.4.0", async () => {
    const result = await run({ service: "api-prod", latest: true }, createFakeKeel({ legacy: true }));

    expect(result.deploy.tag).toBe("v1.10.0");
    expect(result.version).toBeUndefined();
  });

  it("rejects combining version selectors, unknown services and unknown versions", async () => {
    await expect(run({ service: "api-prod", latest: true, latestReady: true })).rejects.toThrow(/solo una de/);
    await expect(run({ service: "nope", latest: true })).rejects.toThrow(/Disponibles: api-prod, worker/);
    await expect(run({ service: "api-prod", version: "v9.9.9" })).rejects.toThrow(/v9.9.9 no existe/);
  });

  it("rejects a repo outside the active org", async () => {
    await setActiveOrg("github.com:jalocompany", fx.home);

    await expect(run({ service: "api-prod", latest: true })).rejects.toThrow(/no puede desplegar/);
    expect(keel.requests).toEqual([]);
  });
});
