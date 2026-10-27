import type { AppContext } from "./context";
import { openDb } from "./db";
import type { DokployClient, DokployDeploymentStatus } from "./dokploy";
import { addService, createScope } from "./scopes";
import { Store } from "./store";
import { DeployWorker } from "./worker";

export const SHA = "a".repeat(40);

/** Records calls and returns a scripted deployment status. */
export class FakeDokploy implements DokployClient {
  deployed: { applicationId: string; tag: string }[] = [];
  status: DokployDeploymentStatus = "running";
  failWith: string | undefined;

  async deployImageTag(applicationId: string, tag: string) {
    if (this.failWith) throw new Error(this.failWith);
    this.deployed.push({ applicationId, tag });
    return `ghcr.io/konectus-io/app:${tag}`;
  }

  async latestDeploymentStatus() {
    return this.status;
  }
}

export function createTestContext() {
  let now = new Date("2026-10-26T12:00:00Z");
  const clock = {
    now: () => now,
    advanceMinutes: (m: number) => {
      now = new Date(now.getTime() + m * 60_000);
    },
  };
  const store = new Store(openDb(":memory:"));
  const dokploy = new FakeDokploy();
  const worker = new DeployWorker(store, dokploy, {
    ciExpiryMinutes: 60,
    deployTimeoutMinutes: 15,
    now: clock.now,
    log: () => {},
  });
  const { scope, ciToken } = createScope(
    store,
    { name: "app", repoUrl: "https://github.com/konectus-io/app" },
    clock.now(),
  );
  const service = addService(
    store,
    scope,
    {
      alias: "api-prod",
      dokployUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e1/services/application/app123",
    },
    clock.now(),
  );
  const ctx = { store, worker, now: clock.now } as unknown as AppContext;
  return { ctx, store, dokploy, worker, clock, scope, service, ciToken };
}
