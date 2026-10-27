import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { addService } from "./scopes";
import { createTestContext, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };
const ciReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" as const };

describe("DeployWorker", () => {
  it("takes a deploy from waiting_ci to deployed", async () => {
    const { store, worker, dokploy, clock, ciToken } = createTestContext();
    const { id } = requestDeploy(store, deployReq, clock.now());

    await worker.tick();
    expect(store.getDeploy(id)?.status).toBe("waiting_ci");
    expect(dokploy.deployed).toEqual([]);

    recordCiResult(store, ciReq, ciToken, clock.now());
    await worker.tick();
    expect(store.getDeploy(id)?.status).toBe("deploying");
    expect(dokploy.deployed).toEqual([
      { target: { kind: "application", id: "app123", tagVariable: null }, tag: "v1.0.0" },
    ]);

    dokploy.status = "done";
    await worker.tick();
    expect(store.getDeploy(id)?.status).toBe("deployed");
  });

  it("expires deploys whose CI result never arrives", async () => {
    const { store, worker, clock } = createTestContext();
    const { id } = requestDeploy(store, deployReq, clock.now());

    clock.advanceMinutes(61);
    await worker.tick();
    expect(store.getDeploy(id)).toMatchObject({ status: "expired", error: expect.stringMatching(/60 min/) });
  });

  it("marks the deploy failed when Dokploy rejects it or reports an error", async () => {
    const rejected = createTestContext();
    recordCiResult(rejected.store, ciReq, rejected.ciToken, rejected.clock.now());
    const a = requestDeploy(rejected.store, deployReq, rejected.clock.now());
    rejected.dokploy.failWith = "Dokploy respondió 401";
    await rejected.worker.tick();
    expect(rejected.store.getDeploy(a.id)).toMatchObject({ status: "deploy_failed", error: "Dokploy respondió 401" });

    const errored = createTestContext();
    recordCiResult(errored.store, ciReq, errored.ciToken, errored.clock.now());
    const b = requestDeploy(errored.store, deployReq, errored.clock.now());
    await errored.worker.tick();
    errored.dokploy.status = "error";
    errored.dokploy.message = "pull access denied";
    await errored.worker.tick();
    expect(errored.store.getDeploy(b.id)).toMatchObject({ status: "deploy_failed", error: "pull access denied" });
  });

  it("fails a deployment that exceeds the timeout", async () => {
    const { store, worker, clock, ciToken } = createTestContext();
    recordCiResult(store, ciReq, ciToken, clock.now());
    const { id } = requestDeploy(store, deployReq, clock.now());
    await worker.tick();

    clock.advanceMinutes(16);
    await worker.tick();
    expect(store.getDeploy(id)).toMatchObject({ status: "deploy_failed", error: expect.stringMatching(/15 min/) });
  });

  it("deploys one version at a time per service", async () => {
    const { store, worker, dokploy, clock, ciToken, scope } = createTestContext();
    const otherSha = "b".repeat(40);
    recordCiResult(store, ciReq, ciToken, clock.now());
    recordCiResult(store, { ...ciReq, sha: otherSha, tag: "v1.0.1" }, ciToken, clock.now());
    const first = requestDeploy(store, deployReq, clock.now());
    const second = requestDeploy(store, { ...deployReq, sha: otherSha, tag: "v1.0.1" }, clock.now());
    addService(
      store,
      scope,
      { alias: "worker", dokployUrl: "https://dokploy.example.com/dashboard/project/p/services/application/w1" },
      clock.now(),
    );
    const parallel = requestDeploy(store, { ...deployReq, service: "worker" }, clock.now());

    await worker.tick();
    expect(store.getDeploy(first.id)?.status).toBe("deploying");
    expect(store.getDeploy(second.id)?.status).toBe("ci_passed");
    expect(store.getDeploy(parallel.id)?.status).toBe("deploying");

    dokploy.status = "done";
    await worker.tick();
    expect(store.getDeploy(first.id)?.status).toBe("deployed");
    expect(store.getDeploy(second.id)?.status).toBe("deploying");
  });

  it("deploys a Compose service by its tag variable", async () => {
    const { store, worker, dokploy, clock, ciToken, scope } = createTestContext();
    addService(
      store,
      scope,
      {
        alias: "staging",
        dokployUrl: "http://dokploy.jalocompany.internal/dashboard/project/p/environment/e/services/compose/cmp1",
      },
      clock.now(),
    );
    recordCiResult(store, ciReq, ciToken, clock.now());
    const { id } = requestDeploy(store, { ...deployReq, service: "staging" }, clock.now());

    await worker.tick();
    expect(dokploy.deployed).toEqual([
      { target: { kind: "compose", id: "cmp1", tagVariable: "DOCKER_TAG" }, tag: "v1.0.0" },
    ]);

    dokploy.status = "done";
    await worker.tick();
    expect(store.getDeploy(id)?.status).toBe("deployed");
  });
});
