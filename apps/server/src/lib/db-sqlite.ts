import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, Row, SqlValue } from "./db";

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
  ci_passed_at      TEXT,
  finished_at       TEXT,
  requested_by      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deploys_status ON deploys (status, created_at);
CREATE INDEX IF NOT EXISTS deploys_repo_sha ON deploys (repo, sha);

-- v0.4.0: every version keel knows of, from \`keel create-version\` (pending) or from its CI result.
CREATE TABLE IF NOT EXISTS versions (
  repo             TEXT NOT NULL,
  tag              TEXT NOT NULL,
  sha              TEXT NOT NULL,
  branch           TEXT,
  created_by_name  TEXT,
  created_by_email TEXT,
  created_at       TEXT NOT NULL,
  ci_status        TEXT NOT NULL,
  ci_finished_at   TEXT,
  run_url          TEXT,
  PRIMARY KEY (repo, tag)
);

CREATE INDEX IF NOT EXISTS versions_repo_created ON versions (repo, created_at);
CREATE INDEX IF NOT EXISTS versions_status ON versions (ci_status, created_at);

-- v0.6.0: personal API tokens for the CLI. Only the sha256 of the token is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

-- v0.6.0: a locked service refuses new deploys until someone unlocks it.
CREATE TABLE IF NOT EXISTS service_locks (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  locked_by  TEXT,
  created_at TEXT NOT NULL
);
`;

/** Brings databases created by older keel versions up to the current schema. Each step is idempotent. */
function migrate(db: DatabaseSync): void {
  const serviceColumns = db
    .prepare("PRAGMA table_info(services)")
    .all()
    .map((c) => c.name);
  // v0.2.0: Compose services store the env variable that holds their image tag.
  if (!serviceColumns.includes("tag_variable")) db.exec("ALTER TABLE services ADD COLUMN tag_variable TEXT");

  const deployColumns = db
    .prepare("PRAGMA table_info(deploys)")
    .all()
    .map((c) => c.name);
  // v0.3.0: when the CI was approved and when the deploy reached a final state, for `keel deploys`.
  for (const column of ["ci_passed_at", "finished_at"]) {
    if (!deployColumns.includes(column)) db.exec(`ALTER TABLE deploys ADD COLUMN ${column} TEXT`);
  }
  // v0.6.0: the API token name that asked for the deploy.
  if (!deployColumns.includes("requested_by")) db.exec("ALTER TABLE deploys ADD COLUMN requested_by TEXT");
}

/** Statements straight on the connection: what a transaction's `tx` handle uses. */
class SqliteConnection implements Db {
  readonly dialect = "sqlite";

  constructor(protected readonly raw: DatabaseSync) {}

  async all(sql: string, params: SqlValue[] = []): Promise<Row[]> {
    return this.raw.prepare(sql).all(...params);
  }

  async get(sql: string, params: SqlValue[] = []): Promise<Row | undefined> {
    return this.raw.prepare(sql).get(...params);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    return { changes: Number(this.raw.prepare(sql).run(...params).changes) };
  }

  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  /** Already inside a transaction: join it. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    this.raw.close();
  }
}

/**
 * SQLite through node:sqlite. Statements are synchronous, so the only thing to guard is a transaction whose
 * callback awaits: while one is open, every other statement on this database waits for it to finish.
 * keel assumes a single process on SQLite; `BEGIN IMMEDIATE` and `busy_timeout` cover a stray second one.
 */
export class SqliteDb extends SqliteConnection {
  private openTx: Promise<void> | undefined;
  private readonly tx = new SqliteConnection(this.raw);

  // The `while` and the statement after it run in the same tick, so no transaction can slip in between.
  override async all(sql: string, params?: SqlValue[]) {
    while (this.openTx) await this.openTx;
    return this.tx.all(sql, params);
  }

  override async get(sql: string, params?: SqlValue[]) {
    while (this.openTx) await this.openTx;
    return this.tx.get(sql, params);
  }

  override async run(sql: string, params?: SqlValue[]) {
    while (this.openTx) await this.openTx;
    return this.tx.run(sql, params);
  }

  override async exec(sql: string) {
    while (this.openTx) await this.openTx;
    return this.tx.exec(sql);
  }

  override async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    while (this.openTx) await this.openTx;
    let finish = () => {};
    this.openTx = new Promise((resolve) => {
      finish = resolve;
    });
    try {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.tx);
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.openTx = undefined;
      finish();
    }
  }

  override async close(): Promise<void> {
    while (this.openTx) await this.openTx;
    this.raw.close();
  }
}

/** Opens (creating if needed) the SQLite database and applies the schema. Use ":memory:" in tests. */
export function openSqliteDb(path: string): SqliteDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  raw.exec(SCHEMA);
  migrate(raw);
  return new SqliteDb(raw);
}
