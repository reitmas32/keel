// Postgres schema for keel, shared by the server (src/lib/db-postgres.ts) and scripts/sqlite-to-postgres.mjs.
// Plain JS so the one-shot script can import it with `node`, without a TypeScript step.

// Byte order, like SQLite's BINARY collation, so ORDER BY and LIKE behave the same in both engines.
const TEXT = 'TEXT COLLATE "C"';

/** Key of the advisory lock that serializes migrations when several replicas start at once. */
export const MIGRATION_LOCK_KEY = 0x6b65656c; // "keel"

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
];

/** keel's tables in foreign-key order: a table only references tables before it. */
export const TABLES = ["scopes", "services", "ci_results", "deploys", "versions", "api_tokens", "service_locks"];

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
