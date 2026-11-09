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
import { applyPostgresMigrations, TABLES } from "../src/lib/postgres-schema.mjs";

const BATCH = 200;

/**
 * Copies every keel table from `sqlite` to the Postgres connection behind `query`, which must already be inside a
 * transaction. Columns that an old SQLite database lacks are left NULL; tables it lacks are skipped.
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

  const existing = [];
  for (const table of TABLES) {
    const { rows } = await query(`SELECT count(*) AS n FROM ${table}`);
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

  const counts = [];
  for (const table of TABLES) {
    const found = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!found) {
      counts.push({ table, rows: 0 });
      continue;
    }
    const sourceColumns = new Set(
      sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    const { rows: targetColumns } = await query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
      [table],
    );
    // `seq` (deploys) is filled by Postgres; copying in rowid order keeps SQLite's insertion order.
    const columns = targetColumns.map((c) => String(c.column_name)).filter((c) => sourceColumns.has(c));

    const rows = sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all();
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
    for (const { table, rows } of counts) console.log(`  ${table.padEnd(14)} ${rows}`);
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
