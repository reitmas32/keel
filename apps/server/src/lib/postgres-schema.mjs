// Postgres schema for keel, shared by the server (src/lib/db-postgres.ts) and scripts/sqlite-to-postgres.mjs.
// Plain JS so the one-shot script can import it with `node`, without a TypeScript step.

// Byte order, like SQLite's BINARY collation, so ORDER BY and LIKE behave the same in both engines.
const TEXT = 'TEXT COLLATE "C"';

/**
 * The member that owns the API tokens created before members existed, and the one `KEEL_ADMIN_PASSWORD` signs in as
 * (break-glass). It has no password of its own. Both engines create it in their members migration.
 */
export const BOOTSTRAP_ADMIN = Object.freeze({ id: "bootstrap-admin", name: "admin", email: "admin@localhost" });

/** SQL for "now" as an ISO-8601 UTC string, the format keel stores dates in. */
export const POSTGRES_NOW_ISO = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Key of the advisory lock that serializes migrations when several replicas start at once. */
export const MIGRATION_LOCK_KEY = 0x6b65656c; // "keel"

// Renames for migration 3, written as DO blocks that check the current shape first, so a retry is harmless like the
// IF NOT EXISTS of the others. Names are keel's own identifiers, never user input.

/** @param {string} from @param {string} to */
function renameTable(from, to) {
  return `DO $$ BEGIN
    IF to_regclass('${from}') IS NOT NULL AND to_regclass('${to}') IS NULL THEN
      ALTER TABLE ${from} RENAME TO ${to};
    END IF;
  END $$`;
}

/** @param {string} table @param {string} from @param {string} to */
function renameColumn(table, from, to) {
  return `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = '${from}') THEN
      ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to};
    END IF;
  END $$`;
}

/**
 * Renames the constraints of `table` that Postgres named after its old table and column names (`<table>_pkey`,
 * `<table>_<column>_fkey`, `<table>_<columns>_key` and, since Postgres 18, `<table>_<column>_not_null`). Renaming a
 * primary key or unique constraint renames its index too.
 *
 * @param {string} table
 * @param {string} oldPrefix the table's name when Postgres named its constraints
 * @param {string} newPrefix
 * @param {Record<string, string>} columns old column name to new one
 */
function renameConstraints(table, oldPrefix, newPrefix, columns) {
  const replaceColumns = Object.entries(columns)
    .map(([from, to]) => `\n      renamed := replace(renamed, '_${from}_', '_${to}_');`)
    .join("");
  return `DO $$
  DECLARE
    r record;
    renamed text;
  BEGIN
    FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('${table}') LOOP
      renamed := r.conname;
      IF starts_with(renamed, '${oldPrefix}_') THEN
        renamed := '${newPrefix}' || substr(renamed, ${oldPrefix.length + 1});
      END IF;${replaceColumns}
      IF renamed <> r.conname THEN
        EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', '${table}', r.conname, renamed);
      END IF;
    END LOOP;
  END $$`;
}

/**
 * Ordered migrations. Each one runs once, inside a transaction, and is recorded in `schema_migrations`.
 * Statements use IF NOT EXISTS so a half-applied database can be retried. Append new versions; never edit old ones.
 */
