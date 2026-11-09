import type { DokployClient, DokployDeploymentStatus, DokployTarget } from "./dokploy";
import type { DeployRecord, Scope, Store } from "./store";

export interface WorkerOptions {
  /** How long a deploy may sit in `waiting_ci` before it expires. */
  ciExpiryMinutes: number;
  /** How long Dokploy may take to finish a deployment before it's marked failed. */
  deployTimeoutMinutes: number;
  now?: () => Date;
  log?: (message: string) => void;
}

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
  private readonly log: (message: string) => void;

  constructor(
    private readonly store: Store,
    private readonly dokploy: DokployClient,
    private readonly options: WorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((m) => console.log(`[keel] ${m}`));
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireWaiting();
      // Check first so a finished deploy frees its scope for the next queued one in the same tick.
      await this.checkDeploying();
      await this.startPassed();
    } finally {
      this.running = false;
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
      });
      if (expired) this.log(`deploy ${d.id} expirado`);
    }
  }

  private async startPassed(): Promise<void> {
    // One deploy at a time per scope, oldest first; the rest wait for the next tick.
    const busy = new Set((await this.store.listDeploys({ status: "deploying" })).map((d) => d.scopeId));
    for (const d of await this.store.listDeploys({ status: "ci_passed" })) {
      if (busy.has(d.scopeId)) continue;
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
      this.log(`deploy ${d.id}: ${scope.alias} → ${change}`);
    } catch (error) {
      await this.fail(d, (error as Error).message);
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
      let status: DokployDeploymentStatus;
      let message: string | undefined;
      try {
        ({ status, message } = await this.dokploy.latestDeploymentStatus(targetOf(scope), startedAt));
      } catch (error) {
        // Transient: keep polling until the timeout below decides.
        this.log(`deploy ${d.id}: no se pudo consultar Dokploy: ${(error as Error).message}`);
        status = "running";
      }
      if (status === "done") {
        if (await this.store.transition(d.id, "deployed", this.now())) this.log(`deploy ${d.id} completado`);
      } else if (status === "error") {
        await this.fail(
          d,
          message || "Dokploy reportó un error en el deployment. Revisa los logs del servicio en Dokploy.",
        );
      } else if (this.now().getTime() - startedAt.getTime() > minutes(this.options.deployTimeoutMinutes)) {
        await this.fail(d, `Dokploy no terminó el deployment en ${this.options.deployTimeoutMinutes} min.`);
      }
    }
  }

  private async fail(d: DeployRecord, error: string): Promise<void> {
    if (await this.store.transition(d.id, "deploy_failed", this.now(), { error })) {
      this.log(`deploy ${d.id} falló: ${error}`);
    }
  }
}
