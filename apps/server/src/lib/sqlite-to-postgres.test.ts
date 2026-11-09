import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { copySqliteToPostgres } from "../../scripts/sqlite-to-postgres.mjs";
import type { Db, SqlValue } from "./db";
import { openSqliteDb } from "./db-sqlite";
import { registerVersion, requestDeploy } from "./deploys";
import { Store } from "./store";
import { openTestDb, SHA, TEST_DB_ENGINE } from "./testing";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs the script's copy inside one transaction of a test Postgres database, as the CLI does. */
const copy = (target: Db, sqlitePath: string, force = false) =>
  target.transaction(async (tx) => {
    const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      return await copySqliteToPostgres({
        sqlite,
        query: async (sql, params) => ({ rows: await tx.all(sql, params as SqlValue[]) }),
        force,
      });
    } finally {
      sqlite.close();
    }
  });

describe.runIf(TEST_DB_ENGINE === "postgres")("scripts/sqlite-to-postgres.mjs", () => {
  it("copies every table, keeps the JSON the API returns, and refuses a second copy without --force", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-copy-"));
    const path = join(dir, "keel.db");
    // Fill a real SQLite database through the Store, the way a running instance would.
    const sqliteDb = openSqliteDb(path);
    const source = new Store(sqliteDb);
    const now = new Date("2026-10-26T12:00:00Z");
    const scope = await source.createScope({ name: "app", repo: "konectus-io/app", ciTokenHash: "hash" }, now);
    const service = await source.addService(
      { scopeId: scope.id, alias: "api-prod", dokployUrl: "u", kind: "compose", dokployId: "c1", tagVariable: "TAG" },
      now,
    );
    await registerVersion(source, { repo: "konectus-io/app", tag: "v1", sha: SHA, branch: "main" }, now);
    await requestDeploy(source, { repo: "konectus-io/app", tag: "v1", sha: SHA, service: "api-prod" }, now, "rafa");
    await requestDeploy(source, { repo: "konectus-io/app", tag: "v2", sha: "b".repeat(40), service: "api-prod" }, now);
    await source.upsertCiResult({ repo: "konectus-io/app", sha: SHA, tag: "v1", status: "success", receivedAt: "x" });
    await source.createApiToken({ name: "rafa", tokenHash: "th" }, now);
    await source.lockService({ serviceId: service.id, reason: "release", lockedBy: "rafa" }, now);
    await sqliteDb.close();

    const { db } = await openTestDb();
    expect(await copy(db, path)).toEqual([
      { table: "scopes", rows: 1 },
      { table: "services", rows: 1 },
      { table: "ci_results", rows: 1 },
      { table: "deploys", rows: 2 },
      { table: "versions", rows: 1 },
      { table: "api_tokens", rows: 1 },
      { table: "service_locks", rows: 1 },
    ]);

    const before = new Store(openSqliteDb(path));
    const after = new Store(db);
    expect(await after.listScopes()).toEqual(await before.listScopes());
    expect(await after.listServices(scope.id)).toEqual(await before.listServices(scope.id));
    // Same order too: deploys created in the same millisecond keep SQLite's insertion order.
    expect(await after.listDeploys({}, { newestFirst: true })).toEqual(
      await before.listDeploys({}, { newestFirst: true }),
    );
    expect(await after.listVersions("konectus-io/app")).toEqual(await before.listVersions("konectus-io/app"));
    expect(await after.listApiTokens()).toEqual(await before.listApiTokens());
    expect(await after.getServiceLock(service.id)).toEqual(await before.getServiceLock(service.id));
    expect(await after.getCiTokenHash(scope.id)).toBe("hash");

    await expect(copy(db, path)).rejects.toThrow(/ya tiene datos de keel: scopes \(1\).*--force/);
    expect(await copy(db, path, true)).toContainEqual({ table: "deploys", rows: 2 });
    expect(await after.listDeploys()).toHaveLength(2);

    // The copied instance keeps working: a new deploy lands after the copied ones.
    await after.unlockService(service.id);
    const next = await requestDeploy(
      after,
      { repo: "konectus-io/app", tag: "v3", sha: "c".repeat(40), service: "api-prod" },
      now,
    );
    expect((await after.listDeploys({}, { newestFirst: true }))[0]?.id).toBe(next.id);
  });

  it("copies a v0.1.0 database that lacks newer columns and tables", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-copy-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE scopes (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE,
        ci_token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE services (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        alias TEXT NOT NULL, dokploy_url TEXT NOT NULL, kind TEXT NOT NULL, dokploy_id TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE (scope_id, alias));
      INSERT INTO scopes VALUES ('s1', 'app', 'jalo/app', 'hash', '2026-10-26T00:00:00Z');
      INSERT INTO services VALUES ('sv1', 's1', 'prod', 'https://d/services/application/a1', 'application', 'a1',
        '2026-10-26T00:00:00Z');
    `);
    old.close();

    const { db } = await openTestDb();
    const counts = await copy(db, path);
    expect(counts.filter((c) => c.rows > 0)).toEqual([
      { table: "scopes", rows: 1 },
      { table: "services", rows: 1 },
    ]);
    expect(await new Store(db).getService("sv1")).toMatchObject({ alias: "prod", tagVariable: null });
  });
});
