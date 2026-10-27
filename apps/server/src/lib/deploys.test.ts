import { describe, expect, it } from "vitest";
import { recordCiResult, requestDeploy } from "./deploys";
import { createTestContext, SHA } from "./testing";

const deployReq = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" };
const ciReq = (status: "success" | "failure") => ({ repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status });

describe("requestDeploy", () => {
  it("waits for CI when no result was reported yet", () => {
    const { store, clock } = createTestContext();
    expect(requestDeploy(store, deployReq, clock.now()).status).toBe("waiting_ci");
  });

  it("starts from ci_passed when the Action already reported success", () => {
    const { store, clock, ciToken } = createTestContext();
    recordCiResult(store, ciReq("success"), ciToken, clock.now());
    expect(requestDeploy(store, deployReq, clock.now()).status).toBe("ci_passed");
  });

  it("is ci_failed when the Action already reported failure", () => {
    const { store, clock, ciToken } = createTestContext();
    recordCiResult(store, ciReq("failure"), ciToken, clock.now());
    const deploy = requestDeploy(store, deployReq, clock.now());
    expect(deploy.status).toBe("ci_failed");
    expect(deploy.error).toMatch(/failure/);
  });

  it("matches the repo case-insensitively", () => {
    const { store, clock } = createTestContext();
    expect(requestDeploy(store, { ...deployReq, repo: "Konectus-IO/App" }, clock.now()).repo).toBe("konectus-io/app");
  });

  it("returns the in-flight deploy instead of queuing a duplicate", () => {
    const { store, clock } = createTestContext();
    const first = requestDeploy(store, deployReq, clock.now());
    expect(requestDeploy(store, deployReq, clock.now()).id).toBe(first.id);
  });

  it("rejects an unlinked repo and an unknown service", () => {
    const { store, clock } = createTestContext();
    expect(() => requestDeploy(store, { ...deployReq, repo: "other/repo" }, clock.now())).toThrow(/no está vinculado/);
    expect(() => requestDeploy(store, { ...deployReq, service: "nope" }, clock.now())).toThrow(/Disponibles: api-prod/);
  });
});

describe("recordCiResult", () => {
  it("rejects a missing or wrong token", () => {
    const { store, clock } = createTestContext();
    expect(() => recordCiResult(store, ciReq("success"), undefined, clock.now())).toThrow(/Token de CI inválido/);
    expect(() => recordCiResult(store, ciReq("success"), "keel_wrong", clock.now())).toThrow(/Token de CI inválido/);
  });

  it("advances waiting deploys on success and fails them on failure", () => {
    const ok = createTestContext();
    const waiting = requestDeploy(ok.store, deployReq, ok.clock.now());
    expect(recordCiResult(ok.store, ciReq("success"), ok.ciToken, ok.clock.now()).updated).toHaveLength(1);
    expect(ok.store.getDeploy(waiting.id)?.status).toBe("ci_passed");

    const ko = createTestContext();
    const failing = requestDeploy(ko.store, deployReq, ko.clock.now());
    recordCiResult(ko.store, ciReq("failure"), ko.ciToken, ko.clock.now());
    expect(ko.store.getDeploy(failing.id)?.status).toBe("ci_failed");
  });
});
