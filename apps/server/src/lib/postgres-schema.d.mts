export declare const POSTGRES_NOW_ISO: string;

export declare const MIGRATION_LOCK_KEY: number;

export declare const POSTGRES_MIGRATIONS: readonly { version: number; name: string; statements: readonly string[] }[];

export declare const BOOTSTRAP_ADMIN: Readonly<{ id: string; name: string; email: string }>;

export declare function bootstrapAdminSql(createdAtSql: string): string;

export declare const TABLES: readonly string[];

export declare function applyPostgresMigrations(
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  now?: Date,
): Promise<number[]>;
