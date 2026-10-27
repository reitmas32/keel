import {
  type CiResultRequest,
  type CreateDeployRequest,
  type DeployStatus,
  isTerminal,
  type RegisterVersionRequest,
  type Version,
} from "@keel/shared";
import { ApiError } from "./errors";
import type { DeployRecord, Store } from "./store";
import { verifyToken } from "./tokens";

const ciOutcome = (status: CiResultRequest["status"]): DeployStatus =>
  status === "success" ? "ci_passed" : "ci_failed";

/**
 * Queues a deploy. If the Action already reported this SHA (it can finish before `keel deploy` runs),
 * the deploy skips `waiting_ci` and starts from the stored CI outcome.
 */
export function requestDeploy(store: Store, req: CreateDeployRequest, now: Date): DeployRecord {
  const scope = store.getScopeByRepo(req.repo);
  if (!scope)
    throw new ApiError(404, `El repo ${req.repo} no está vinculado a ningún scope en esta instancia de keel.`);

  const service = store.getServiceByAlias(scope.id, req.service);
  if (!service) {
    const available = store.listServices(scope.id).map((s) => s.alias);
    throw new ApiError(
      404,
      `El servicio ${req.service} no existe en ${scope.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
    );
  }

  // Re-running `keel deploy` for the same commit and service returns the in-flight deploy instead of duplicating it.
  const inFlight = store
    .listDeploys({ repo: req.repo, sha: req.sha, serviceId: service.id })
    .find((d) => !isTerminal(d.status));
  if (inFlight) return inFlight;

  const ci = store.getCiResult(req.repo, req.sha);
  const status = ci ? ciOutcome(ci.status) : "waiting_ci";
  return store.insertDeploy(
    {
      repo: req.repo,
      tag: req.tag,
      sha: req.sha,
      service,
      status,
      ...(status === "ci_failed" && { error: `El CI de ${req.tag} terminó con ${ci?.status}.` }),
    },
    now,
  );
}

/** Stores the CI outcome reported by the GitHub Action and advances any deploy waiting on that SHA. */
export function recordCiResult(
  store: Store,
  req: CiResultRequest,
  token: string | undefined,
  now: Date,
): { updated: DeployRecord[] } {
  const scope = store.getScopeByRepo(req.repo);
  const hash = scope && store.getCiTokenHash(scope.id);
  // Same response for unknown repo and bad token so the endpoint doesn't reveal which repos exist.
  if (!scope || !hash || !token || !verifyToken(token, hash)) {
    throw new ApiError(401, "Token de CI inválido para este repo.");
  }

  store.upsertCiResult({ ...req, receivedAt: now.toISOString() });
  store.recordVersionCi(
    { repo: req.repo, tag: req.tag, sha: req.sha, status: req.status, ...(req.runUrl && { runUrl: req.runUrl }) },
    now,
  );

  const to = ciOutcome(req.status);
  const updated = store
    .listDeploys({ repo: req.repo, sha: req.sha, status: "waiting_ci" })
    .map((d) =>
      store.transition(
        d.id,
        to,
        now,
        to === "ci_failed" ? { error: `El CI de ${req.tag} terminó con ${req.status}.` } : {},
      ),
    )
    .filter((d): d is DeployRecord => d !== undefined);
  return { updated };
}

/**
 * Registers a version `keel create-version` just pushed, so keel can show it as pending before its CI
 * reports. Unauthenticated and informational: deploys still wait for the token-signed `ci-result`.
 */
export function registerVersion(store: Store, req: RegisterVersionRequest, now: Date): Version {
  const scope = store.getScopeByRepo(req.repo);
  if (!scope)
    throw new ApiError(404, `El repo ${req.repo} no está vinculado a ningún scope en esta instancia de keel.`);
  return store.registerVersion(req, now);
}
