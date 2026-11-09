import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { copySqliteToPostgres } from "../../scripts/sqlite-to-postgres.mjs";
import type { Db, SqlValue } from "./db";
import { openSqliteDb } from "./db-sqlite";
import { registerVersion, requestDeploy } from "./deploys";
import { BOOTSTRAP_ADMIN } from "./postgres-schema.mjs";
import { Store } from "./store";
import { openTestDb, SHA, TEST_DB_ENGINE } from "./testing";
import { expectV060Data, LEGACY_V060_DATA, SQLITE_V060_SCHEMA } from "./testing-legacy";

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
    const app = await source.createApp({ name: "app", repo: "konectus-io/app", ciTokenHash: "hash" }, now);
    const scope = await source.addScope(
      { appId: app.id, alias: "api-prod", dokployUrl: "u", kind: "compose", dokployId: "c1", tagVariable: "TAG" },
      now,
    );
    await registerVersion(source, { repo: "konectus-io/app", tag: "v1", sha: SHA, branch: "main" }, now);
    await requestDeploy(source, { repo: "konectus-io/app", tag: "v1", sha: SHA, scope: "api-prod" }, now, "rafa");
    await requestDeploy(source, { repo: "konectus-io/app", tag: "v2", sha: "b".repeat(40), scope: "api-prod" }, now);
    await source.upsertCiResult({ repo: "konectus-io/app", sha: SHA, tag: "v1", status: "success", receivedAt: "x" });
    const member = await source.createMember(
      { name: "Rafa", email: "rafa@example.com", role: "deployer", status: "active" },
      now,
    );
    await source.addGrant(
      { memberId: member.id, repoPattern: "konectus-io/*", scopePattern: "prod*", role: "viewer" },
      now,
    );
    await source.createInvite({ tokenHash: "ih", memberId: member.id, expiresAt: now });
    await source.createApiToken({ name: "rafa", tokenHash: "th", memberId: member.id, maxRole: "publisher" }, now);
    await source.recordAudit(
      { actor: "Rafa", actorMemberId: member.id, action: "lock.set", repo: "konectus-io/app" },
      now,
    );
    await source.recordAudit({ actor: "ci", action: "ci.result", details: { tag: "v1" } }, now);
    await source.lockScope({ scopeId: scope.id, reason: "release", lockedBy: "rafa" }, now);
    await sqliteDb.close();

    const { db } = await openTestDb();
    expect(await copy(db, path)).toEqual([
      { table: "apps", rows: 1 },
      { table: "scopes", rows: 1 },
      { table: "ci_results", rows: 1 },
      { table: "deploys", rows: 2 },
      { table: "versions", rows: 1 },
      // The bootstrap admin and Rafa.
      { table: "members", rows: 2 },
      { table: "member_grants", rows: 1 },
      { table: "invites", rows: 1 },
      { table: "api_tokens", rows: 1 },
      { table: "scope_locks", rows: 1 },
      { table: "audit_log", rows: 2 },
    ]);

    const before = new Store(openSqliteDb(path));
    const after = new Store(db);
    expect(await after.listApps()).toEqual(await before.listApps());
    expect(await after.listScopes(app.id)).toEqual(await before.listScopes(app.id));
    // Same order too: deploys created in the same millisecond keep SQLite's insertion order.
    expect(await after.listDeploys({}, { newestFirst: true })).toEqual(
      await before.listDeploys({}, { newestFirst: true }),
    );
    expect(await after.listVersions("konectus-io/app")).toEqual(await before.listVersions("konectus-io/app"));
    expect(await after.listApiTokens()).toEqual(await before.listApiTokens());
    expect(await after.listMembers()).toEqual(await before.listMembers());
    expect(await after.getMemberPasswordHash(member.id)).toBeNull();
    expect(await after.listGrants(member.id)).toEqual(await before.listGrants(member.id));
    expect(await after.getInvite("ih")).toEqual(await before.getInvite("ih"));
    // Same order too: entries written in the same millisecond keep SQLite's insertion order.
    expect(await after.listAudit()).toEqual(await before.listAudit());
    // The copied audit log keeps growing after the copied entries.
    await after.recordAudit({ actor: "x", action: "login" }, now);
    expect((await after.listAudit())[0]?.actor).toBe("x");
    expect(await after.getScopeLock(scope.id)).toEqual(await before.getScopeLock(scope.id));
    expect(await after.getCiTokenHash(app.id)).toBe("hash");

    await expect(copy(db, path)).rejects.toThrow(/ya tiene datos de keel: apps \(1\).*--force/);
    expect(await copy(db, path, true)).toContainEqual({ table: "deploys", rows: 2 });
    expect(await after.listDeploys()).toHaveLength(2);

    // The copied instance keeps working: a new deploy lands after the copied ones.
    await after.unlockScope(scope.id);
    const next = await requestDeploy(
      after,
      { repo: "konectus-io/app", tag: "v3", sha: "c".repeat(40), scope: "api-prod" },
      now,
    );
    expect((await after.listDeploys({}, { newestFirst: true }))[0]?.id).toBe(next.id);
  });

  it("gives the tokens of a database from before members to the bootstrap admin", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-copy-"));
    const path = join(dir, "v06.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, last_used_at TEXT);
      INSERT INTO api_tokens VALUES ('t1', 'rafa', 'h1', '2026-10-26T00:00:00Z', NULL);
    `);
    old.close();

    const { db } = await openTestDb();
    expect(await copy(db, path)).toContainEqual({ table: "api_tokens", rows: 1 });
    const store = new Store(db);
    expect(await store.listMembers()).toEqual([expect.objectContaining({ id: BOOTSTRAP_ADMIN.id, role: "admin" })]);
    expect(await store.listApiTokens()).toEqual([
      expect.objectContaining({ id: "t1", name: "rafa", memberId: BOOTSTRAP_ADMIN.id }),
    ]);
  });

  it("copies a v0.6.0 database (scopes and services) into the new names, without touching it", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-copy-"));
    const path = join(dir, "v060.db");
    const old = new DatabaseSync(path);
    old.exec(SQLITE_V060_SCHEMA);
    for (const statement of LEGACY_V060_DATA) old.exec(statement);
    old.close();

    const { db } = await openTestDb();
    expect(await copy(db, path)).toEqual([
      { table: "apps", rows: 1 },
      { table: "scopes", rows: 2 },
      { table: "ci_results", rows: 1 },
      { table: "deploys", rows: 2 },
      { table: "versions", rows: 1 },
      { table: "members", rows: 2 },
      { table: "member_grants", rows: 1 },
      { table: "invites", rows: 1 },
      { table: "api_tokens", rows: 1 },
      { table: "scope_locks", rows: 1 },
      { table: "audit_log", rows: 2 },
    ]);
    await expectV060Data(new Store(db));

    // The source keeps its old shape: the copy only reads it.
    const source = new DatabaseSync(path, { readOnly: true });
    const tables = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((r) => r.name)).toContain("services");
    source.close();
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
      { table: "apps", rows: 1 },
      { table: "scopes", rows: 1 },
    ]);
    expect(await new Store(db).getApp("s1")).toMatchObject({ repo: "jalo/app" });
    expect(await new Store(db).getScope("sv1")).toMatchObject({ appId: "s1", alias: "prod", tagVariable: null });
  });
});
