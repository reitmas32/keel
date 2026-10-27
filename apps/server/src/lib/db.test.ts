import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("openDb", () => {
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

    const store = new Store(openDb(path));
    expect(store.getService("sv1")).toMatchObject({ alias: "prod", kind: "application", tagVariable: null });
    const deployColumns = new DatabaseSync(path)
      .prepare("PRAGMA table_info(deploys)")
      .all()
      .map((c) => c.name);
    expect(deployColumns).toEqual(expect.arrayContaining(["ci_passed_at", "finished_at"]));
    // Opening again must not try to add the column twice.
    expect(() => openDb(path).close()).not.toThrow();
  });
});
