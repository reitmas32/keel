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
  });

  it("rejects a missing Dokploy key", () => {
    expect(() => loadEnv({ ...base, DOKPLOY_API_KEY: undefined })).toThrow();
  });
});
