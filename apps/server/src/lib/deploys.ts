import {
  type CiResultRequest,
  type CreateDeployRequest,
  type DeployStatus,
  isTerminal,
  type RegisterVersionRequest,
  type Version,
} from "@keel/shared";
import { ApiError } from "./errors";
import { formatDate } from "./format";
import type { DeployRecord, Service, ServiceLockRecord, Store } from "./store";
import { verifyToken } from "./tokens";

const ciOutcome = (status: CiResultRequest["status"]): DeployStatus =>
  status === "success" ? "ci_passed" : "ci_failed";

/** The 423 a locked service answers to a new deploy. */
export const lockedMessage = (service: Service, lock: ServiceLockRecord) =>
  `El servicio ${service.alias} está bloqueado: ${lock.reason} (por ${lock.lockedBy ?? "alguien"}, ${formatDate(lock.createdAt)}). Desbloquéalo con \`keel unlock -s ${service.alias}\`.`;

/**
 * Queues a deploy. If the Action already reported this SHA (it can finish before `keel deploy` runs),
 * the deploy skips `waiting_ci` and starts from the stored CI outcome. A locked service refuses it with 423;
 * deploys already queued keep going.
 */
export async function requestDeploy(
  store: Store,
  req: CreateDeployRequest,
  now: Date,
  requestedBy: string | null = null,
): Promise<DeployRecord> {
  const scope = await store.getScopeByRepo(req.repo);
  if (!scope)
    throw new ApiError(404, `El repo ${req.repo} no está vinculado a ningún scope en esta instancia de keel.`);

  const service = await store.getServiceByAlias(scope.id, req.service);
  if (!service) {
    const available = (await store.listServices(scope.id)).map((s) => s.alias);
    throw new ApiError(
      404,
      `El servicio ${req.service} no existe en ${scope.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
    );
  }

  return store.transaction(async (tx) => {
    // Waits for a CI result of this repo being applied right now, and keeps two replicas from queuing the same deploy.
    await tx.lockScope(scope.id);

    const lock = await tx.getServiceLock(service.id);
    if (lock) throw new ApiError(423, lockedMessage(service, lock));

    // Re-running `keel deploy` for the same commit and service returns the in-flight deploy instead of duplicating it.
    const inFlight = (await tx.listDeploys({ repo: req.repo, sha: req.sha, serviceId: service.id })).find(
      (d) => !isTerminal(d.status),
    );
    if (inFlight) return inFlight;

    const ci = await tx.getCiResult(req.repo, req.sha);
    const status = ci ? ciOutcome(ci.status) : "waiting_ci";
    return tx.insertDeploy(
      {
        repo: req.repo,
        tag: req.tag,
        sha: req.sha,
        service,
        status,
        requestedBy,
        ...(status === "ci_failed" && { error: `El CI de ${req.tag} terminó con ${ci?.status}.` }),
      },
      now,
    );
  });
}

/** Stores the CI outcome reported by the GitHub Action and advances any deploy waiting on that SHA. */
export async function recordCiResult(
  store: Store,
  req: CiResultRequest,
  token: string | undefined,
  now: Date,
): Promise<{ updated: DeployRecord[] }> {
  const scope = await store.getScopeByRepo(req.repo);
  const hash = scope && (await store.getCiTokenHash(scope.id));
  // Same response for unknown repo and bad token so the endpoint doesn't reveal which repos exist.
  if (!scope || !hash || !token || !verifyToken(token, hash)) {
    throw new ApiError(401, "Token de CI inválido para este repo.");
  }

  return store.transaction(async (tx) => {
    await tx.lockScope(scope.id);
    await tx.upsertCiResult({ ...req, receivedAt: now.toISOString() });
    await tx.recordVersionCi(
      { repo: req.repo, tag: req.tag, sha: req.sha, status: req.status, ...(req.runUrl && { runUrl: req.runUrl }) },
      now,
    );

    const to = ciOutcome(req.status);
    const updated: DeployRecord[] = [];
    for (const d of await tx.listDeploys({ repo: req.repo, sha: req.sha, status: "waiting_ci" })) {
      const error = to === "ci_failed" ? { error: `El CI de ${req.tag} terminó con ${req.status}.` } : {};
      const next = await tx.transition(d.id, to, now, error);
      if (next) updated.push(next);
    }
    return { updated };
  });
}

/**
 * Registers a version `keel create-version` just pushed, so keel can show it as pending before its CI
 * reports. Unauthenticated and informational: deploys still wait for the token-signed `ci-result`.
 */
export async function registerVersion(store: Store, req: RegisterVersionRequest, now: Date): Promise<Version> {
  const scope = await store.getScopeByRepo(req.repo);
  if (!scope)
    throw new ApiError(404, `El repo ${req.repo} no está vinculado a ningún scope en esta instancia de keel.`);
  return store.registerVersion(req, now);
}
