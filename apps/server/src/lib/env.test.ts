import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const base = {
  DOKPLOY_URL: "https://dokploy.example.com",
  DOKPLOY_API_KEY: "key",
  KEEL_ADMIN_PASSWORD: "a-long-password",
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(base);
    expect(env.KEEL_DB_PATH).toBe("./data/keel.db");
    expect(env.KEEL_CI_EXPIRY_MINUTES).toBe(60);
    expect(env.KEEL_API_AUTH).toBe("optional");
  });

  it("accepts KEEL_API_AUTH=required and rejects other values", () => {
    expect(loadEnv({ ...base, KEEL_API_AUTH: "required" }).KEEL_API_AUTH).toBe("required");
    expect(() => loadEnv({ ...base, KEEL_API_AUTH: "yes" })).toThrow();
  });

  it("rejects a missing Dokploy key", () => {
    expect(() => loadEnv({ ...base, DOKPLOY_API_KEY: undefined })).toThrow();
  });

  it("uses SQLite by default, also when the compose passes the variables empty", () => {
    expect(loadEnv(base).DB_ENGINE).toBe("sqlite");
    expect(loadEnv(base).POSTGRES_DSN).toBeUndefined();
    expect(loadEnv({ ...base, DB_ENGINE: "", POSTGRES_DSN: "", KEEL_DB_PATH: "" })).toMatchObject({
      DB_ENGINE: "sqlite",
      KEEL_DB_PATH: "./data/keel.db",
    });
    expect(loadEnv({ ...base, KEEL_DB_PATH: "/data/keel.db" }).KEEL_DB_PATH).toBe("/data/keel.db");
  });

  it("requires a postgres:// POSTGRES_DSN with DB_ENGINE=postgres, without echoing it", () => {
    const dsn = "postgres://keel:secreta@postgres:5432/keel";
    expect(loadEnv({ ...base, DB_ENGINE: "postgres", POSTGRES_DSN: dsn })).toMatchObject({
      DB_ENGINE: "postgres",
      POSTGRES_DSN: dsn,
    });
    expect(loadEnv({ ...base, DB_ENGINE: "postgres", POSTGRES_DSN: "postgresql://h/keel" }).POSTGRES_DSN).toBe(
      "postgresql://h/keel",
    );
    expect(() => loadEnv({ ...base, DB_ENGINE: "postgres" })).toThrow(
      /POSTGRES_DSN: es obligatoria con DB_ENGINE=postgres/,
    );
    expect(() => loadEnv({ ...base, DB_ENGINE: "postgres", POSTGRES_DSN: "mysql://u:secreta@h/keel" })).toThrow(
      /POSTGRES_DSN: debe ser una URL postgres:\/\//,
    );
    expect(() => loadEnv({ ...base, POSTGRES_DSN: "mysql://u:secreta@h/keel" })).not.toThrow(/secreta/);
    expect(() => loadEnv({ ...base, DB_ENGINE: "mysql" })).toThrow(/DB_ENGINE: debe ser sqlite o postgres/);
  });
});
