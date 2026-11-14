import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, Row, SqlValue } from "./db";
import { BOOTSTRAP_ADMIN, bootstrapAdminSql } from "./postgres-schema.mjs";

const SCHEMA = `
-- v0.7.0: an app is a linked GitHub repo (the \`scopes\` table before v0.7.0).
CREATE TABLE IF NOT EXISTS apps (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo          TEXT NOT NULL UNIQUE,
  ci_token_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- v0.7.0: a scope is a deploy target of an app, pointing at a Dokploy application or compose (the \`services\` table
-- before v0.7.0).
CREATE TABLE IF NOT EXISTS scopes (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  dokploy_url  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  dokploy_id   TEXT NOT NULL,
  tag_variable TEXT,
  created_at   TEXT NOT NULL,
  -- v0.10.0: JSON { enabled, url, expectedStatus, retries, intervalSeconds, timeoutSeconds }; NULL: no health check.
  health_check TEXT,
  auto_rollback INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, alias)
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
  scope_id          TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  scope_alias       TEXT NOT NULL,
  status            TEXT NOT NULL,
  error             TEXT,
  deploy_started_at TEXT,
  ci_passed_at      TEXT,
  finished_at       TEXT,
  requested_by      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- v0.10.0: the scope's health check after Dokploy finished, and the failed deploy an automatic rollback undoes.
  health_status     TEXT,
  health_attempts   INTEGER NOT NULL DEFAULT 0,
  health_checked_at TEXT,
  rollback_of       TEXT
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

-- v0.6.0: people who use keel, with a role and per-repo/scope grants. Only a scrypt hash of the password is stored.
CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  password_hash TEXT,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS member_grants (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  repo_pattern  TEXT NOT NULL DEFAULT '*',
  scope_pattern TEXT NOT NULL DEFAULT '*',
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS member_grants_member ON member_grants (member_id);

-- v0.6.0: one-time links to set a password. Only the sha256 of the token is stored.
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS invites_member ON invites (member_id);

-- v0.6.0: personal API tokens for the CLI, owned by a member (member_id) and optionally capped below the owner's role
-- (max_role). Only the sha256 of the token is stored.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  member_id    TEXT REFERENCES members(id) ON DELETE CASCADE,
  max_role     TEXT
);

-- v0.6.0: a locked scope refuses new deploys until someone unlocks it (\`service_locks\` before v0.7.0).
CREATE TABLE IF NOT EXISTS scope_locks (
  scope_id   TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  locked_by  TEXT,
  created_at TEXT NOT NULL
);

-- v0.6.0: every change made through the API or the admin, and who made it.
CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,
  actor_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  repo            TEXT,
  scope           TEXT,
  details         TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_log_repo ON audit_log (repo, at);

-- v0.10.0: where keel sends deploy notifications (Slack, Discord or a generic webhook). The URL is a secret.
CREATE TABLE IF NOT EXISTS notification_channels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  secret        TEXT,
  events        TEXT NOT NULL DEFAULT '*',
  repo_pattern  TEXT NOT NULL DEFAULT '*',
  scope_pattern TEXT NOT NULL DEFAULT '*',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
`;

const tableExists = (db: DatabaseSync, table: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const columnsOf = (db: DatabaseSync, table: string): string[] =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name as string);

/**
 * v0.7.0 renamed the linked repo from scope to app and its deploy targets from service to scope. Before v0.7.0:
 * \`scopes\` (repos), \`services\` (targets, with \`scope_id\`), \`service_locks\`, \`deploys.service_id/service_alias\`,
 * \`member_grants.service_pattern\` and \`audit_log.service\`. Runs before SCHEMA, which would otherwise create empty
 * \`apps\` and \`scope_locks\` tables next to the old ones.
 *
 * The names swap, so the order matters: \`scopes\` becomes \`apps\` before \`services\` becomes \`scopes\`. Each step looks
 * at the current shape first, so it is idempotent and works from any older version (tables a version didn't have
 * are skipped; SCHEMA creates them). With \`legacy_alter_table\` off, SQLite rewrites the foreign keys that point at a
 * renamed table or column, so cascades keep working. All of it runs in one transaction.
 */
export function renameScopesToApps(db: DatabaseSync): void {
  db.exec("PRAGMA legacy_alter_table = OFF");
  const renameColumn = (table: string, from: string, to: string) => {
    if (!tableExists(db, table)) return;
    const columns = columnsOf(db, table);
    if (columns.includes(from) && !columns.includes(to)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    // The old \`scopes\` is the repo table: it has the CI token. The new one never does.
    if (tableExists(db, "scopes") && columnsOf(db, "scopes").includes("ci_token_hash") && !tableExists(db, "apps")) {
      db.exec("ALTER TABLE scopes RENAME TO apps");
    }
    if (tableExists(db, "services") && !tableExists(db, "scopes")) db.exec("ALTER TABLE services RENAME TO scopes");
    if (tableExists(db, "service_locks") && !tableExists(db, "scope_locks")) {
      db.exec("ALTER TABLE service_locks RENAME TO scope_locks");
    }
    renameColumn("scopes", "scope_id", "app_id");
    renameColumn("deploys", "service_id", "scope_id");
    renameColumn("deploys", "service_alias", "scope_alias");
    renameColumn("scope_locks", "service_id", "scope_id");
    renameColumn("member_grants", "service_pattern", "scope_pattern");
    renameColumn("audit_log", "service", "scope");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Brings databases created by older keel versions up to the current schema. Each step is idempotent. */
function migrate(db: DatabaseSync): void {
  // v0.2.0: Compose scopes store the env variable that holds their image tag.
  if (!columnsOf(db, "scopes").includes("tag_variable")) db.exec("ALTER TABLE scopes ADD COLUMN tag_variable TEXT");

  const deployColumns = columnsOf(db, "deploys");
  // v0.3.0: when the CI was approved and when the deploy reached a final state, for \`keel deploys\`.
  for (const column of ["ci_passed_at", "finished_at"]) {
    if (!deployColumns.includes(column)) db.exec(`ALTER TABLE deploys ADD COLUMN ${column} TEXT`);
  }
  // v0.6.0: the API token name that asked for the deploy.
  if (!deployColumns.includes("requested_by")) db.exec("ALTER TABLE deploys ADD COLUMN requested_by TEXT");

  // v0.10.0: health check and automatic rollback per scope.
  const addColumns = (table: string, columns: Record<string, string>) => {
    const existing = columnsOf(db, table);
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  addColumns("scopes", { health_check: "TEXT", auto_rollback: "INTEGER NOT NULL DEFAULT 0" });
  addColumns("deploys", {
    health_status: "TEXT",
    health_attempts: "INTEGER NOT NULL DEFAULT 0",
    health_checked_at: "TEXT",
    rollback_of: "TEXT",
  });

  const tokenColumns = columnsOf(db, "api_tokens");
  // v0.6.0: tokens belong to a member and can be capped to a role. Tokens from before belong to the bootstrap admin.
  if (!tokenColumns.includes("member_id")) {
    db.exec("ALTER TABLE api_tokens ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE CASCADE");
  }
  if (!tokenColumns.includes("max_role")) db.exec("ALTER TABLE api_tokens ADD COLUMN max_role TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS api_tokens_member ON api_tokens (member_id)");
  db.exec(bootstrapAdminSql("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"));
  db.prepare("UPDATE api_tokens SET member_id = ? WHERE member_id IS NULL").run(BOOTSTRAP_ADMIN.id);
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
  renameScopesToApps(raw);
  raw.exec(SCHEMA);
  migrate(raw);
  return new SqliteDb(raw);
}
