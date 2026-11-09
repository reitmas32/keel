import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { createTestContext, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };
const ciReq = (status: "success" | "failure") => ({ repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status });

describe("requestDeploy", () => {
  it("waits for CI when no result was reported yet", async () => {
    const { store, clock } = await createTestContext();
    expect((await requestDeploy(store, deployReq, clock.now())).status).toBe("waiting_ci");
  });

  it("starts from ci_passed when the Action already reported success", async () => {
    const { store, clock, ciToken } = await createTestContext();
    await recordCiResult(store, ciReq("success"), ciToken, clock.now());
    expect((await requestDeploy(store, deployReq, clock.now())).status).toBe("ci_passed");
  });

  it("is ci_failed when the Action already reported failure", async () => {
    const { store, clock, ciToken } = await createTestContext();
    await recordCiResult(store, ciReq("failure"), ciToken, clock.now());
    const deploy = await requestDeploy(store, deployReq, clock.now());
    expect(deploy.status).toBe("ci_failed");
    expect(deploy.error).toMatch(/failure/);
  });

  it("matches the repo case-insensitively", async () => {
    const { store, clock } = await createTestContext();
    expect((await requestDeploy(store, { ...deployReq, repo: "Konectus-IO/App" }, clock.now())).repo).toBe(
      "konectus-io/app",
    );
  });

  it("returns the in-flight deploy instead of queuing a duplicate", async () => {
    const { store, clock } = await createTestContext();
    const first = await requestDeploy(store, deployReq, clock.now());
    expect((await requestDeploy(store, deployReq, clock.now())).id).toBe(first.id);
  });

  it("rejects an unlinked repo and an unknown service", async () => {
    const { store, clock } = await createTestContext();
    await expect(requestDeploy(store, { ...deployReq, repo: "other/repo" }, clock.now())).rejects.toThrow(
      /no está vinculado/,
    );
    await expect(requestDeploy(store, { ...deployReq, service: "nope" }, clock.now())).rejects.toThrow(
      /Disponibles: api-prod/,
    );
  });
});

describe("recordCiResult", () => {
  it("rejects a missing or wrong token", async () => {
    const { store, clock } = await createTestContext();
    await expect(recordCiResult(store, ciReq("success"), undefined, clock.now())).rejects.toThrow(
      /Token de CI inválido/,
    );
    await expect(recordCiResult(store, ciReq("success"), "keel_wrong", clock.now())).rejects.toThrow(
      /Token de CI inválido/,
    );
  });

  it("advances waiting deploys on success and fails them on failure", async () => {
    const ok = await createTestContext();
    const waiting = await requestDeploy(ok.store, deployReq, ok.clock.now());
    expect((await recordCiResult(ok.store, ciReq("success"), ok.ciToken, ok.clock.now())).updated).toHaveLength(1);
    expect((await ok.store.getDeploy(waiting.id))?.status).toBe("ci_passed");

    const ko = await createTestContext();
    const failing = await requestDeploy(ko.store, deployReq, ko.clock.now());
    await recordCiResult(ko.store, ciReq("failure"), ko.ciToken, ko.clock.now());
    expect((await ko.store.getDeploy(failing.id))?.status).toBe("ci_failed");
  });
});
