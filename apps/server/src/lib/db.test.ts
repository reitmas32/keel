import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlValue } from "./db";
import { toPostgresPlaceholders } from "./db-postgres";
import { openSqliteDb } from "./db-sqlite";
import { applyPostgresMigrations, BOOTSTRAP_ADMIN, POSTGRES_MIGRATIONS } from "./postgres-schema.mjs";
import { Store } from "./store";
import { openTestDb, TEST_DB_ENGINE } from "./testing";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe.runIf(TEST_DB_ENGINE === "sqlite")("openSqliteDb", () => {
  it("migrates a v0.1.0 database, keeping its services", async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-db-"));
    const path = join(dir, "keel.db");
    // The services table as keel v0.1.0 created it, with one Application already linked.
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

    const db = openSqliteDb(path);
    const store = new Store(db);
    expect(await store.getService("sv1")).toMatchObject({ alias: "prod", kind: "application", tagVariable: null });
    const deployColumns = new DatabaseSync(path)
      .prepare("PRAGMA table_info(deploys)")
      .all()
      .map((c) => c.name);
    expect(deployColumns).toEqual(expect.arrayContaining(["ci_passed_at", "finished_at", "requested_by"]));
    expect(await store.listApiTokens()).toEqual([]);
    expect(await store.getServiceLock("sv1")).toBeUndefined();
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
      "audit_log",
      "ci_results",
      "deploys",
      "invites",
      "member_grants",
      "members",
      "schema_migrations",
      "scopes",
      "service_locks",
      "services",
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

  it("cascades deletes like SQLite", async () => {
    const { db } = await openTestDb();
    const store = new Store(db);
    const now = new Date("2026-10-26T12:00:00Z");
    const scope = await store.createScope({ name: "app", repo: "jalo/app", ciTokenHash: "h" }, now);
    const service = await store.addService(
      { scopeId: scope.id, alias: "prod", dokployUrl: "u", kind: "application", dokployId: "a1", tagVariable: null },
      now,
    );
    await store.insertDeploy({ repo: "jalo/app", tag: "v1", sha: "s", service, status: "waiting_ci" }, now);
    await store.lockService({ serviceId: service.id, reason: "x", lockedBy: null }, now);
    await store.deleteScope(scope.id);
    expect(await db.all("SELECT * FROM services")).toEqual([]);
    expect(await db.all("SELECT * FROM deploys")).toEqual([]);
    expect(await db.all("SELECT * FROM service_locks")).toEqual([]);
  });
});

describe("toPostgresPlaceholders", () => {
  it("numbers ? outside of quotes", () => {
    expect(toPostgresPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? LIMIT ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2 LIMIT $3",
    );
  });
});
