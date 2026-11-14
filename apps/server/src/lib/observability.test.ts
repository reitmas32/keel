import { describe, expect, it, vi } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { formatLine } from "./log";
import { Metrics } from "./metrics";
import { healthResponse, metricsResponse } from "./observability";
import { apiRequest, createTestContext, SHA } from "./testing";

const TOKEN = "m".repeat(32);

describe("/api/health", () => {
  it("answers ok when the database does", async () => {
    const { ctx } = await createTestContext();
    const response = await healthResponse(async () => ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: "ok" });
  });

  it("answers 503 without details when the database doesn't", async () => {
    const { ctx, store } = await createTestContext();
    vi.spyOn(store, "ping").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=x"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await healthResponse(async () => ctx);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("10.0.0.5");
    spy.mockRestore();
    // A context that can't even open (Postgres down at boot) is a 503 too.
    expect((await healthResponse(() => Promise.reject(new Error("no db")))).status).toBe(503);
    vi.restoreAllMocks();
  });
});

describe("/api/metrics", () => {
  it("is off without KEEL_METRICS_TOKEN and needs the token with it", async () => {
    const { ctx } = await createTestContext();
    expect((await metricsResponse(ctx, apiRequest("/metrics"))).status).toBe(404);
    ctx.env.KEEL_METRICS_TOKEN = TOKEN;
    expect((await metricsResponse(ctx, apiRequest("/metrics"))).status).toBe(401);
    const wrong = { authorization: `Bearer ${"x".repeat(32)}` };
    expect((await metricsResponse(ctx, apiRequest("/metrics", { headers: wrong }))).status).toBe(401);
  });

  it("reports deploys by status and the worker's activity", async () => {
    const { ctx, store, worker, dokploy, clock, ciToken } = await createTestContext();
    ctx.env.KEEL_METRICS_TOKEN = TOKEN;
    await recordCiResult(
      store,
      { repo: "konectus-io/app", tag: "v1", sha: SHA, status: "success" },
      ciToken,
      clock.now(),
    );
    await requestDeploy(store, { repo: "konectus-io/app", tag: "v1", sha: SHA, scope: "api-prod" }, clock.now());
    await worker.tick();
    dokploy.status = "done";
    clock.advanceMinutes(2);
    await worker.tick();

    const response = await metricsResponse(
      ctx,
      apiRequest("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await response.text();
    expect(text).toContain('keel_deploys{status="deployed"} 1');
    expect(text).toContain('keel_deploys{status="waiting_ci"} 0');
    expect(text).toContain("keel_deploys_awaiting_approval 0");
    expect(text).toMatch(/keel_deploys_finished_total\{status="deployed"\} \d+/);
    expect(text).toMatch(/keel_worker_ticks_total\{result="ok"\} \d+/);
  });
});

describe("Metrics", () => {
  it("renders counters, histograms and escaped labels", () => {
    const m = new Metrics();
    m.deployFinished("deployed", 42);
    m.deployFinished("deploy_failed");
    m.notification('we"ird', false);
    const text = m.render();
    expect(text).toContain('keel_deploys_finished_total{status="deployed"} 1');
    expect(text).toContain('keel_deploy_duration_seconds_bucket{le="60"} 1');
    expect(text).toContain('keel_deploy_duration_seconds_bucket{le="30"} 0');
    expect(text).toContain("keel_deploy_duration_seconds_count 1");
    expect(text).toContain('keel_notifications_total{kind="we\\"ird",result="error"} 1');
    expect(text).toContain("keel_dokploy_errors_total 0");
  });
});

describe("structured logs", () => {
  it("writes one JSON object per line, or a line to read by eye", () => {
    const now = new Date("2026-11-13T00:00:00Z");
    expect(JSON.parse(formatLine("info", "deploy completado", { deployId: "d1" }, now, "json"))).toEqual({
      ts: "2026-11-13T00:00:00.000Z",
      level: "info",
      msg: "deploy completado",
      deployId: "d1",
    });
    expect(formatLine("warn", "x", { a: 1, b: "c" }, now, "text")).toMatch(
      /^\d\d:\d\d:\d\d\.\d{3} WARN {2}keel {2}x a=1 b=c$/,
    );
  });
});
