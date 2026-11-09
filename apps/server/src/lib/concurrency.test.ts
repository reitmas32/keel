import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { addService } from "./scopes";
import { Store } from "./store";
import { createTestContext, SHA } from "./testing";
import { DeployWorker } from "./worker";

// On Postgres, `replica` is a second connection pool on the same database, like another keel replica; on SQLite it is
// the same connection, which still checks that interleaved async calls in one process don't double-run anything.

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };
const ciReq = { ...deployReq, status: "success" as const };

async function twoReplicas() {
  const t = await createTestContext();
  const other = new Store(await t.replica());
  const otherWorker = new DeployWorker(other, t.dokploy, {
    ciExpiryMinutes: 60,
    deployTimeoutMinutes: 15,
    now: t.clock.now,
    log: () => {},
  });
  return { ...t, other, otherWorker };
}

describe("several replicas on one database", () => {
  it("lets exactly one of two racing transitions win", async () => {
    const { store, other, clock } = await twoReplicas();
    // No CI result yet: the deploy is waiting_ci. Every transition below leaves from waiting_ci and none can follow
    // another (ci_passed can't go to ci_failed or expired, which are final), so exactly one may win in any order.
    // On real Postgres the calls run on separate connections: a loser either read waiting_ci and its conditional
    // UPDATE matched no row once the winner committed, or read the new state and was refused by the state machine.
    const { id } = await requestDeploy(store, deployReq, clock.now());

    const results = await Promise.all([
      store.transition(id, "ci_passed", clock.now()),
      other.transition(id, "ci_passed", clock.now()),
      other.transition(id, "ci_failed", clock.now(), { error: "x" }),
      store.transition(id, "expired", clock.now(), { error: "x" }),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect((await store.getDeploy(id))?.status).toBe(winners[0]?.status);
  });

  it("lets only one of two replicas move a deploy out of the state both read", async () => {
    const { store, other, clock, ciToken } = await twoReplicas();
    await recordCiResult(store, ciReq, ciToken, clock.now());
    const { id } = await requestDeploy(store, deployReq, clock.now());

    const results = await Promise.all([
      store.transition(id, "deploying", clock.now()),
      other.transition(id, "deploying", clock.now()),
      other.transition(id, "deploying", clock.now()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("never starts the same deploy twice, nor two deploys of one service", async () => {
    const { store, worker, otherWorker, dokploy, clock, ciToken, scope } = await twoReplicas();
    await addService(
      store,
      scope,
      { alias: "worker", dokployUrl: "https://dokploy.example.com/dashboard/project/p/services/application/w1" },
      clock.now(),
    );
    const otherSha = "b".repeat(40);
    await recordCiResult(store, ciReq, ciToken, clock.now());
    await recordCiResult(store, { ...ciReq, sha: otherSha, tag: "v1.0.1" }, ciToken, clock.now());
    await requestDeploy(store, deployReq, clock.now());
    await requestDeploy(store, { ...deployReq, sha: otherSha, tag: "v1.0.1" }, clock.now());
    await requestDeploy(store, { ...deployReq, service: "worker" }, clock.now());

    await Promise.all([worker.tick(), otherWorker.tick(), worker.tick(), otherWorker.tick()]);

    expect(dokploy.deployed.map((d) => `${d.target.id}@${d.tag}`).sort()).toEqual(["app123@v1.0.0", "w1@v1.0.0"]);
    const deploying = await store.listDeploys({ status: "deploying" });
    expect(deploying.map((d) => d.service).sort()).toEqual(["api-prod", "worker"]);
  });

  it("refuses to claim a deploy while another deploy of the service is deploying", async () => {
    const { store, other, clock, ciToken, service } = await twoReplicas();
    await recordCiResult(store, ciReq, ciToken, clock.now());
    await recordCiResult(store, { ...ciReq, sha: "b".repeat(40), tag: "v2" }, ciToken, clock.now());
    const first = await requestDeploy(store, deployReq, clock.now());
    const second = await requestDeploy(store, { ...deployReq, sha: "b".repeat(40), tag: "v2" }, clock.now());

    const [a, b] = await Promise.all([
      store.claimDeploy(first.id, service.id, clock.now()),
      other.claimDeploy(second.id, service.id, clock.now()),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await store.listDeploys({ status: "deploying" })).toHaveLength(1);
  });

  it("queues one deploy when the same `keel deploy` arrives twice at once", async () => {
    const { store, other, clock } = await twoReplicas();
    const [a, b] = await Promise.all([
      requestDeploy(store, deployReq, clock.now()),
      requestDeploy(other, deployReq, clock.now()),
    ]);
    expect(a.id).toBe(b.id);
    expect(await store.listDeploys()).toHaveLength(1);
  });

  it("doesn't leave a deploy waiting for a CI result that arrived at the same time", async () => {
    const { store, other, clock, ciToken } = await twoReplicas();
    const [deploy] = await Promise.all([
      requestDeploy(store, deployReq, clock.now()),
      recordCiResult(other, ciReq, ciToken, clock.now()),
    ]);
    expect((await store.getDeploy(deploy.id))?.status).toBe("ci_passed");
  });
});
