import type { Role } from "@keel/shared";
import { createApiToken } from "./api-auth";
import { addScope, createApp } from "./apps";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { openSqliteDb } from "./db-sqlite";
import {
  type DokployClient,
  type DokployDeploymentStatus,
  DokployError,
  type DokployServiceInfo,
  type DokployTarget,
} from "./dokploy";
import type { Env } from "./env";
import { type Member, Store } from "./store";
import { DeployWorker } from "./worker";

export const SHA = "a".repeat(40);

/**
 * The engine the store-backed tests run on: `sqlite` by default, `postgres` in the "server (postgres)" Vitest project
 * (PGlite, or the real server at TEST_POSTGRES_DSN).
 */
export const TEST_DB_ENGINE: "sqlite" | "postgres" = process.env.KEEL_TEST_DB === "postgres" ? "postgres" : "sqlite";

const opened: Db[] = [];

/**
 * A fresh, migrated database on TEST_DB_ENGINE. `replica()` opens a second connection to the same database, like
 * another keel replica would; SQLite in memory has no such thing, so there it returns the same handle.
 */
export async function openTestDb(): Promise<{ db: Db; replica: () => Promise<Db> }> {
  if (TEST_DB_ENGINE === "sqlite") {
    const db = openSqliteDb(":memory:");
    opened.push(db);
    return { db, replica: async () => db };
  }
  const { openPostgresTestDb } = await import("./testing-postgres");
  const { db, replica } = await openPostgresTestDb();
  opened.push(db);
  return {
    db,
    replica: async () => {
      const other = await replica();
      opened.push(other);
      return other;
    },
  };
}

export async function closeTestDbs(): Promise<void> {
  for (const db of opened.splice(0)) await db.close();
  if (TEST_DB_ENGINE === "postgres") await (await import("./testing-postgres")).closePostgresTestDbs();
}

/** Records calls and returns a scripted deployment status. */
export class FakeDokploy implements DokployClient {
  deployed: { target: DokployTarget; tag: string }[] = [];
  status: DokployDeploymentStatus = "running";
  message: string | undefined;
  failWith: string | undefined;

  async deploy(target: DokployTarget, tag: string) {
    if (this.failWith) throw new Error(this.failWith);
    this.deployed.push({ target, tag });
    return target.kind === "compose" ? `${target.tagVariable}=${tag}` : `ghcr.io/konectus-io/app:${tag}`;
  }

  async latestDeploymentStatus() {
    return { status: this.status, message: this.message };
  }

  /** Dokploy names by Dokploy service id; unknown ids describe as undefined, like an unreachable Dokploy. */
  names = new Map<string, string>([["app123", "DEV/production/app"]]);

  async describe(target: DokployTarget) {
    return this.names.get(target.id);
  }

  /** What `findService` and `listServices` see; `servicesError` makes both fail like an unreachable Dokploy. */
  services: DokployServiceInfo[] = [
    {
      kind: "application",
      id: "app123",
      name: "app",
      appName: "dev-app-x1",
      project: "DEV",
      environment: "production",
      dashboardUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e1/services/application/app123",
    },
    {
      kind: "compose",
      id: "cmp456",
      name: "worker",
      appName: null,
      project: "DEV",
      environment: "staging",
      dashboardUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e2/services/compose/cmp456",
    },
  ];
  servicesError: string | undefined;

  async findService(kind: DokployTarget["kind"], id: string) {
    if (this.servicesError) throw new DokployError(this.servicesError);
    return this.services.find((s) => s.kind === kind && s.id === id);
  }

  async listServices() {
    if (this.servicesError) throw new DokployError(this.servicesError);
    return this.services;
  }
}

export async function createTestContext() {
  let now = new Date("2026-10-26T12:00:00Z");
  const clock = {
    now: () => now,
    advanceMinutes: (m: number) => {
      now = new Date(now.getTime() + m * 60_000);
    },
  };
  const { db, replica } = await openTestDb();
  const store = new Store(db);
  const dokploy = new FakeDokploy();
  const worker = new DeployWorker(store, dokploy, {
    ciExpiryMinutes: 60,
    deployTimeoutMinutes: 15,
    now: clock.now,
    log: () => {},
  });
  const { app, ciToken } = await createApp(
    store,
    { name: "app", repoUrl: "https://github.com/konectus-io/app" },
    clock.now(),
  );
  const scope = await addScope(
    store,
    app,
    {
      alias: "api-prod",
      dokployUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e1/services/application/app123",
    },
    clock.now(),
  );
  const env = { KEEL_API_AUTH: "optional", KEEL_ANONYMOUS_ROLE: "deployer" } as Env;
  const ctx = { env, store, dokploy, worker, now: clock.now } as unknown as AppContext;
  return { ctx, env, db, replica, store, dokploy, worker, clock, app, scope, ciToken };
}

/** A request to an `/api` route, with an optional query string (`?a=b`), body and headers. */
export function apiRequest(
  query = "",
  { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return new Request(`http://keel.test/api${query}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

let memberCount = 0;

/** An active member with `role` and these grants (`[repo, scope, role]`). */
export async function addMember(
  store: Store,
  now: Date,
  { name, role = "deployer", grants = [] }: { name?: string; role?: Role; grants?: [string, string, Role][] } = {},
): Promise<Member> {
  const n = ++memberCount;
  const member = await store.createMember(
    { name: name ?? `miembro${n}`, email: `${name ?? "miembro"}${n}@example.com`, role, status: "active" },
    now,
  );
  for (const [repoPattern, scopePattern, grantRole] of grants) {
    await store.addGrant({ memberId: member.id, repoPattern, scopePattern, role: grantRole }, now);
  }
  return member;
}

/** A member (see addMember) and an API token of theirs, named like the member, optionally capped at `maxRole`. */
export async function memberToken(
  store: Store,
  now: Date,
  options: Parameters<typeof addMember>[2] & { maxRole?: Role } = {},
): Promise<{ member: Member; token: string; headers: { authorization: string } }> {
  const member = await addMember(store, now, options);
  const { token } = await createApiToken(
    store,
    { name: `${member.name}-${member.id.slice(0, 6)}`, owner: member, maxRole: options.maxRole ?? null },
    now,
  );
  return { member, token, headers: { authorization: `Bearer ${token}` } };
}
