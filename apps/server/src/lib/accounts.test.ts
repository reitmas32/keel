import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accountsConfig, classifyScope, HttpAccountsClient, JwksCache, verifyAccessToken } from "./accounts";
import { loadEnv } from "./env";

const config = {
  url: "http://accounts.test/accounts",
  publishableKey: "pk_test",
  appId: "app-1",
  issuer: "foundathyon-accounts",
};
const NOW = 1_800_000_000;

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function token(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "at+jwt", kid, ...header })}.${enc(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  sub: "user-1",
  iss: "foundathyon-accounts",
  aud: "app-1",
  exp: NOW + 600,
  ...over,
});

const k1 = keyPair("k1");
const jwks = {
  key: async (kid: string) =>
    kid === "k1" ? (await import("node:crypto")).createPublicKey({ key: k1.jwk, format: "jwk" }) : undefined,
};

describe("verifyAccessToken", () => {
  it("accepts a token of the app signed with its key", async () => {
    expect(await verifyAccessToken(token(k1.privateKey, "k1", claims()), jwks, config, NOW)).toEqual({ sub: "user-1" });
    // aud may be a list.
    expect(
      await verifyAccessToken(token(k1.privateKey, "k1", claims({ aud: ["x", "app-1"] })), jwks, config, NOW),
    ).toEqual({ sub: "user-1" });
  });

  it("rejects other apps, issuers, expired tokens, other keys and tampering", async () => {
    const other = keyPair("k1");
    const cases = [
      token(k1.privateKey, "k1", claims({ aud: "app-2" })),
      token(k1.privateKey, "k1", claims({ iss: "someone" })),
      token(k1.privateKey, "k1", claims({ exp: NOW - 1 })),
      token(k1.privateKey, "k2", claims()),
      token(other.privateKey, "k1", claims()),
      token(k1.privateKey, "k1", claims(), { typ: "JWT" }),
      token(k1.privateKey, "k1", claims(), { alg: "HS256" }),
      token(k1.privateKey, "k1", claims({ sub: "" })),
      "not.a.jwt",
    ];
    const tampered = token(k1.privateKey, "k1", claims()).split(".");
    tampered[1] = Buffer.from(JSON.stringify(claims({ sub: "admin" }))).toString("base64url");
    cases.push(tampered.join("."));
    for (const t of cases) expect(await verifyAccessToken(t, jwks, config, NOW)).toBeUndefined();
  });
});

describe("JwksCache", () => {
  it("fetches the app's keys and refetches for an unknown kid, at most once a minute", async () => {
    let calls = 0;
    let now = 0;
    const fetcher = (async () => {
      calls++;
      return Response.json({ keys: [k1.jwk] });
    }) as unknown as typeof fetch;
    const cache = new JwksCache("http://accounts.test/jwks", fetcher, () => now);
    now = 100_000;
    expect(await cache.key("k1")).toBeDefined();
    expect(await cache.key("k1")).toBeDefined();
    expect(await cache.key("rotated")).toBeUndefined();
    expect(calls).toBe(1);
    now += 61_000;
    await cache.key("rotated");
    expect(calls).toBe(2);
  });
});

