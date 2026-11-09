import type { DatabaseSync } from "node:sqlite";

export declare function copySqliteToPostgres(options: {
  sqlite: DatabaseSync;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  force?: boolean;
}): Promise<{ table: string; rows: number }[]>;
