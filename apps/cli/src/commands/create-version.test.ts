import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActiveOrg } from "../config.js";
import { createGitFixture, type GitFixture, git } from "../testing/git-fixture.js";
import { createVersion } from "./create-version.js";

let fx: GitFixture;

beforeEach(async () => {
  fx = await createGitFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

const run = (version: string) => createVersion({ version, cwd: fx.work, home: fx.home });

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
});
