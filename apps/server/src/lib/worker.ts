import type { HealthCheck } from "@keel/shared";
import type { DokployClient, DokployDeploymentStatus, DokployTarget } from "./dokploy";
import { activeFreeze } from "./freeze";
import { logger } from "./log";
import { metrics } from "./metrics";
import type { DeployNotification, Notifier, NotifyEvent } from "./notify";
import { tracedFetch } from "./outbound";
import type { DeployRecord, Scope, Store } from "./store";

export interface WorkerOptions {
  /** How long a deploy may sit in `waiting_ci` before it expires. */
  ciExpiryMinutes: number;
  /** How long Dokploy may take to finish a deployment before it's marked failed. */
  deployTimeoutMinutes: number;
  /** How long a deploy may wait for its approval, counted from when it was asked for. Default: 24 h. */
  approvalExpiryMinutes?: number;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Where state changes are announced. Without one the worker stays quiet. */
  notifier?: Notifier;
  /** Calls a scope's health check. Defaults to an HTTP GET (see `probeHealth`). */
  probe?: HealthProbe;
}

export interface ProbeResult {
  ok: boolean;
  /** Why it failed, for the deploy's error: the status it answered, a timeout, a refused connection. */
  reason?: string;
}
export type HealthProbe = (check: HealthCheck) => Promise<ProbeResult>;

/** Who asks for the deploys keel creates on its own. */
export const ROLLBACK_ACTOR = "keel (rollback automático)";

/** `GET check.url`: healthy when it answers `expectedStatus`, or any 2xx without one, within the timeout. */
export const probeHealth: HealthProbe = async (check) => {
  try {
    const response = await tracedFetch("health_check")(check.url, {
      method: "GET",
      headers: { "user-agent": "keel-health-check" },
      signal: AbortSignal.timeout(check.timeoutSeconds * 1000),
    });
    // Nothing reads the body; drop it so the connection is released.
    await response.body?.cancel().catch(() => {});
    const ok = check.expectedStatus === null ? response.ok : response.status === check.expectedStatus;
    return ok ? { ok } : { ok, reason: `respondió ${response.status}` };
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return { ok: false, reason: timedOut ? `no respondió en ${check.timeoutSeconds} s` : "no se pudo conectar" };
  }
};

const minutes = (n: number) => n * 60_000;

const targetOf = (scope: Scope): DokployTarget => ({
  kind: scope.kind,
  id: scope.dokployId,
  tagVariable: scope.tagVariable,
});

/** Advances queued deploys. `tick()` is idempotent and safe to call on an interval. */
export class DeployWorker {
  private running = false;
  private readonly now: () => Date;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private readonly notifier: Notifier | undefined;
  private readonly probe: HealthProbe;

