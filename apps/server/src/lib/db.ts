import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo          TEXT NOT NULL UNIQUE,
  ci_token_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id          TEXT PRIMARY KEY,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  dokploy_url TEXT NOT NULL,
  kind        TEXT NOT NULL,
  dokploy_id  TEXT NOT NULL,
  tag_variable TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (scope_id, alias)
);

CREATE TABLE IF NOT EXISTS ci_results (
  repo        TEXT NOT NULL,
  sha         TEXT NOT NULL,
  tag         TEXT NOT NULL,
  status      TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);

CREATE TABLE IF NOT EXISTS deploys (
  id                TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  tag               TEXT NOT NULL,
  sha               TEXT NOT NULL,
  service_id        TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  service_alias     TEXT NOT NULL,
  status            TEXT NOT NULL,
  error             TEXT,
  deploy_started_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deploys_status ON deploys (status, created_at);
CREATE INDEX IF NOT EXISTS deploys_repo_sha ON deploys (repo, sha);
`;

/** Opens (creating if needed) the SQLite database and applies the schema. Use ":memory:" in tests. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Brings databases created by older keel versions up to the current schema. Each step is idempotent. */
function migrate(db: DatabaseSync): void {
  const serviceColumns = db
    .prepare("PRAGMA table_info(services)")
    .all()
    .map((c) => c.name);
  // v0.2.0: Compose services store the env variable that holds their image tag.
  if (!serviceColumns.includes("tag_variable")) db.exec("ALTER TABLE services ADD COLUMN tag_variable TEXT");
}
