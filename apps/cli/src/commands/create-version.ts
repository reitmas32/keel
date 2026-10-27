import { keelHome } from "../config.js";
import { KeelError } from "../errors.js";
import { compareWithRemote, currentBranch, git, localTagExists, remoteTagExists } from "../git.js";
import { resolveRepo } from "../repo.js";
import { isSemverTag } from "../semver.js";

export interface CreateVersionOptions {
  version: string;
  cwd?: string;
  home?: string;
}

export interface CreateVersionResult {
  tag: string;
  repo: string;
  branch: string;
  sha: string;
}

/** Validates org, branch sync and tag availability, then creates and pushes an annotated tag. */
export async function createVersion({
  version,
  cwd = process.cwd(),
  home = keelHome(),
}: CreateVersionOptions): Promise<CreateVersionResult> {
  if (!isSemverTag(version)) {
    throw new KeelError(`Versión inválida: ${version}. Usa semver con prefijo v, p.ej. v1.0.0.`);
  }

  const { repo } = await resolveRepo(cwd, home, "crear versiones");

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
  return { tag: version, repo, branch, sha };
}
