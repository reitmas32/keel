import * as p from "@clack/prompts";
import type { Deploy } from "@keel/shared";
import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { KeelError } from "../errors.js";
import { remoteTags } from "../git.js";
import { resolveRepo } from "../repo.js";
import { compareSemverDesc, isSemverTag } from "../semver.js";

/** How many recent versions the interactive picker shows. */
const VERSION_CHOICES = 15;

export interface DeployOptions {
  service?: string;
  version?: string;
  latest?: boolean;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
}

export async function deploy({
  service,
  version,
  latest,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
}: DeployOptions): Promise<Deploy> {
  if (latest && version) throw new KeelError("Usa --latest o --version, no ambos.");

  const { org, repo } = await resolveRepo(cwd, home, "desplegar");
  const api = new KeelApi(org.apiUrl, fetchImpl);

  const services = await api.listServices(repo);
  if (services.length === 0) {
    throw new KeelError(`${repo} no tiene servicios de Dokploy vinculados. Agrégalos en el admin de keel.`);
  }
  const target = service ?? (await pick("Servicio de Dokploy", services));
  if (!services.includes(target)) {
    throw new KeelError(`El servicio ${target} no existe en ${repo}. Disponibles: ${services.join(", ")}.`);
  }

  const tags = await remoteTags(cwd);
  const versions = [...tags.keys()].filter(isSemverTag).sort(compareSemverDesc);
  if (versions.length === 0) throw new KeelError(`${repo} no tiene versiones. Crea una con \`keel create-version\`.`);

  const tag = latest
    ? (versions[0] as string)
    : (version ?? (await pick("Versión", versions.slice(0, VERSION_CHOICES))));
  const sha = tags.get(tag);
  if (!sha) throw new KeelError(`La versión ${tag} no existe en ${repo}.`);

  return api.createDeploy({ repo, tag, sha, service: target });
}

async function pick(message: string, options: string[]): Promise<string> {
  const choice = await p.select({ message, options: options.map((value) => ({ value, label: value })) });
  if (p.isCancel(choice)) throw new KeelError("Cancelado.");
  return choice;
}
