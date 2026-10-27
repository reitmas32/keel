import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveOrg } from "../config.js";
import { createFakeKeel, type FakeKeel } from "../testing/fake-keel.js";
import { createGitFixture, type GitFixture, git } from "../testing/git-fixture.js";
import { createVersion } from "./create-version.js";

let fx: GitFixture;
let keel: FakeKeel;

beforeEach(async () => {
  fx = await createGitFixture();
  keel = createFakeKeel();
});

afterEach(async () => {
  await fx.cleanup();
});

const run = (version: string, opts: { deploy?: string; keel?: FakeKeel } = {}) =>
  createVersion({
    version,
    cwd: fx.work,
    home: fx.home,
    fetch: (opts.keel ?? keel).fetch,
    ...(opts.deploy && { deploy: opts.deploy }),
  });

describe("createVersion", () => {
  it("creates and pushes the tag when everything is in sync", async () => {
    const result = await run("v1.0.0");

    expect(result).toMatchObject({ tag: "v1.0.0", repo: "konectus-io/app", branch: "main" });
    expect(git(fx.remote, "rev-parse", "v1.0.0^{commit}")).toBe(git(fx.work, "rev-parse", "HEAD"));
  });

  it("rejects a repo outside the active org", async () => {
    await setActiveOrg("github.com:jalocompany", fx.home);

    await expect(run("v1.0.0")).rejects.toThrow(
      "La configuración actual de keel (github.com:jalocompany) no puede crear versiones en esta organización (github.com:konectus-io)",
    );
  });

  it("asks to push when the remote branch is behind", async () => {
    await fx.commit(fx.work, "b.txt");

    await expect(run("v1.0.0")).rejects.toThrow("Sube los cambios a konectus-io/app en la rama main.");
  });

  it("asks to pull when the local branch is behind", async () => {
    await fx.pushFromOtherClone("c.txt");

    await expect(run("v1.0.0")).rejects.toThrow(/atrasada: baja los cambios de konectus-io\/app en la rama main/);
  });

  it("rejects diverged branches", async () => {
    await fx.pushFromOtherClone("c.txt");
    await fx.commit(fx.work, "b.txt");

    await expect(run("v1.0.0")).rejects.toThrow(/divergen/);
  });

  it("rejects a tag that already exists on the remote", async () => {
    await run("v1.0.0");
    git(fx.work, "tag", "-d", "v1.0.0");

    await expect(run("v1.0.0")).rejects.toThrow("El tag v1.0.0 ya existe en konectus-io/app.");
  });

  it("rejects a branch that was never pushed", async () => {
    git(fx.work, "switch", "-q", "-c", "feature");

    await expect(run("v1.0.0")).rejects.toThrow(/La rama feature no existe en origin/);
  });

  it.each(["1.0.0", "v1.0", "release"])("rejects the non-semver version %s", async (version) => {
    await expect(run(version)).rejects.toThrow(/Versión inválida/);
  });

  it("does not create any tag when a check fails", async () => {
    await fx.commit(fx.work, "b.txt");
    await expect(run("v1.0.0")).rejects.toThrow();

    expect(git(fx.work, "tag", "--list")).toBe("");
    expect(git(fx.remote, "tag", "--list")).toBe("");
  });

  it("registers the version in keel as pending, with its branch and author", async () => {
    const result = await run("v1.0.0");

    expect(result.registerWarning).toBeUndefined();
    expect(keel.requests.find((r) => r.path === "/versions")?.body).toEqual({
      repo: "konectus-io/app",
      tag: "v1.0.0",
      sha: git(fx.work, "rev-parse", "HEAD"),
      branch: "main",
      createdByName: "keel test",
      createdByEmail: "test@keel.local",
    });
    expect(keel.versions.get("v1.0.0")?.ciStatus).toBe("pending");
  });

  it("creates a version from any branch that is pushed and in sync", async () => {
    git(fx.work, "switch", "-q", "-c", "hotfix/login");
    await fx.commit(fx.work, "fix.txt");
    git(fx.work, "push", "-q", "-u", "origin", "hotfix/login");

    const result = await run("v1.0.1");

    expect(result).toMatchObject({ tag: "v1.0.1", branch: "hotfix/login" });
    expect(git(fx.remote, "rev-parse", "v1.0.1^{commit}")).toBe(git(fx.work, "rev-parse", "HEAD"));
    expect(keel.versions.get("v1.0.1")?.branch).toBe("hotfix/login");
  });

  it("still publishes the tag when keel can't register it, and says why", async () => {
    const legacy = createFakeKeel({ legacy: true });
    const result = await run("v1.0.0", { keel: legacy });

    expect(git(fx.remote, "tag", "--list")).toBe("v1.0.0");
    expect(result.registerWarning).toMatch(/anterior a v0.4.0/);
  });

  it("--deploy requests the deploy of exactly the new version", async () => {
    const result = await run("v1.0.0", { deploy: "api-prod" });

    expect(result.deploy).toMatchObject({ id: "d1", tag: "v1.0.0", service: "api-prod", status: "waiting_ci" });
    expect(keel.requests.find((r) => r.path === "/deploys")?.body).toEqual({
      repo: "konectus-io/app",
      tag: "v1.0.0",
      sha: git(fx.work, "rev-parse", "HEAD"),
      service: "api-prod",
    });
  });

  it("--deploy with an unknown service fails before creating the tag", async () => {
    await expect(run("v1.0.0", { deploy: "api-staging" })).rejects.toThrow(
      /El servicio api-staging no existe en konectus-io\/app\. Disponibles: api-prod, worker\. No se creó la versión\./,
    );

    expect(git(fx.remote, "tag", "--list")).toBe("");
    expect(git(fx.work, "tag", "--list")).toBe("");
  });

  it("reports a failed --deploy without hiding that the tag was published", async () => {
    keel.failDeploysWith = "El repo no está vinculado.";
    const result = await run("v1.0.0", { deploy: "api-prod" });

    expect(git(fx.remote, "tag", "--list")).toBe("v1.0.0");
    expect(result.deploy).toBeUndefined();
    expect(result.deployError).toBe(
      "No se pudo pedir el deploy a api-prod: El repo no está vinculado. Pídelo con `keel deploy -s api-prod -v v1.0.0`.",
    );
  });
});
