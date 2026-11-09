import type { Env } from "./env";

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

/**
 * The little SQL surface the Store needs, implemented for SQLite (db-sqlite.ts) and Postgres (db-postgres.ts).
 * Queries use `?` placeholders; the Postgres adapter rewrites them to `$1…`.
 */
export interface Db {
  readonly dialect: "sqlite" | "postgres";
  all(sql: string, params?: SqlValue[]): Promise<Row[]>;
  get(sql: string, params?: SqlValue[]): Promise<Row | undefined>;
  /** Returns how many rows the statement changed. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs SQL without parameters. SQLite accepts several statements; Postgres only one. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` in a transaction on one connection, committing when it resolves and rolling back when it throws.
   * Inside `fn` use the `tx` handle; a nested `transaction` call on it joins the outer one.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens the database the environment asks for and brings its schema up to date. */
export async function openDb(env: Pick<Env, "DB_ENGINE" | "KEEL_DB_PATH" | "POSTGRES_DSN">): Promise<Db> {
  if (env.DB_ENGINE === "postgres") {
    const { openPostgresDb } = await import("./db-postgres");
    return openPostgresDb(env.POSTGRES_DSN as string);
  }
  const { openSqliteDb } = await import("./db-sqlite");
  return openSqliteDb(env.KEEL_DB_PATH);
}
