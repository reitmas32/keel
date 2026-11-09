import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlValue } from "./db";
import { toPostgresPlaceholders } from "./db-postgres";
import { openSqliteDb } from "./db-sqlite";
import { requestDeploy } from "./deploys";
import type { ApiError } from "./errors";
import { applyPostgresMigrations, BOOTSTRAP_ADMIN, POSTGRES_MIGRATIONS, TABLES } from "./postgres-schema.mjs";
import { Store } from "./store";
import { openTestDb, TEST_DB_ENGINE } from "./testing";
import {
  expectV050Data,
  expectV060Data,
  LEGACY_V050_DATA,
  LEGACY_V060_DATA,
  SQLITE_V050_SCHEMA,
  SQLITE_V060_SCHEMA,
} from "./testing-legacy";

let dir: string | undefined;

/** A SQLite file in a temporary directory, created with `sql` (a database as an older keel left it). */
async function oldSqliteDb(sql: string[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "keel-db-"));
  const path = join(dir, "keel.db");
  const old = new DatabaseSync(path);
  for (const statement of sql) old.exec(statement);
  old.close();
  return path;
}

/** The upgraded database keeps working: locks still refuse deploys, and deleting the app cascades. */
async function expectUpgradedDbWorks(store: Store, db: { all(sql: string): Promise<unknown[]> }) {
  const now = new Date("2026-10-27T00:00:00Z");
  const deploy = { repo: "konectus-io/app", tag: "v2", sha: "b".repeat(40) };
  await expect(requestDeploy(store, { ...deploy, scope: "prod" }, now)).rejects.toMatchObject({
    status: 423,
  } satisfies Partial<ApiError>);
  expect(await requestDeploy(store, { ...deploy, scope: "stg" }, now)).toMatchObject({ scopeId: "sv2", scope: "stg" });
  await store.deleteApp("s1");
  for (const table of ["scopes", "deploys", "scope_locks"]) expect(await db.all(`SELECT * FROM ${table}`)).toEqual([]);
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe.runIf(TEST_DB_ENGINE === "sqlite")("openSqliteDb", () => {
  it("migrates a v0.1.0 database, keeping its repo and services as an app and its scopes", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-db-"));
    const path = join(dir, "keel.db");
    // The scopes and services tables as keel v0.1.0 created them, with one Application already linked.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE scopes (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE,
        ci_token_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE services (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        alias TEXT NOT NULL, dokploy_url TEXT NOT NULL, kind TEXT NOT NULL, dokploy_id TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE (scope_id, alias));
      CREATE TABLE deploys (id TEXT PRIMARY KEY, repo TEXT NOT NULL, tag TEXT NOT NULL, sha TEXT NOT NULL,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE, service_alias TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, deploy_started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO scopes VALUES ('s1', 'app', 'jalo/app', 'hash', '2026-10-26T00:00:00Z');
      INSERT INTO services VALUES ('sv1', 's1', 'prod', 'https://d/services/application/a1', 'application', 'a1',
        '2026-10-26T00:00:00Z');
      INSERT INTO deploys VALUES ('d1', 'jalo/app', 'v1', 'abc1234', 'sv1', 'prod', 'deployed', NULL, NULL,
        '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z');
    `);
    old.close();

    const db = openSqliteDb(path);
    const store = new Store(db);
    expect(await store.getApp("s1")).toMatchObject({ name: "app", repo: "jalo/app" });
    expect(await store.getScope("sv1")).toMatchObject({
      appId: "s1",
      alias: "prod",
      kind: "application",
      tagVariable: null,
    });
    expect(await store.getDeploy("d1")).toMatchObject({ scopeId: "sv1", scope: "prod", requestedBy: null });
    const deployColumns = new DatabaseSync(path)
      .prepare("PRAGMA table_info(deploys)")
      .all()
      .map((c) => c.name);
    expect(deployColumns).toEqual(expect.arrayContaining(["ci_passed_at", "finished_at", "requested_by"]));
    expect(await store.listApiTokens()).toEqual([]);
    expect(await store.getScopeLock("sv1")).toBeUndefined();
    await db.close();
    // Opening again must not try to add the column twice.
    await expect(openSqliteDb(path).close()).resolves.toBeUndefined();
  });

  it("gives the API tokens of a v0.6.0 database to the bootstrap admin", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-db-"));
    const path = join(dir, "keel.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, last_used_at TEXT);
      INSERT INTO api_tokens VALUES ('t1', 'rafa', 'h1', '2026-10-26T00:00:00Z', NULL);
    `);
    old.close();

    const db = openSqliteDb(path);
    const store = new Store(db);
    expect(await store.getMember(BOOTSTRAP_ADMIN.id)).toMatchObject({
      name: "admin",
      email: "admin@localhost",
      role: "admin",
      status: "active",
      hasPassword: false,
    });
    expect(await store.listApiTokens()).toEqual([
      expect.objectContaining({
        id: "t1",
        name: "rafa",
        memberId: BOOTSTRAP_ADMIN.id,
        maxRole: null,
        ownerName: "admin",
      }),
    ]);
    await db.close();
    // Opening again neither duplicates the admin nor fails.
    const again = openSqliteDb(path);
    expect(await new Store(again).listMembers()).toHaveLength(1);
    await again.close();
  });

  it("upgrades a v0.5.0 database, keeping its deploys under the new names", async () => {
    const path = await oldSqliteDb([SQLITE_V050_SCHEMA, ...LEGACY_V050_DATA]);
    const db = openSqliteDb(path);
    await expectV050Data(new Store(db));
    await db.close();
  });

  it("upgrades a v0.6.0 database: tables, columns and foreign keys renamed, every row kept", async () => {
    const path = await oldSqliteDb([SQLITE_V060_SCHEMA, ...LEGACY_V060_DATA]);
    const db = openSqliteDb(path);
    const store = new Store(db);
    await expectV060Data(store);

    const raw = new DatabaseSync(path);
    const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(names.map((r) => r.name)).toEqual([...TABLES].sort());
    // No table, column, index or foreign key still says service.
    expect(raw.prepare("SELECT name, sql FROM sqlite_master WHERE sql LIKE '%service%'").all()).toEqual([]);
    const references = (table: string) =>
      raw
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((fk) => `${fk.from} -> ${fk.table}.${fk.to} ${fk.on_delete}`);
    expect(references("scopes")).toEqual(["app_id -> apps.id CASCADE"]);
    expect(references("deploys")).toEqual(["scope_id -> scopes.id CASCADE"]);
    expect(references("scope_locks")).toEqual(["scope_id -> scopes.id CASCADE"]);
    expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    raw.close();
    await db.close();

    // Opening it again changes nothing.
    const again = openSqliteDb(path);
    await expectV060Data(new Store(again));
    await expectUpgradedDbWorks(new Store(again), again);
    await again.close();
  });

  it("creates a fresh database with the new names directly", async () => {
    const { db } = await openTestDb();
    const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((r) => r.name)).toEqual([...TABLES].sort());
    expect(await db.all("SELECT name FROM sqlite_master WHERE sql LIKE '%service%'")).toEqual([]);
  });

  it("rolls back a transaction that throws, and other statements wait for an open one", async () => {
    const { db } = await openTestDb();
    const insert = (id: string) =>
      db.run("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [id, id, id, "t"]);
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES ('a', 'a', 'a', 't')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.all("SELECT id FROM api_tokens")).toEqual([]);

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tx = db.transaction(async (t) => {
      await gate;
      await t.run("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES ('tx', 'tx', 'tx', 't')");
    });
    const outside = insert("outside");
    release();
    await Promise.all([tx, outside]);
    expect((await db.all("SELECT id FROM api_tokens ORDER BY rowid")).map((r) => r.id)).toEqual(["tx", "outside"]);
  });
});

