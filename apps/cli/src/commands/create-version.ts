import type { Deploy } from "@keel/shared";
import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { KeelApiError, KeelError } from "../errors.js";
import { compareWithRemote, currentBranch, git, gitIdentity, localTagExists, remoteTagExists } from "../git.js";
import { resolveRepo } from "../repo.js";
import { isSemverTag } from "../semver.js";

export interface CreateVersionOptions {
  version: string;
  /** Service alias to deploy the new version to, right after creating it. */
  deploy?: string;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
}

export interface CreateVersionResult {
  tag: string;
  repo: string;
  branch: string;
  sha: string;
  /** Why keel couldn't register the version, when it couldn't. The tag is published either way. */
  registerWarning?: string;
  /** The deploy requested with `--deploy`. */
  deploy?: Deploy;
  /** Why the `--deploy` request failed, when it did. The tag is published either way. */
  deployError?: string;
}

/**
 * Validates org, branch sync and tag availability, creates and pushes an annotated tag, and registers it in
 * keel as pending. Works from any branch: the version's CI runs on its tag. With `deploy`, also requests the
 * deploy of exactly this version, so it can't pick up someone else's newer tag.
 */
export async function createVersion({
  version,
  deploy,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
}: CreateVersionOptions): Promise<CreateVersionResult> {
  if (!isSemverTag(version)) {
    throw new KeelError(`Versión inválida: ${version}. Usa semver con prefijo v, p.ej. v1.0.0.`);
  }

  const { org, repo } = await resolveRepo(cwd, home, "crear versiones");
  const api = new KeelApi(org.apiUrl, fetchImpl);

  // Checked before creating the tag: a typo in the service must not burn a version number.
  if (deploy) {
    const services = await api.listServices(repo);
    if (!services.includes(deploy)) {
      throw new KeelError(
        `El servicio ${deploy} no existe en ${repo}. Disponibles: ${services.join(", ") || "ninguno"}. No se creó la versión.`,
      );
    }
  }

  const branch = await currentBranch(cwd);
  const { ahead, behind } = await compareWithRemote(cwd, branch);
  if (ahead > 0 && behind > 0) {
    throw new KeelError(
      `La rama local ${branch} y la remota de ${repo} divergen (${ahead} commit(s) locales, ${behind} remotos). Sincronízalas antes de crear la versión.`,
    );
  }
  if (ahead > 0) throw new KeelError(`Sube los cambios a ${repo} en la rama ${branch}.`);
  if (behind > 0) throw new KeelError(`Tu rama local está atrasada: baja los cambios de ${repo} en la rama ${branch}.`);

  if (await remoteTagExists(cwd, version)) {
    throw new KeelError(`El tag ${version} ya existe en ${repo}.`);
  }
  if (await localTagExists(cwd, version)) {
    throw new KeelError(
      `El tag ${version} ya existe localmente. Bórralo con \`git tag -d ${version}\` si no es válido.`,
    );
  }

  const sha = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "tag", "-a", version, "-m", version);
  await git(cwd, "push", "origin", `refs/tags/${version}`);
  const result: CreateVersionResult = { tag: version, repo, branch, sha };

  // Best effort: if keel is down or older than v0.4.0, the version still exists and keel learns of it when
  // its CI reports. Deploys never depend on this registration.
  const identity = await gitIdentity(cwd);
  try {
    await api.registerVersion({
      repo,
      tag: version,
      sha,
      branch,
      ...(identity.name && { createdByName: identity.name }),
      ...(identity.email && { createdByEmail: identity.email }),
    });
  } catch (error) {
    result.registerWarning =
      error instanceof KeelApiError && error.unsupported
        ? "Tu servidor de keel es anterior a v0.4.0 y no registra versiones; la verá cuando llegue el resultado del CI."
        : `No se pudo registrar ${version} en keel (${(error as Error).message}); la verá cuando llegue el resultado del CI.`;
  }

  if (deploy) {
    // The tag is already public at this point: a failed deploy request is reported, not thrown.
    try {
      result.deploy = await api.createDeploy({ repo, tag: version, sha, service: deploy });
    } catch (error) {
      result.deployError = `No se pudo pedir el deploy a ${deploy}: ${(error as Error).message} Pídelo con \`keel deploy -s ${deploy} -v ${version}\`.`;
    }
  }
  return result;
}
