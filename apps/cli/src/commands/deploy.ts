import * as p from "@clack/prompts";
import type { Deploy, Version } from "@keel/shared";
import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { KeelError } from "../errors.js";
import { gitIdentity, remoteTags } from "../git.js";
import { resolveRepo } from "../repo.js";
import { compareSemverDesc, isSemverTag } from "../semver.js";
import { latestReady } from "../versions-view.js";

/** How many recent versions the interactive picker shows. */
const VERSION_CHOICES = 15;

/** How many versions keel is asked for, to describe the one being deployed. */
const VERSION_LOOKUP = 200;

export interface DeployOptions {
  service?: string;
  version?: string;
  latest?: boolean;
  /** The highest version whose CI passed. Needs a keel server ≥ v0.4.0. */
  latestReady?: boolean;
  /**
   * Asked before deploying a `--latest` version someone else created. Without it (no interactive terminal)
   * the deploy goes ahead and `createdByOther` tells the caller to warn.
   */
  confirm?: (message: string) => Promise<boolean>;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
}

export interface DeployResult {
  deploy: Deploy;
  /** What keel knows of the deployed version; undefined on servers < v0.4.0 or if it never heard of it. */
  version?: Version;
  /** The version was picked with --latest and someone else created it. */
  createdByOther?: boolean;
}

export async function deploy({
  service,
  version,
  latest,
  latestReady: ready,
  confirm,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
}: DeployOptions): Promise<DeployResult> {
  if ([latest, ready, version].filter(Boolean).length > 1) {
    throw new KeelError("Usa solo una de --latest, --latest-ready o --version.");
  }

  const { org, repo } = await resolveRepo(cwd, home, "desplegar");
  const api = new KeelApi(org.apiUrl, fetchImpl);

  const services = await api.listServices(repo);
  if (services.length === 0) {
    throw new KeelError(`${repo} no tiene servicios de Dokploy vinculados. Agrégalos en el admin de keel.`);
  }
  const target =
    service ??
    (await pick(
      "Servicio de Dokploy",
      services.map((s) => ({ value: s })),
    ));
  if (!services.includes(target)) {
    throw new KeelError(`El servicio ${target} no existe en ${repo}. Disponibles: ${services.join(", ")}.`);
  }

  const tags = await remoteTags(cwd);
  const semverTags = [...tags.keys()].filter(isSemverTag).sort(compareSemverDesc);
  if (semverTags.length === 0) throw new KeelError(`${repo} no tiene versiones. Crea una con \`keel create-version\`.`);

  const known = await api.listVersions(repo, { limit: VERSION_LOOKUP });
  const byTag = new Map((known ?? []).map((v) => [v.tag, v]));

  let tag: string;
  if (ready) {
    if (!known) {
      throw new KeelError(
        "Tu servidor de keel es anterior a v0.4.0 y no sabe qué versiones pasaron su CI. Usa -v <versión>.",
      );
    }
    // Only versions that still exist on the remote: a deleted tag can't be deployed.
    const candidate = latestReady(known.filter((v) => tags.has(v.tag)));
    if (!candidate) throw new KeelError(`${repo} no tiene ninguna versión con el CI en verde.`);
    tag = candidate.tag;
  } else if (latest) {
    tag = semverTags[0] as string;
  } else {
    tag =
      version ??
      (await pick(
        "Versión",
        semverTags.slice(0, VERSION_CHOICES).map((value) => {
          const v = byTag.get(value);
          return { value, ...(v && { hint: ciHint(v) }) };
        }),
      ));
  }
  const sha = tags.get(tag);
  if (!sha) throw new KeelError(`La versión ${tag} no existe en ${repo}.`);

  const info = byTag.get(tag);
  let createdByOther = false;
  if (latest && info?.createdByEmail) {
    const me = await gitIdentity(cwd);
    createdByOther = Boolean(me.email) && me.email?.toLowerCase() !== info.createdByEmail.toLowerCase();
    if (createdByOther && confirm) {
      const who = info.createdByName ?? info.createdByEmail;
      const go = await confirm(`${tag} es la última versión, pero la creó ${who}. ¿Desplegarla en ${target}?`);
      if (!go) throw new KeelError(`Cancelado. Para desplegar una versión concreta usa -v <versión>.`);
    }
  }

  const result: DeployResult = { deploy: await api.createDeploy({ repo, tag, sha, service: target }) };
  if (info) result.version = info;
  if (createdByOther) result.createdByOther = true;
  return result;
}

const ciHint = (v: Version) =>
  ({ pending: "CI en curso", success: "CI ok", failure: "CI falló", cancelled: "CI cancelado", expired: "sin CI" })[
    v.ciStatus
  ];

async function pick(message: string, options: { value: string; hint?: string }[]): Promise<string> {
  const choice = await p.select({
    message,
    options: options.map(({ value, hint }) => ({ value, label: value, ...(hint && { hint }) })),
  });
  if (p.isCancel(choice)) throw new KeelError("Cancelado.");
  return choice;
}