describe("HttpAccountsClient", () => {
  function client(routes: Record<string, (body: Record<string, unknown>, headers: Headers) => Response>) {
    const seen: { path: string; headers: Headers }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const path = url.replace(config.url, "");
      const headers = new Headers(init?.headers);
      seen.push({ path, headers });
      if (path === "/api/v1/jwks/app-1") return Response.json({ keys: [k1.jwk] });
      const route = routes[path];
      if (!route) return Response.json({ error: { scope: "not_found" } }, { status: 404 });
      return route(JSON.parse(String(init?.body ?? "{}")), headers);
    }) as unknown as typeof fetch;
    return { client: new HttpAccountsClient(config, fetcher), seen };
  }
  const goodToken = () => token(k1.privateKey, "k1", claims({ exp: Math.floor(Date.now() / 1000) + 600 }));

  it("signs in with the publishable key and returns who it is", async () => {
    const { client: c, seen } = client({
      "/api/v1/emails/signin": (body) =>
        body.password === "secreto-largo"
          ? Response.json({ data: { access_token: goodToken(), refresh_token: "r" } })
          : Response.json({ error: { scope: "emails.signin.invalid_credentials" } }, { status: 401 }),
    });
    expect(await c.signIn("Ana@Foundathyon.com", "secreto-largo")).toEqual({
      ok: true,
      userId: "user-1",
      email: "ana@foundathyon.com",
    });
    expect(seen[0]?.headers.get("x-api-key")).toBe("pk_test");
    expect(await c.signIn("ana@foundathyon.com", "mala")).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("reports MFA, an unreachable Accounts and a token it can't verify", async () => {
    const mfa = client({
      "/api/v1/emails/signin": () => Response.json({ data: { mfa_required: true, mfa_token: "m" } }),
    });
    expect(await mfa.client.signIn("a@b.c", "x")).toEqual({ ok: false, reason: "mfa" });
    const down = new HttpAccountsClient(config, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(await down.signIn("a@b.c", "x")).toEqual({ ok: false, reason: "unavailable" });
    const forged = client({
      "/api/v1/emails/signin": () =>
        Response.json({ data: { access_token: token(keyPair("k1").privateKey, "k1", claims()) } }),
    });
    expect(await forged.client.signIn("a@b.c", "x")).toEqual({ ok: false, reason: "rejected" });
  });

  it("requests and claims an email code, trusting only the email Accounts reports", async () => {
    const { client: c } = client({
      "/api/v1/emails/email-code/request": () => Response.json({ data: { challenge_id: "ch1", expires_in: 600 } }),
      "/api/v1/emails/email-code/claim": (body) =>
        body.code === "123456"
          ? Response.json({ data: { access_token: goodToken(), user: { id: "user-1", email: "Ana@foundathyon.com" } } })
          : Response.json({ error: { scope: "email_code.invalid", meta: { remaining_attempts: 2 } } }, { status: 400 }),
    });
    expect(await c.requestEmailCode("ana@foundathyon.com")).toEqual({ ok: true, challengeId: "ch1", expiresIn: 600 });
    expect(await c.claimEmailCode("ch1", "000000")).toEqual({
      ok: false,
      reason: "invalid_code",
      remainingAttempts: 2,
    });
    expect(await c.claimEmailCode("ch1", "123456")).toEqual({
      ok: true,
      userId: "user-1",
      email: "ana@foundathyon.com",
    });

    const noEmail = client({
      "/api/v1/emails/email-code/claim": () => Response.json({ data: { access_token: goodToken() } }),
    });
    expect(await noEmail.client.claimEmailCode("ch1", "123456")).toEqual({ ok: false, reason: "rejected" });
    const otherUser = client({
      "/api/v1/emails/email-code/claim": () =>
        Response.json({ data: { access_token: goodToken(), user: { id: "user-2", email: "x@y.z" } } }),
    });
    expect(await otherUser.client.claimEmailCode("ch1", "123456")).toEqual({ ok: false, reason: "rejected" });
  });

  it("classifies Accounts error scopes", () => {
    expect(classifyScope(502, undefined)).toBe("unavailable");
    expect(classifyScope(429, "auth.rate_limited")).toBe("try_later");
    expect(classifyScope(400, "email_code.expired")).toBe("needs_new_code");
    expect(classifyScope(403, "email_code.disabled")).toBe("disabled");
  });
});

describe("Accounts configuration", () => {
  const base = { DOKPLOY_URL: "https://d.example.com", DOKPLOY_API_KEY: "k", KEEL_ADMIN_PASSWORD: "x".repeat(12) };

  it("is off without the variables and needs all three", () => {
    expect(accountsConfig(loadEnv(base))).toBeNull();
    const env = loadEnv({
      ...base,
      ACCOUNTS_URL: "http://prod-helm-accounts-api:8000/accounts/",
      ACCOUNTS_PUBLISHABLE_KEY: "pk_live_x",
      ACCOUNTS_APP_ID: "app-1",
    });
    expect(accountsConfig(env)).toEqual({
      url: "http://prod-helm-accounts-api:8000/accounts",
      publishableKey: "pk_live_x",
      appId: "app-1",
      issuer: "foundathyon-accounts",
    });
    expect(() => loadEnv({ ...base, ACCOUNTS_URL: "http://accounts.test" })).toThrow(/ACCOUNTS_PUBLISHABLE_KEY/);
  });
});
