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
import { type ActiveFreeze, activeFreeze, FORCE_ROLE, type FreezeLevel, frozenError } from "./freeze";
import { approvalRequired, type DeployRecord, type Scope, type ScopeLockRecord, type Store } from "./store";
import { verifyToken } from "./tokens";

const ciOutcome = (status: CiResultRequest["status"]): DeployStatus =>
  status === "success" ? "ci_passed" : "ci_failed";

/** The 423 a locked scope answers to a new deploy. */
export const lockedMessage = (scope: Scope, lock: ScopeLockRecord) =>
  `El scope ${scope.alias} está bloqueado: ${lock.reason} (por ${lock.lockedBy ?? "alguien"}, ${formatDate(lock.createdAt)}). Desbloquéalo con \`keel unlock -s ${scope.alias}\`.`;

/**
 * Queues a deploy. If the Action already reported this SHA (it can finish before `keel deploy` runs),
 * the deploy skips `waiting_ci` and starts from the stored CI outcome. A locked scope refuses it with 423;
 * deploys already queued keep going.
 */
export async function requestDeploy(
  store: Store,
  req: CreateDeployRequest,
  now: Date,
  requestedBy: string | null = null,
  requestedByMemberId: string | null = null,
): Promise<DeployRecord> {
  return (await queueDeploy(store, req, now, requestedBy, requestedByMemberId)).deploy;
}

/** How a request may go through a freeze window: whether the caller has the role to force one of that level. */
export interface FreezePolicy {
  canForce: (level: FreezeLevel) => boolean;
}

/** Without a policy nobody can force: a request with `forceReason` into a window gets the 403. */
const NO_FORCE: FreezePolicy = { canForce: () => false };

/** Like `requestDeploy`, also saying whether the deploy is new or one already in flight for that commit and scope. */
export async function queueDeploy(
  store: Store,
  req: CreateDeployRequest,
  now: Date,
  requestedBy: string | null = null,
  requestedByMemberId: string | null = null,
  policy: FreezePolicy = NO_FORCE,
): Promise<{ deploy: DeployRecord; created: boolean; freeze?: ActiveFreeze }> {
  const app = await store.getAppByRepo(req.repo);
  if (!app) throw new ApiError(404, `El repo ${req.repo} no está vinculado a ninguna app de keel.`);

  const scope = await store.getScopeByAlias(app.id, req.scope);
  if (!scope) {
    const available = (await store.listScopes(app.id)).map((s) => s.alias);
    throw new ApiError(
      404,
      `El scope ${req.scope} no existe en ${app.repo}. Disponibles: ${available.join(", ") || "ninguno"}.`,
    );
  }

  return store.transaction(async (tx) => {
    // Waits for a CI result of this repo being applied right now, and keeps two replicas from queuing the same deploy.
    await tx.lockAppRow(app.id);

    const lock = await tx.getScopeLock(scope.id);
    if (lock) throw new ApiError(423, lockedMessage(scope, lock));

    // Re-running `keel deploy` for the same commit and scope returns the in-flight deploy instead of duplicating it.
    const inFlight = (await tx.listDeploys({ repo: req.repo, sha: req.sha, scopeId: scope.id })).find(
      (d) => !isTerminal(d.status),
    );
    if (inFlight) return { deploy: inFlight, created: false };

    const freeze = activeFreeze(await tx.freezesFor(app.id), { appId: app.id, scope: scope.alias }, now);
    if (freeze && !req.forceReason) throw frozenError(freeze, scope.alias);
    if (freeze && !policy.canForce(freeze.level)) {
      throw new ApiError(
        403,
        `Forzar la ventana «${freeze.window.name}» necesita rol ${FORCE_ROLE[freeze.level]} en ${req.repo}/${scope.alias}.`,
      );
    }
    // Forcing only means something while a window is active; otherwise it is an ordinary deploy.
    const forced = freeze && req.forceReason ? { by: requestedBy ?? "anónimo", reason: req.forceReason } : null;

    const ci = await tx.getCiResult(req.repo, req.sha);
    const status = ci ? ciOutcome(ci.status) : "waiting_ci";
    const deploy = await tx.insertDeploy(
      {
        repo: req.repo,
        tag: req.tag,
        sha: req.sha,
        scope,
        status,
        requestedBy,
        requestedByMemberId,
        needsApproval: approvalRequired(app, scope),
        forced,
        ...(status === "ci_failed" && { error: `El CI de ${req.tag} terminó con ${ci?.status}.` }),
      },
      now,
    );
    return { deploy, created: true, ...(freeze && { freeze }) };
  });
}

/** Stores the CI outcome reported by the GitHub Action and advances any deploy waiting on that SHA. */
export async function recordCiResult(
  store: Store,
  req: CiResultRequest,
  token: string | undefined,
  now: Date,
): Promise<{ updated: DeployRecord[] }> {
  const app = await store.getAppByRepo(req.repo);
  const hash = app && (await store.getCiTokenHash(app.id));
  // Same response for unknown repo and bad token so the endpoint doesn't reveal which repos exist.
  if (!app || !hash || !token || !verifyToken(token, hash)) {
    throw new ApiError(401, "Token de CI inválido para este repo.");
  }

  return store.transaction(async (tx) => {
    await tx.lockAppRow(app.id);
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
 * reports. Needs the publisher role (checked by the handler) and is informational: deploys still wait for the
 * token-signed `ci-result`.
 */
export async function registerVersion(store: Store, req: RegisterVersionRequest, now: Date): Promise<Version> {
  const app = await store.getAppByRepo(req.repo);
  if (!app) throw new ApiError(404, `El repo ${req.repo} no está vinculado a ninguna app de keel.`);
  return store.registerVersion(req, now);
}
