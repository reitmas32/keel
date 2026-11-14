/**
 * In-process counters and histograms for `/metrics` (Prometheus text format). They start at zero with the process;
 * with several replicas each one reports its own, and Prometheus adds them up. What lives in the database (deploys
 * by status) is read at scrape time instead (see the /api/metrics route).
 */
type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return lines;
  }
}

const DURATION_BUCKETS = [5, 15, 30, 60, 120, 300, 600, 900, 1800];

class Histogram {
  private readonly counts = DURATION_BUCKETS.map(() => 0);
  private sum = 0;
  private count = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(seconds: number): void {
    this.sum += seconds;
    this.count += 1;
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
      ...DURATION_BUCKETS.map((le, i) => `${this.name}_bucket{le="${le}"} ${this.counts[i]}`),
      `${this.name}_bucket{le="+Inf"} ${this.count}`,
      `${this.name}_sum ${this.sum}`,
      `${this.name}_count ${this.count}`,
    ];
  }
}

export class Metrics {
  private readonly finished = new Counter("keel_deploys_finished_total", "Deploys que llegaron a un estado final.");
  private readonly duration = new Histogram(
    "keel_deploy_duration_seconds",
    "Segundos entre que keel llama a Dokploy y el deploy queda desplegado.",
  );
  private readonly dokployErrors = new Counter("keel_dokploy_errors_total", "Llamadas a Dokploy que fallaron.");
  private readonly notifications = new Counter("keel_notifications_total", "Notificaciones enviadas, por resultado.");
  private readonly ticks = new Counter("keel_worker_ticks_total", "Vueltas del worker, por resultado.");
  private readonly healthChecks = new Counter("keel_health_checks_total", "Health checks tras un deploy.");
  private lastTickAt: number | undefined;

  deployFinished(status: string, durationSeconds?: number): void {
    this.finished.inc({ status });
    if (durationSeconds !== undefined && durationSeconds >= 0) this.duration.observe(durationSeconds);
  }
  dokployError(operation: string): void {
    this.dokployErrors.inc({ operation });
  }
  notification(kind: string, ok: boolean): void {
    this.notifications.inc({ kind, result: ok ? "ok" : "error" });
  }
  workerTick(ok: boolean, at: Date): void {
    this.ticks.inc({ result: ok ? "ok" : "error" });
    if (ok) this.lastTickAt = at.getTime() / 1000;
  }
  healthCheck(ok: boolean): void {
    this.healthChecks.inc({ result: ok ? "ok" : "error" });
  }

  /** The process metrics, one line each. `extra` are lines computed by the caller (gauges read from the database). */
  render(extra: string[] = []): string {
    const lines = [
      ...this.finished.render(),
      ...this.duration.render(),
      ...this.dokployErrors.render(),
      ...this.notifications.render(),
      ...this.healthChecks.render(),
      ...this.ticks.render(),
      "# HELP keel_worker_last_tick_timestamp_seconds Cuándo terminó bien la última vuelta del worker (epoch).",
      "# TYPE keel_worker_last_tick_timestamp_seconds gauge",
      `keel_worker_last_tick_timestamp_seconds ${this.lastTickAt ?? 0}`,
      ...extra,
    ];
    return `${lines.join("\n")}\n`;
  }
}

// One registry per process, shared across Next's module chunks and dev reloads.
const globalForMetrics = globalThis as typeof globalThis & { keelMetrics?: Metrics };
globalForMetrics.keelMetrics ??= new Metrics();
export const metrics: Metrics = globalForMetrics.keelMetrics;
