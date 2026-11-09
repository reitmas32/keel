#!/usr/bin/env node
// Copies a keel SQLite database into Postgres, once, when moving an instance to DB_ENGINE=postgres.
//
//   node apps/server/scripts/sqlite-to-postgres.mjs <ruta.db> <postgres://…> [--force]
//   pnpm --filter @keel/server db:sqlite-to-postgres <ruta.db> <postgres://…> [--force]
//
// Stop keel first so the SQLite file doesn't change mid-copy. The target gets keel's schema (same migrations the
// server runs) and every table is copied in foreign-key order inside one transaction: on any error nothing is written.
// A target that already has data is refused unless --force, which empties keel's tables before copying.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  applyPostgresMigrations,
  BOOTSTRAP_ADMIN,
  bootstrapAdminSql,
  POSTGRES_NOW_ISO,
  TABLES,
} from "../src/lib/postgres-schema.mjs";

const BATCH = 200;

/**
 * Before v0.7.0 the linked repos were `scopes` and their deploy targets `services`. For a source in that shape, where
 * each new table and column comes from. The new `scopes` table is the old `services`, so the table map only applies
 * to a source in the old shape (see `isOldShape`).
 */
const OLD_TABLES = { apps: "scopes", scopes: "services", scope_locks: "service_locks" };
const OLD_COLUMNS = {
  scopes: { app_id: "scope_id" },
  deploys: { scope_id: "service_id", scope_alias: "service_alias" },
  scope_locks: { scope_id: "service_id" },
  member_grants: { scope_pattern: "service_pattern" },
  audit_log: { scope: "service" },
};

/** @param {DatabaseSync} sqlite @param {string} table */
const hasTable = (sqlite, table) =>
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

/** @param {DatabaseSync} sqlite @param {string} table @returns {Set<string>} */
const columnsOf = (sqlite, table) =>
  new Set(
    sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name)),
  );

/**
 * Whether the source was last opened by keel v0.6.0 or earlier: it has `services`, or a `scopes` table that holds
 * repos (with their CI token) instead of deploy targets.
 *
 * @param {DatabaseSync} sqlite
 */
const isOldShape = (sqlite) =>
  hasTable(sqlite, "services") || (hasTable(sqlite, "scopes") && columnsOf(sqlite, "scopes").has("ci_token_hash"));

/**
 * Copies every keel table from `sqlite` to the Postgres connection behind `query`, which must already be inside a
 * transaction. The source can be in the current shape or in the one before v0.7.0 (scopes and services), which is read
 * with the new names; it is never modified. Columns that an old SQLite database lacks are left NULL; tables it lacks
 * are skipped.
 *
 * @param {{
 *   sqlite: DatabaseSync,
 *   query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
 *   force?: boolean,
 * }} options
 * @returns {Promise<{ table: string, rows: number }[]>}
 */
export async function copySqliteToPostgres({ sqlite, query, force = false }) {
  await applyPostgresMigrations(query);

  // The migrations create the bootstrap admin; on its own it doesn't count as data.
  const ignoreBootstrap = (table) => (table === "members" ? ` WHERE id <> '${BOOTSTRAP_ADMIN.id}'` : "");
  const existing = [];
  for (const table of TABLES) {
    const { rows } = await query(`SELECT count(*) AS n FROM ${table}${ignoreBootstrap(table)}`);
    if (Number(rows[0]?.n) > 0) existing.push(`${table} (${rows[0]?.n})`);
  }
  if (existing.length > 0) {
    if (!force) {
      throw new Error(
        `La base de Postgres ya tiene datos de keel: ${existing.join(", ")}. Usa --force para borrarlos y copiar de nuevo.`,
      );
    }
    await query(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  }
  // SQLite has its own bootstrap admin (with its tokens); without one it is recreated after the copy.
  await query("DELETE FROM members WHERE id = $1", [BOOTSTRAP_ADMIN.id]);

  const oldShape = isOldShape(sqlite);
  const counts = [];
  for (const table of TABLES) {
    const sourceTable = (oldShape && OLD_TABLES[table]) || table;
    if (!hasTable(sqlite, sourceTable)) {
      counts.push({ table, rows: 0 });
      continue;
    }
    const sourceColumns = columnsOf(sqlite, sourceTable);
    /** The source column for a target column, under its current or its pre-v0.7.0 name; undefined if it lacks it. */
    const sourceOf = (column) => {
      if (sourceColumns.has(column)) return column;
      const old = OLD_COLUMNS[table]?.[column];
      return old && sourceColumns.has(old) ? old : undefined;
    };
    const { rows: targetColumns } = await query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
      [table],
    );
    // `seq` (deploys) is filled by Postgres; copying in rowid order keeps SQLite's insertion order.
    const columns = targetColumns.map((c) => String(c.column_name)).filter((c) => sourceOf(c) !== undefined);
    const select = columns.map((c) => (sourceOf(c) === c ? c : `${sourceOf(c)} AS ${c}`));

    const rows = sqlite.prepare(`SELECT ${select.join(", ")} FROM ${sourceTable} ORDER BY rowid`).all();
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      const params = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((column) => {
          const value = row[column];
          params.push(value === null || value === undefined ? null : String(value));
          return `$${params.length}`;
        });
        return `(${placeholders.join(", ")})`;
      });
      await query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, params);
    }

    const { rows: copied } = await query(`SELECT count(*) AS n FROM ${table}`);
    if (Number(copied[0]?.n) !== rows.length) {
      throw new Error(`${table}: se leyeron ${rows.length} filas de SQLite pero Postgres tiene ${copied[0]?.n}.`);
    }
    counts.push({ table, rows: rows.length });
  }

  // A SQLite database from before members (never opened by keel v0.6.0+) has no bootstrap admin and tokens without
  // an owner: the same migration the server runs gives them to the bootstrap admin.
  await query(bootstrapAdminSql(POSTGRES_NOW_ISO));
  await query("UPDATE api_tokens SET member_id = $1 WHERE member_id IS NULL", [BOOTSTRAP_ADMIN.id]);
  return counts;
}

async function main(argv) {
  const force = argv.includes("--force");
  const [sqlitePath, dsn] = argv.filter((a) => a !== "--force");
  if (!sqlitePath || !dsn) {
    console.error("Uso: node apps/server/scripts/sqlite-to-postgres.mjs <ruta.db> <postgres://…> [--force]");
    process.exit(2);
  }

  if (!existsSync(sqlitePath)) {
    // With `pnpm --filter`, relative paths resolve from apps/server.
    console.error(`No existe ${sqlitePath}. Usa una ruta absoluta a la base SQLite.`);
    process.exit(2);
  }
  // Not read-only: SQLite may need to fold a leftover -wal file into the database to read it.
  const sqlite = new DatabaseSync(sqlitePath);
  const client = new pg.Client({ connectionString: dsn });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN");
    const counts = await copySqliteToPostgres({ sqlite, query: (sql, params) => client.query(sql, params), force });
    await client.query("COMMIT");
    console.log(`Copiado de ${sqlitePath} a Postgres:`);
    for (const { table, rows } of counts) console.log(`  ${table.padEnd(15)} ${rows}`);
  } catch (error) {
    if (connected) await client.query("ROLLBACK").catch(() => {});
    console.error(`No se copió nada: ${error.message || error.code || error}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
