import * as p from "@clack/prompts";
import { type Deploy, isTerminal } from "@keel/shared";
import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { formatWhen } from "../deploys-view.js";
import { KeelError } from "../errors.js";
import { resolveRepo } from "../repo.js";

/** How far back in a service's history a rollback looks. */
const HISTORY = 200;

export interface RollbackOptions {
  service?: string;
  /** Version to go back to; it must have been deployed on that service before. */
  to?: string;
  /** Skip the confirmation (required without an interactive terminal). */
  yes?: boolean;
  /** Asked before rolling back; without it (no interactive terminal) `yes` is required. */
  confirm?: (message: string) => Promise<boolean>;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
  now?: Date;
}

export interface RollbackResult {
  service: string;
  /** The deploy that put the current version on the service. */
  from: Deploy;
  /** The earlier deploy whose version and commit are deployed again. */
  to: Deploy;
  deploy: Deploy;
}

/**
 * Deploys again, on one service, the version it ran before the current one (or `to`). Only versions that
 * service already reached `deployed` with are candidates: a rollback never ships something untested there.
 * It reuses that deploy's commit, so it works even if the tag was deleted since.
 */
export async function rollback({
  service,
  to,
  yes = false,
  confirm,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
  now = new Date(),
}: RollbackOptions): Promise<RollbackResult> {
  const { org, repo } = await resolveRepo(cwd, home, "hacer rollback");
  const api = new KeelApi(org.apiUrl, fetchImpl);

  const services = await api.listServices(repo);
  if (services.length === 0) {
    throw new KeelError(`${repo} no tiene scopes vinculados. Agrégalos en el admin de keel.`);
  }
  const target = service ?? (await pickService(services));
  if (!services.includes(target)) {
    throw new KeelError(`El scope ${target} no existe en ${repo}. Disponibles: ${services.join(", ")}.`);
  }

  const history = await api.listDeploys(repo, { service: target, limit: HISTORY });
  const inFlight = history.find((d) => !isTerminal(d.status));
  if (inFlight) {
    throw new KeelError(
      `Hay un deploy en curso en ${target} (${inFlight.tag}, ${inFlight.id.slice(0, 8)}). Espera a que termine o revísalo con \`keel deploys ${inFlight.id.slice(0, 8)}\`.`,
    );
  }

  const deployed = history.filter((d) => d.status === "deployed");
  const current = deployed[0];
  if (!current) throw new KeelError(`${target} todavía no tiene ningún deploy exitoso con keel: no hay a qué volver.`);

  let previous: Deploy | undefined;
  if (to) {
    if (to === current.tag) throw new KeelError(`${target} ya está en ${to}.`);
    previous = deployed.find((d) => d.tag === to);
    if (!previous) {
      const tags = [...new Set(deployed.map((d) => d.tag))].join(", ");
      throw new KeelError(
        `${to} nunca se desplegó en ${target}, así que no se puede volver a ella. Versiones que sí: ${tags}.`,
      );
    }
  } else {
    previous = deployed.find((d) => d.tag !== current.tag);
    if (!previous) {
      throw new KeelError(`${target} solo ha tenido ${current.tag}: no hay una versión anterior a la que volver.`);
    }
  }

  const deployedAt = formatWhen(previous.finishedAt ?? previous.updatedAt, { now, color: false });
  const message = `Rollback de ${target}: ${current.tag} → ${previous.tag} (desplegada ${deployedAt}). ¿Continuar?`;
  if (!yes) {
    if (!confirm)
      throw new KeelError(`Sin terminal interactiva hay que confirmar con -y. ${message.replace(" ¿Continuar?", "")}`);
    if (!(await confirm(message))) throw new KeelError("Cancelado.");
  }

  const deploy = await api.createDeploy({ repo, tag: previous.tag, sha: previous.sha, service: target });
  return { service: target, from: current, to: previous, deploy };
}

async function pickService(services: string[]): Promise<string> {
  const choice = await p.select({ message: "Scope", options: services.map((value) => ({ value, label: value })) });
  if (p.isCancel(choice)) throw new KeelError("Cancelado.");
  return choice;
}