describe.runIf(TEST_DB_ENGINE === "postgres")("Postgres schema", () => {
  it("records each migration once, and opening again applies nothing", async () => {
    const { db, replica } = await openTestDb();
    const applied = await db.all("SELECT version FROM schema_migrations ORDER BY version");
    expect(applied.map((r) => Number(r.version))).toEqual(POSTGRES_MIGRATIONS.map((m) => m.version));

    // A second replica starting against the migrated database.
    const other = await replica();
    expect(await other.all("SELECT version FROM schema_migrations")).toHaveLength(POSTGRES_MIGRATIONS.length);
    const tables = await db.all(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
    );
    expect(tables.map((r) => r.table_name)).toEqual([
      "api_tokens",
      "apps",
      "audit_log",
      "ci_results",
      "deploys",
      "invites",
      "member_grants",
      "members",
      "schema_migrations",
      "scope_locks",
      "scopes",
      "versions",
    ]);
  });

  it("gives the API tokens of a database migrated before members to the bootstrap admin", async () => {
    const { db } = await openTestDb();
    // Back to the schema of migration 1, with a token from then.
    await db.exec("DROP TABLE audit_log, invites, member_grants CASCADE");
    await db.exec("ALTER TABLE api_tokens DROP COLUMN member_id, DROP COLUMN max_role");
    await db.exec("DROP TABLE members CASCADE");
    await db.run("DELETE FROM schema_migrations WHERE version >= 2");
    await db.run("INSERT INTO api_tokens (id, name, token_hash, created_at) VALUES ('t1', 'rafa', 'h1', 'x')");

    const applied = await db.transaction((tx) =>
      applyPostgresMigrations(async (sql, params) => ({ rows: await tx.all(sql, params as SqlValue[]) })),
    );
    expect(applied).toEqual(POSTGRES_MIGRATIONS.filter((m) => m.version >= 2).map((m) => m.version));
    const store = new Store(db);
    expect(await store.getMember(BOOTSTRAP_ADMIN.id)).toMatchObject({ role: "admin", status: "active" });
    expect((await store.getMember(BOOTSTRAP_ADMIN.id))?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await store.listApiTokens()).toEqual([
      expect.objectContaining({ id: "t1", memberId: BOOTSTRAP_ADMIN.id, ownerName: "admin" }),
    ]);
  });

  it("upgrades a v0.6.0 database in migration 3: tables, columns and constraints renamed, every row kept", async () => {
    const { db } = await openTestDb();
    // Back to an empty schema, migrated only as far as keel v0.6.0 did (migrations 1 and 2), with its data.
    await db.exec(`DROP TABLE ${[...TABLES, "schema_migrations"].join(", ")} CASCADE`);
    const v060 = POSTGRES_MIGRATIONS.filter((m) => m.version <= 2);
    for (const statement of v060.flatMap((m) => m.statements)) await db.exec(statement);
    await db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)");
    for (const m of v060) await db.run("INSERT INTO schema_migrations VALUES (?, ?, 'x')", [m.version, m.name]);
    for (const statement of LEGACY_V060_DATA) await db.exec(statement);

    const migrate = () =>
      db.transaction((tx) =>
        applyPostgresMigrations(async (sql, params) => ({ rows: await tx.all(sql, params as SqlValue[]) })),
      );
    expect(await migrate()).toEqual([3]);
    const store = new Store(db);
    await expectV060Data(store);

    const leftovers = await db.all(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()
         AND table_name LIKE '%service%'
       UNION ALL SELECT table_name || '.' || column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name LIKE '%service%'
       UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
         AND conname LIKE '%service%'
       UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE '%service%'`,
    );
    expect(leftovers).toEqual([]);
    const constraints = await db.all(
      `SELECT conrelid::regclass::text || ' ' || conname AS c FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace AND contype IN ('p', 'u', 'f')
         AND conrelid::regclass::text IN ('apps', 'scopes', 'deploys', 'scope_locks')
       ORDER BY 1`,
    );
    expect(constraints.map((r) => r.c)).toEqual([
      "apps apps_pkey",
      "apps apps_repo_key",
      "deploys deploys_pkey",
      "deploys deploys_scope_id_fkey",
      "scope_locks scope_locks_pkey",
      "scope_locks scope_locks_scope_id_fkey",
      "scopes scopes_app_id_alias_key",
      "scopes scopes_app_id_fkey",
      "scopes scopes_pkey",
    ]);

    // Already applied: nothing to do. And the renamed migration is harmless if it ever ran again.
    expect(await migrate()).toEqual([]);
    for (const statement of POSTGRES_MIGRATIONS[2]?.statements ?? []) await db.exec(statement);
    await expectV060Data(store);
    await expectUpgradedDbWorks(store, db);
  });

  it("cascades deletes like SQLite", async () => {
    const { db } = await openTestDb();
    const store = new Store(db);
    const now = new Date("2026-10-26T12:00:00Z");
    const app = await store.createApp({ name: "app", repo: "jalo/app", ciTokenHash: "h" }, now);
    const scope = await store.addScope(
      { appId: app.id, alias: "prod", dokployUrl: "u", kind: "application", dokployId: "a1", tagVariable: null },
      now,
    );
    await store.insertDeploy({ repo: "jalo/app", tag: "v1", sha: "s", scope, status: "waiting_ci" }, now);
    await store.lockScope({ scopeId: scope.id, reason: "x", lockedBy: null }, now);
    await store.deleteApp(app.id);
    expect(await db.all("SELECT * FROM scopes")).toEqual([]);
    expect(await db.all("SELECT * FROM deploys")).toEqual([]);
    expect(await db.all("SELECT * FROM scope_locks")).toEqual([]);
  });
});

describe("toPostgresPlaceholders", () => {
  it("numbers ? outside of quotes", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? LIMIT ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2 LIMIT $3",
    );
  });
});
