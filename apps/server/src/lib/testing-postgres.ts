import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Row } from "./db";
import { type PgClientLike, type PgPoolLike, PostgresDb } from "./db-postgres";

/** FIFO lock: PGlite is one connection, so a transaction must have it to itself until COMMIT. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}

interface SharedPglite {
  db: PGlite;
  mutex: Mutex;
  searchPath?: string;
}

let shared: Promise<SharedPglite> | undefined;

/** One in-memory Postgres per test file; each test context gets its own schema in it. */
function sharedPglite(): Promise<SharedPglite> {
  shared ??= PGlite.create().then((db) => ({ db, mutex: new Mutex() }));
  return shared;
}

/** A node-postgres-shaped pool over PGlite, pinned to one schema. */
class PglitePool implements PgPoolLike {
  constructor(
    private readonly pglite: SharedPglite,
    private readonly schema: string,
  ) {}

  private async run(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    if (this.pglite.searchPath !== this.schema) {
      await this.pglite.db.exec(`SET search_path TO "${this.schema}"`);
      this.pglite.searchPath = this.schema;
    }
    // Multi-statement SQL without parameters needs the simple protocol, like node-postgres does.
    if (!values?.length && text.includes(";")) {
      await this.pglite.db.exec(text);
      return { rows: [], rowCount: 0 };
    }
    const result = await this.pglite.db.query<Row>(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  }

  async query(text: string, values?: unknown[]) {
    const release = await this.pglite.mutex.acquire();
    try {
      return await this.run(text, values);
    } finally {
      release();
    }
  }

  async connect(): Promise<PgClientLike & { release(): void }> {
    const release = await this.pglite.mutex.acquire();
    return { query: (text, values) => this.run(text, values), release };
  }

  async end(): Promise<void> {}
}

const cleanups: (() => Promise<void>)[] = [];

/** Drops every schema and closes every connection the test file opened. Registered by test-setup.ts. */
export async function closePostgresTestDbs(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (shared) {
    const { db } = await shared;
    shared = undefined;
    await db.close();
  }
}

/**
 * A migrated Postgres database in a fresh schema: on the real server at TEST_POSTGRES_DSN when it is set (CI),
 * else on PGlite. `replica()` opens a second, independent pool on the same schema, like another keel replica.
 */
export async function openPostgresTestDb(): Promise<{ db: PostgresDb; replica: () => Promise<PostgresDb> }> {
  const schema = `keel_test_${randomUUID().replaceAll("-", "")}`;
  const dsn = process.env.TEST_POSTGRES_DSN;

  if (!dsn) {
    const pglite = await sharedPglite();
    await pglite.db.exec(`CREATE SCHEMA "${schema}"`);
    const open = () => PostgresDb.open(new PglitePool(pglite, schema));
    return { db: await open(), replica: open };
  }

  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const pools: pg.Pool[] = [];
  const open = () => {
    const pool = new pg.Pool({ connectionString: dsn, max: 4 });
    // node-postgres queues it before anything else the new connection runs.
    pool.on("connect", (client) => {
      client.query(`SET search_path TO "${schema}"`).catch(() => {});
    });
    pools.push(pool);
    return PostgresDb.open({
      query: (text, values) => pool.query(text, values),
      connect: () => pool.connect(),
      end: () => pool.end(),
    });
  };
  cleanups.push(async () => {
    await Promise.all(pools.map((p) => p.end()));
    const drop = new pg.Client({ connectionString: dsn });
    await drop.connect();
    await drop.query(`DROP SCHEMA "${schema}" CASCADE`);
    await drop.end();
  });
  return { db: await open(), replica: open };
}