export const POSTGRES_MIGRATIONS = [
  {
    version: 1,
    name: "esquema inicial (equivalente a SQLite v0.6.0)",
    statements: [
      `CREATE TABLE IF NOT EXISTS scopes (
        id            ${TEXT} PRIMARY KEY,
        name          ${TEXT} NOT NULL,
        repo          ${TEXT} NOT NULL UNIQUE,
        ci_token_hash ${TEXT} NOT NULL,
        created_at    ${TEXT} NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS services (
        id           ${TEXT} PRIMARY KEY,
        scope_id     ${TEXT} NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        alias        ${TEXT} NOT NULL,
        dokploy_url  ${TEXT} NOT NULL,
        kind         ${TEXT} NOT NULL,
        dokploy_id   ${TEXT} NOT NULL,
        tag_variable ${TEXT},
        created_at   ${TEXT} NOT NULL,
        UNIQUE (scope_id, alias)
      )`,
      `CREATE TABLE IF NOT EXISTS ci_results (
        repo        ${TEXT} NOT NULL,
        sha         ${TEXT} NOT NULL,
        tag         ${TEXT} NOT NULL,
        status      ${TEXT} NOT NULL,
        received_at ${TEXT} NOT NULL,
        PRIMARY KEY (repo, sha)
      )`,
      // `seq` stands in for SQLite's rowid: insertion order, to break ties between deploys created in the same ms.
      `CREATE TABLE IF NOT EXISTS deploys (
        id                ${TEXT} PRIMARY KEY,
        repo              ${TEXT} NOT NULL,
        tag               ${TEXT} NOT NULL,
        sha               ${TEXT} NOT NULL,
        service_id        ${TEXT} NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        service_alias     ${TEXT} NOT NULL,
        status            ${TEXT} NOT NULL,
        error             ${TEXT},
        deploy_started_at ${TEXT},
        ci_passed_at      ${TEXT},
        finished_at       ${TEXT},
        requested_by      ${TEXT},
        created_at        ${TEXT} NOT NULL,
        updated_at        ${TEXT} NOT NULL,
        seq               BIGSERIAL NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS deploys_status ON deploys (status, created_at)",
      "CREATE INDEX IF NOT EXISTS deploys_repo_sha ON deploys (repo, sha)",
      `CREATE TABLE IF NOT EXISTS versions (
        repo             ${TEXT} NOT NULL,
        tag              ${TEXT} NOT NULL,
        sha              ${TEXT} NOT NULL,
        branch           ${TEXT},
        created_by_name  ${TEXT},
        created_by_email ${TEXT},
        created_at       ${TEXT} NOT NULL,
        ci_status        ${TEXT} NOT NULL,
        ci_finished_at   ${TEXT},
        run_url          ${TEXT},
        PRIMARY KEY (repo, tag)
      )`,
      "CREATE INDEX IF NOT EXISTS versions_repo_created ON versions (repo, created_at)",
      "CREATE INDEX IF NOT EXISTS versions_status ON versions (ci_status, created_at)",
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id           ${TEXT} PRIMARY KEY,
        name         ${TEXT} NOT NULL,
        token_hash   ${TEXT} NOT NULL UNIQUE,
        created_at   ${TEXT} NOT NULL,
        last_used_at ${TEXT}
      )`,
      `CREATE TABLE IF NOT EXISTS service_locks (
        service_id ${TEXT} PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
        reason     ${TEXT} NOT NULL,
        locked_by  ${TEXT},
        created_at ${TEXT} NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: "miembros, roles, invitaciones y auditoría",
    statements: [
      `CREATE TABLE IF NOT EXISTS members (
        id            ${TEXT} PRIMARY KEY,
        name          ${TEXT} NOT NULL,
        email         ${TEXT} NOT NULL UNIQUE,
        role          ${TEXT} NOT NULL,
        password_hash ${TEXT},
        status        ${TEXT} NOT NULL,
        created_at    ${TEXT} NOT NULL,
        last_login_at ${TEXT}
      )`,
      `CREATE TABLE IF NOT EXISTS member_grants (
        id              ${TEXT} PRIMARY KEY,
        member_id       ${TEXT} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        repo_pattern    ${TEXT} NOT NULL DEFAULT '*',
        service_pattern ${TEXT} NOT NULL DEFAULT '*',
        role            ${TEXT} NOT NULL,
        created_at      ${TEXT} NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS member_grants_member ON member_grants (member_id)",
      `CREATE TABLE IF NOT EXISTS invites (
        token_hash ${TEXT} PRIMARY KEY,
        member_id  ${TEXT} NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        expires_at ${TEXT} NOT NULL,
        used_at    ${TEXT}
      )`,
      "CREATE INDEX IF NOT EXISTS invites_member ON invites (member_id)",
      `ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS member_id ${TEXT} REFERENCES members(id) ON DELETE CASCADE`,
      `ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS max_role ${TEXT}`,
      "CREATE INDEX IF NOT EXISTS api_tokens_member ON api_tokens (member_id)",
      // `seq`, like deploys': insertion order for entries written in the same millisecond.
      `CREATE TABLE IF NOT EXISTS audit_log (
        id              ${TEXT} PRIMARY KEY,
        at              ${TEXT} NOT NULL,
        actor           ${TEXT} NOT NULL,
        actor_member_id ${TEXT} REFERENCES members(id) ON DELETE SET NULL,
        action          ${TEXT} NOT NULL,
        repo            ${TEXT},
        service         ${TEXT},
        details         ${TEXT},
        seq             BIGSERIAL NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at)",
      "CREATE INDEX IF NOT EXISTS audit_log_repo ON audit_log (repo, at)",
      bootstrapAdminSql(POSTGRES_NOW_ISO),
      // Tokens created before members belong to the bootstrap admin.
      `UPDATE api_tokens SET member_id = '${BOOTSTRAP_ADMIN.id}' WHERE member_id IS NULL`,
    ],
  },
  {
    version: 3,
    name: "apps y scopes (antes scopes y servicios)",
    // The names swap, so `scopes` becomes `apps` before `services` becomes `scopes`. Postgres keeps foreign keys
    // pointing at the renamed tables and columns; the constraints (and the indexes behind primary keys and unique
    // constraints) are renamed to match, `apps`' first so `scopes_pkey` is free for the new `scopes`.
    statements: [
      renameTable("scopes", "apps"),
      renameTable("services", "scopes"),
      renameTable("service_locks", "scope_locks"),
      renameColumn("scopes", "scope_id", "app_id"),
      renameColumn("deploys", "service_id", "scope_id"),
      renameColumn("deploys", "service_alias", "scope_alias"),
      renameColumn("scope_locks", "service_id", "scope_id"),
      renameColumn("member_grants", "service_pattern", "scope_pattern"),
      renameColumn("audit_log", "service", "scope"),
      renameConstraints("apps", "scopes", "apps", {}),
      renameConstraints("scopes", "services", "scopes", { scope_id: "app_id" }),
      renameConstraints("deploys", "deploys", "deploys", { service_id: "scope_id", service_alias: "scope_alias" }),
      renameConstraints("scope_locks", "service_locks", "scope_locks", { service_id: "scope_id" }),
      renameConstraints("member_grants", "member_grants", "member_grants", { service_pattern: "scope_pattern" }),
    ],
  },
];

/**
 * Inserts the bootstrap admin unless it (or its email) already exists. `createdAtSql` is the SQL expression for
 * the creation date, which differs between engines.
 *
 * @param {string} createdAtSql
 */
export function bootstrapAdminSql(createdAtSql) {
  const { id, name, email } = BOOTSTRAP_ADMIN;
  return `INSERT INTO members (id, name, email, role, password_hash, status, created_at)
    VALUES ('${id}', '${name}', '${email}', 'admin', NULL, 'active', ${createdAtSql})
    ON CONFLICT DO NOTHING`;
}

/** keel's tables in foreign-key order: a table only references tables before it. */
export const TABLES = [
  "apps",
  "scopes",
  "ci_results",
  "deploys",
  "versions",
  "members",
  "member_grants",
  "invites",
  "api_tokens",
  "scope_locks",
  "audit_log",
];

/**
 * Applies the pending migrations. `query` must run on one connection that is already inside a transaction,
 * so the advisory lock is held until the caller commits.
 *
 * @param {(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>} query
 * @param {Date} [now]
 * @returns {Promise<number[]>} the versions applied now
 */
export async function applyPostgresMigrations(query, now = new Date()) {
  await query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       ${TEXT} NOT NULL,
      applied_at ${TEXT} NOT NULL
    )`,
  );
  const { rows } = await query("SELECT version FROM schema_migrations");
  const done = new Set(rows.map((r) => Number(r.version)));
  const applied = [];
  for (const migration of POSTGRES_MIGRATIONS) {
    if (done.has(migration.version)) continue;
    for (const statement of migration.statements) await query(statement);
    await query("INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [
      migration.version,
      migration.name,
      now.toISOString(),
    ]);
    applied.push(migration.version);
  }
  return applied;
}
