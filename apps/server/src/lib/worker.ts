import type { DokployClient } from "./dokploy";
import type { DeployRecord, Store } from "./store";

export interface WorkerOptions {
  /** How long a deploy may sit in `waiting_ci` before it expires. */
  ciExpiryMinutes: number;
  /** How long Dokploy may take to finish a deployment before it's marked failed. */
  deployTimeoutMinutes: number;
  now?: () => Date;
  log?: (message: string) => void;
}

const minutes = (n: number) => n * 60_000;

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
      this.expireWaiting();
      // Check first so a finished deploy frees its service for the next queued one in the same tick.
      await this.checkDeploying();
      await this.startPassed();
    } finally {
      this.running = false;
    }
  }

  private expireWaiting(): void {
    const cutoff = this.now().getTime() - minutes(this.options.ciExpiryMinutes);
    for (const d of this.store.listDeploys({ status: "waiting_ci" })) {
      if (Date.parse(d.createdAt) < cutoff) {
        this.store.transition(d.id, "expired", this.now(), {
          error: `No llegó el resultado del CI en ${this.options.ciExpiryMinutes} min.`,
        });
        this.log(`deploy ${d.id} expirado`);
      }
    }
  }

  private async startPassed(): Promise<void> {
    // One deploy at a time per service, oldest first; the rest wait for the next tick.
    const busy = new Set(this.store.listDeploys({ status: "deploying" }).map((d) => d.serviceId));
    for (const d of this.store.listDeploys({ status: "ci_passed" })) {
      if (busy.has(d.serviceId)) continue;
      busy.add(d.serviceId);
      await this.start(d);
    }
  }

  private async start(d: DeployRecord): Promise<void> {
    const service = this.store.getService(d.serviceId);
    const startedAt = this.now();
    if (!this.store.transition(d.id, "deploying", startedAt, { deployStartedAt: startedAt })) return;
    if (!service) {
      this.fail(d, "El servicio ya no existe.");
      return;
    }
    try {
      const image = await this.dokploy.deployImageTag(service.dokployId, d.tag);
      this.log(`deploy ${d.id}: ${service.alias} → ${image}`);
    } catch (error) {
      this.fail(d, (error as Error).message);
    }
  }

  private async checkDeploying(): Promise<void> {
    for (const d of this.store.listDeploys({ status: "deploying" })) {
      const service = this.store.getService(d.serviceId);
      const startedAt = new Date(d.deployStartedAt ?? d.updatedAt);
      if (!service) {
        this.fail(d, "El servicio ya no existe.");
        continue;
      }
      let status: Awaited<ReturnType<DokployClient["latestDeploymentStatus"]>>;
      try {
        status = await this.dokploy.latestDeploymentStatus(service.dokployId, startedAt);
      } catch (error) {
        // Transient: keep polling until the timeout below decides.
        this.log(`deploy ${d.id}: no se pudo consultar Dokploy: ${(error as Error).message}`);
        status = "running";
      }
      if (status === "done") {
        this.store.transition(d.id, "deployed", this.now());
        this.log(`deploy ${d.id} completado`);
      } else if (status === "error") {
        this.fail(d, "Dokploy reportó un error en el deployment. Revisa los logs del servicio.");
      } else if (this.now().getTime() - startedAt.getTime() > minutes(this.options.deployTimeoutMinutes)) {
        this.fail(d, `Dokploy no terminó el deployment en ${this.options.deployTimeoutMinutes} min.`);
      }
    }
  }

  private fail(d: DeployRecord, error: string): void {
    this.store.transition(d.id, "deploy_failed", this.now(), { error });
    this.log(`deploy ${d.id} falló: ${error}`);
  }
}
