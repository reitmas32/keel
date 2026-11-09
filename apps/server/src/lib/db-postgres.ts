import pg from "pg";
import type { Db, Row, SqlValue } from "./db";
import { applyPostgresMigrations } from "./postgres-schema.mjs";

/** What keel uses of a node-postgres connection. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** What keel uses of a node-postgres Pool. Tests implement it over PGlite (see testing-postgres.ts). */
export interface PgPoolLike extends PgClientLike {
  connect(): Promise<PgClientLike & { release(error?: Error): void }>;
  end(): Promise<void>;
}

const translated = new Map<string, string>();

/** Rewrites `?` placeholders to `$1, $2…`, leaving `?` inside quoted strings and identifiers alone. */
export function toPostgresPlaceholders(sql: string): string {
  const cached = translated.get(sql);
  if (cached !== undefined) return cached;
  let out = "";
  let n = 0;
  let quote: string | undefined;
  for (const char of sql) {
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "?") {
      out += `$${++n}`;
      continue;
    }
    out += char;
  }
  translated.set(sql, out);
  return out;
}

/** Statements on one connection, already inside a transaction. */
class PostgresConnection implements Db {
  readonly dialect = "postgres";

  constructor(private readonly client: PgClientLike) {}

  async all(sql: string, params: SqlValue[] = []): Promise<Row[]> {
    return (await this.client.query(toPostgresPlaceholders(sql), params)).rows;
  }

  async get(sql: string, params: SqlValue[] = []): Promise<Row | undefined> {
    return (await this.all(sql, params))[0];
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    return { changes: (await this.client.query(toPostgresPlaceholders(sql), params)).rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  /** Already inside a transaction: join it. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

/**
 * Postgres over a connection pool. Each statement outside a transaction takes any free connection;
 * `transaction` holds one connection from BEGIN to COMMIT so row locks (`FOR UPDATE`) work.
 */
export class PostgresDb extends PostgresConnection {
  constructor(private readonly pool: PgPoolLike) {
    super(pool);
  }

  /** Wraps the pool and applies pending migrations before anything else can query it. */
  static async open(pool: PgPoolLike): Promise<PostgresDb> {
    const db = new PostgresDb(pool);
    await db.transaction((tx) =>
      applyPostgresMigrations(async (sql, params) => ({ rows: await tx.all(sql, params as SqlValue[]) })),
    );
    return db;
  }

  override async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresConnection(client));
      await client.query("COMMIT");
      client.release();
      return result;
    } catch (error) {
      // A connection that can't even roll back is broken: release it with the error so the pool discards it.
      await client.query("ROLLBACK").then(
        () => client.release(),
        (rollbackError: Error) => client.release(rollbackError),
      );
      throw error;
    }
  }

  override async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Connects to `dsn` (postgres://user:pass@host:5432/db) and migrates the schema. */
export async function openPostgresDb(dsn: string): Promise<PostgresDb> {
  const pool = new pg.Pool({ connectionString: dsn, max: 10 });
  // An idle connection dropped by the server must not crash the process; the pool replaces it.
  pool.on("error", (error) => console.error("[keel] conexión a Postgres perdida", error.message));
  return PostgresDb.open({
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
    end: () => pool.end(),
  });
}