  constructor(
    private readonly store: Store,
    private readonly dokploy: DokployClient,
    private readonly options: WorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message, fields) => logger.info(message, fields));
    this.notifier = options.notifier;
    this.probe = options.probe ?? probeHealth;
  }

  private announce(event: NotifyEvent, deploy: DeployRecord, extra: Partial<DeployNotification> = {}): void {
    this.notifier?.notify({ event, deploy, ...extra });
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let ok = false;
    try {
      await this.expireWaiting();
      await this.expireUnapproved();
      // Check first so a finished deploy frees its scope for the next queued one in the same tick.
      await this.checkDeploying();
      await this.startPassed();
      ok = true;
    } finally {
      this.running = false;
      metrics.workerTick(ok, this.now());
    }
  }

  // Several replicas may run this loop over the same Postgres database. Every state change below is conditional
  // (see Store.transition and Store.claimDeploy), so a replica that loses a race just moves on, and only the
  // winner logs and talks to Dokploy.

  private async expireWaiting(): Promise<void> {
    const cutoff = this.now().getTime() - minutes(this.options.ciExpiryMinutes);
    // Versions whose CI never reported, with the same deadline as the deploys waiting on them.
    for (const v of await this.store.expirePendingVersions(new Date(cutoff), this.now())) {
      this.log(`versión ${v.repo}@${v.tag} expirada: su CI no avisó`);
    }
    for (const d of await this.store.listDeploys({ status: "waiting_ci" })) {
      if (Date.parse(d.createdAt) >= cutoff) continue;
      const expired = await this.store.transition(d.id, "expired", this.now(), {
        error: `No llegó el resultado del CI en ${this.options.ciExpiryMinutes} min.`,
        // Its CI may have reported since it was listed: then it is no longer waiting and must not expire.
        from: "waiting_ci",
      });
      if (expired) {
        this.log(`deploy ${d.id} expirado`, { deployId: d.id, repo: d.repo, scope: d.scope, tag: d.tag });
        metrics.deployFinished("expired");
        this.announce("deploy.expired", expired);
      }
    }
  }

  private approvalCutoff(): number {
    return this.now().getTime() - minutes(this.options.approvalExpiryMinutes ?? 24 * 60);
  }

  /** Deploys whose CI passed but that nobody approved in time. */
  private async expireUnapproved(): Promise<void> {
    const cutoff = this.approvalCutoff();
    for (const d of await this.store.listDeploys({ status: "ci_passed" })) {
      if (d.approval?.status !== "pending" || Date.parse(d.createdAt) >= cutoff) continue;
      const hours = Math.round((this.options.approvalExpiryMinutes ?? 24 * 60) / 6) / 10;
      const expired = await this.store.transition(d.id, "expired", this.now(), {
        error: `Nadie aprobó el deploy en ${hours} h.`,
        from: "ci_passed",
      });
      if (expired) {
        this.log(`deploy ${d.id} expirado sin aprobación`, { deployId: d.id, repo: d.repo, scope: d.scope });
        metrics.deployFinished("expired");
        this.announce("deploy.expired", expired);
      }
    }
  }

  /**
   * Whether a deploy queued before a freeze window must wait for it to end. Forced deploys and automatic rollbacks
   * don't. One held longer than the CI expiry expires instead of going out by surprise much later.
   */
  private async heldByFreeze(d: DeployRecord): Promise<boolean> {
    if (d.forcedBy || d.rollbackOf) return false;
    const scope = await this.store.getScope(d.scopeId);
    if (!scope) return false;
    const freeze = activeFreeze(
      await this.store.freezesFor(scope.appId),
      { appId: scope.appId, scope: d.scope },
      this.now(),
    );
    if (!freeze) return false;
    const since = Date.parse(d.ciPassedAt ?? d.createdAt);
    if (this.now().getTime() - since > minutes(this.options.ciExpiryMinutes)) {
      const expired = await this.store.transition(d.id, "expired", this.now(), {
        error: `La ventana de congelamiento «${freeze.window.name}» no terminó en ${this.options.ciExpiryMinutes} min; pide el deploy de nuevo.`,
        from: "ci_passed",
      });
      if (expired) {
        metrics.deployFinished("expired");
        this.announce("deploy.expired", expired);
      }
    }
    return true;
  }

  private async startPassed(): Promise<void> {
    // One deploy at a time per scope, oldest first; the rest wait for the next tick.
    const busy = new Set((await this.store.listDeploys({ status: "deploying" })).map((d) => d.scopeId));
    for (const d of await this.store.listDeploys({ status: "ci_passed" })) {
      // Waits for a second member; it doesn't hold the scope for the deploys queued after it.
      if (d.approval?.status === "pending") continue;
      if (busy.has(d.scopeId)) continue;
      if (await this.heldByFreeze(d)) continue;
      busy.add(d.scopeId);
      await this.start(d);
    }
  }

  private async start(d: DeployRecord): Promise<void> {
    const scope = await this.store.getScope(d.scopeId);
    const startedAt = this.now();
    // Only the replica that claims the deploy calls Dokploy, and never while another deploy of the scope runs.
    if (!(await this.store.claimDeploy(d.id, d.scopeId, startedAt))) return;
    if (!scope) {
      await this.fail(d, "El scope ya no existe.");
      return;
    }
    try {
      const change = await this.dokploy.deploy(targetOf(scope), d.tag);
      this.log(`deploy ${d.id}: ${scope.alias} → ${change}`, {
        deployId: d.id,
        repo: d.repo,
        scope: d.scope,
        tag: d.tag,
      });
    } catch (error) {
      metrics.dokployError("deploy");
      await this.fail(d, (error as Error).message, scope);
    }
  }

  private async checkDeploying(): Promise<void> {
    for (const d of await this.store.listDeploys({ status: "deploying" })) {
      const scope = await this.store.getScope(d.scopeId);
      const startedAt = new Date(d.deployStartedAt ?? d.updatedAt);
      if (!scope) {
        await this.fail(d, "El scope ya no existe.");
        continue;
      }
      // Dokploy already finished this one: only its health check is pending.
      if (d.healthStatus === "checking") {
        await this.checkHealth(d, scope, startedAt);
        continue;
      }
      let status: DokployDeploymentStatus;
      let message: string | undefined;
      try {
        ({ status, message } = await this.dokploy.latestDeploymentStatus(targetOf(scope), startedAt));
      } catch (error) {
        // Transient: keep polling until the timeout below decides.
        metrics.dokployError("status");
        this.log(`deploy ${d.id}: no se pudo consultar Dokploy: ${(error as Error).message}`, { deployId: d.id });
        status = "running";
      }
      if (status === "done") {
        if (scope.healthCheck?.enabled) await this.checkHealth(d, scope, startedAt);
        else await this.succeed(d, startedAt);
      } else if (status === "error") {
        await this.fail(
          d,
          message || "Dokploy reportó un error en el deployment. Revisa los logs del servicio en Dokploy.",
          scope,
        );
      } else if (this.now().getTime() - startedAt.getTime() > minutes(this.options.deployTimeoutMinutes)) {
        await this.fail(d, `Dokploy no terminó el deployment en ${this.options.deployTimeoutMinutes} min.`, scope);
      }
    }
  }

  /**
   * One health check of a deploy Dokploy already finished, at most every `intervalSeconds`. The first healthy answer
   * completes the deploy; after `retries` unhealthy ones it fails (and rolls back, if the scope asks for it).
   */
  private async checkHealth(d: DeployRecord, scope: Scope, startedAt: Date): Promise<void> {
    const check = scope.healthCheck;
    // The health check was removed while this deploy waited on it: Dokploy's word is enough again.
    if (!check?.enabled) {
      await this.succeed(d, startedAt);
      return;
    }
    const last = d.healthCheckedAt ? Date.parse(d.healthCheckedAt) : undefined;
    if (last !== undefined && this.now().getTime() - last < check.intervalSeconds * 1000) return;
    // With several replicas, only the one that counts the attempt makes the call.
    if (!(await this.store.claimHealthAttempt(d.id, d.healthAttempts, this.now()))) return;
    const attempt = d.healthAttempts + 1;
    const result = await this.probe(check);
    metrics.healthCheck(result.ok);
    if (result.ok) {
      await this.succeed(d, startedAt, "passed");
      return;
    }
    this.log(`deploy ${d.id}: health check ${attempt}/${check.retries} falló: ${result.reason}`, {
      deployId: d.id,
      repo: d.repo,
      scope: d.scope,
      attempt,
    });
    if (attempt >= check.retries) {
      await this.fail(
        d,
        `El health check de ${scope.alias} falló ${attempt} ${attempt === 1 ? "vez" : "veces"}: ${result.reason ?? "sin respuesta"}.`,
        scope,
        "failed",
      );
    }
  }

  private async succeed(d: DeployRecord, startedAt: Date, healthStatus?: "passed"): Promise<void> {
    const done = await this.store.transition(d.id, "deployed", this.now(), { ...(healthStatus && { healthStatus }) });
    if (!done) return;
    this.log(`deploy ${d.id} completado`, { deployId: d.id, repo: d.repo, scope: d.scope, tag: d.tag });
    metrics.deployFinished("deployed", (this.now().getTime() - startedAt.getTime()) / 1000);
    this.announce("deploy.deployed", done);
  }

  /** Fails a deploy. With `scope` (a deploy that reached Dokploy), also starts its automatic rollback. */
  private async fail(d: DeployRecord, error: string, scope?: Scope, healthStatus?: "failed"): Promise<void> {
    // The worker only fails deploys it started: never one still waiting (a rejection does that, not the worker).
    const failed = await this.store.transition(d.id, "deploy_failed", this.now(), {
      error,
      from: "deploying",
      ...(healthStatus && { healthStatus }),
    });
    if (!failed) return;
    this.log(`deploy ${d.id} falló: ${error}`, { deployId: d.id, repo: d.repo, scope: d.scope, tag: d.tag });
    metrics.deployFinished("deploy_failed");
    this.announce("deploy.failed", failed);
    if (scope?.autoRollback) await this.rollBack(failed, scope);
  }

  /**
   * Queues a deploy of the version the scope ran before `failed`. It is born `ci_passed` (that version's CI passed
   * when it was first deployed) and skips locks, freeze windows and approvals: it only undoes a deploy that already
   * went through them. A rollback that fails is not rolled back again.
   */
  private async rollBack(failed: DeployRecord, scope: Scope): Promise<void> {
    if (failed.rollbackOf) return;
    const [previous] = await this.store.listDeploys(
      { scopeId: scope.id, status: "deployed" },
      { limit: 1, newestFirst: true },
    );
    if (!previous || previous.tag === failed.tag) {
      this.log(`deploy ${failed.id}: sin versión anterior a la que volver`, { deployId: failed.id });
      return;
    }
    const rollback = await this.store.insertDeploy(
      {
        repo: failed.repo,
        tag: previous.tag,
        sha: previous.sha,
        scope,
        status: "ci_passed",
        requestedBy: ROLLBACK_ACTOR,
        rollbackOf: failed.id,
      },
      this.now(),
    );
    await this.store.recordAudit(
      {
        actor: "keel",
        action: "deploy.rollback",
        repo: failed.repo,
        scope: scope.alias,
        details: { deployId: rollback.id, failedDeployId: failed.id, from: failed.tag, to: previous.tag },
      },
      this.now(),
    );
    this.log(`deploy ${failed.id}: rollback automático a ${previous.tag}`, {
      deployId: rollback.id,
      repo: failed.repo,
      scope: scope.alias,
      tag: previous.tag,
    });
    this.announce("deploy.rollback", rollback, { detail: `${failed.tag} falló: vuelve a ${previous.tag}.` });
  }
}
