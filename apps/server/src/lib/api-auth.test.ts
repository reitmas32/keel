import { describe, expect, it } from "vitest";
import { authenticate, createApiToken } from "./api-auth";
import { ApiError } from "./errors";
import { handlers } from "./handlers";
import { addMember, apiRequest, createTestContext, memberToken, SHA } from "./testing";
import { API_TOKEN_PREFIX, hashToken } from "./tokens";

const bearer = (token: string) => apiRequest("", { headers: { authorization: `Bearer ${token}` } });

const statusOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  return 200;
};

describe("createApiToken", () => {
  it("returns a keel_pat_ token once and stores only its hash", async () => {
    const { store, clock } = await createTestContext();
    const owner = await addMember(store, clock.now(), { name: "Rafa" });
    const { record, token } = await createApiToken(store, { name: "  rafa  ", owner }, clock.now());
    expect(token).toMatch(new RegExp(`^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{32}$`));
    expect(record).toMatchObject({ name: "rafa", lastUsedAt: null, memberId: owner.id, maxRole: null });
    expect((await store.getApiTokenByHash(hashToken(token)))?.id).toBe(record.id);
    expect(JSON.stringify(await store.listApiTokens())).not.toContain(token);
  });

  it("rejects an empty or repeated name, and a max role above the owner's", async () => {
    const { store, clock } = await createTestContext();
    const owner = await addMember(store, clock.now(), { role: "deployer" });
    await createApiToken(store, { name: "rafa", owner }, clock.now());
    expect(await statusOf(() => createApiToken(store, { name: " ", owner }, clock.now()))).toBe(400);
    expect(await statusOf(() => createApiToken(store, { name: "rafa", owner }, clock.now()))).toBe(409);
    const above = () => createApiToken(store, { name: "x", owner, maxRole: "maintainer" }, clock.now());
    expect(await statusOf(above)).toBe(400);
    const capped = await createApiToken(store, { name: "y", owner, maxRole: "viewer" }, clock.now());
    expect(capped.record.maxRole).toBe("viewer");
  });
});

describe("authenticate", () => {
  it("resolves the token's member and touches last_used_at at most once a minute", async () => {
    const { ctx, store, clock } = await createTestContext();
    const owner = await addMember(store, clock.now(), { name: "Rafa", grants: [["*", "prod*", "viewer"]] });
    const { record, token } = await createApiToken(store, { name: "rafa", owner }, clock.now());
    expect(await authenticate(ctx, bearer(token))).toMatchObject({
      name: "Rafa",
      tokenName: "rafa",
      member: { id: owner.id },
      grants: [{ scopePattern: "prod*", role: "viewer" }],
      maxRole: null,
    });
    const first = (await store.listApiTokens())[0]?.lastUsedAt;
    expect(first).toBe(clock.now().toISOString());

    clock.advanceMinutes(0.5);
    await authenticate(ctx, bearer(token));
    expect((await store.getApiTokenByName("rafa"))?.lastUsedAt).toBe(first);

    clock.advanceMinutes(1);
    await authenticate(ctx, bearer(token));
    expect((await store.getApiTokenByName("rafa"))?.lastUsedAt).toBe(clock.now().toISOString());

    await store.deleteApiToken(record.id);
    expect(await statusOf(() => authenticate(ctx, bearer(token)))).toBe(401);
  });

  it("rejects an invalid token even when auth is optional", async () => {
    const { ctx } = await createTestContext();
    expect(await statusOf(() => authenticate(ctx, bearer("keel_pat_nope")))).toBe(401);
    const basic = apiRequest("", { headers: { authorization: "Basic abc" } });
    expect(await statusOf(() => authenticate(ctx, basic))).toBe(401);
  });

  it("allows no token only when auth is optional", async () => {
    const { ctx, env } = await createTestContext();
    expect(await authenticate(ctx, apiRequest())).toMatchObject({
      name: null,
      member: null,
      anonymousRole: "deployer",
    });
    env.KEEL_API_AUTH = "required";
    await expect(authenticate(ctx, apiRequest())).rejects.toThrow(/Tokens de API.*keel login --token/);
  });
});

describe("API routes with tokens", () => {
  it("returns 401 on every token route when auth is required, but not on /ci-result", async () => {
    const { ctx, env, ciToken } = await createTestContext();
    env.KEEL_API_AUTH = "required";
    const responses = await Promise.all([
      handlers.listScopes(ctx, apiRequest(), "konectus-io", "app"),
      handlers.listRepoDeploys(ctx, apiRequest(), "konectus-io", "app"),
      handlers.listRepoVersions(ctx, apiRequest(), "konectus-io", "app"),
      handlers.getRepoDeploy(ctx, apiRequest(), "konectus-io", "app", "abcd"),
      handlers.getDeploy(ctx, apiRequest(), "missing"),
      handlers.whoami(ctx, apiRequest()),
      handlers.createDeploy(ctx, apiRequest("", { method: "POST", body: {} })),
      handlers.registerVersion(ctx, apiRequest("", { method: "POST", body: {} })),
      handlers.lockScope(
        ctx,
        apiRequest("", { method: "PUT", body: { reason: "x" } }),
        "konectus-io",
        "app",
        "api-prod",
      ),
      handlers.unlockScope(ctx, apiRequest("", { method: "DELETE" }), "konectus-io", "app", "api-prod"),
    ]);
    expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(401));
    expect((await (responses[0] as Response).json()).error).toMatch(/Tokens de API/);

    const ci = await handlers.ciResult(
      ctx,
      apiRequest("", {
        method: "POST",
        headers: { authorization: `Bearer ${ciToken}` },
        body: { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" },
      }),
    );
    expect(ci.status).toBe(200);
  });

  it("rejects the tokens of a disabled member", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { member, token } = await memberToken(store, clock.now());
    await store.setMemberStatus(member.id, "disabled");
    expect(await statusOf(() => authenticate(ctx, bearer(token)))).toBe(401);
    await expect(authenticate(ctx, bearer(token))).rejects.toThrow(/deshabilitado/);
  });

  it("names legacy tokens of the bootstrap admin after the token", async () => {
    const { ctx, store, clock } = await createTestContext();
    const bootstrap = await store.ensureBootstrapAdmin(clock.now());
    const { token } = await createApiToken(store, { name: "rafa-laptop", owner: bootstrap }, clock.now());
    expect(await authenticate(ctx, bearer(token))).toMatchObject({ name: "rafa-laptop", member: { name: "admin" } });
  });

  it("records the member's name as requestedBy on POST /deploys", async () => {
    const { ctx, store, clock } = await createTestContext();
    const { token } = await memberToken(store, clock.now(), { name: "rafa" });
    const body = { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, scope: "api-prod" };
    const withToken = await handlers.createDeploy(
      ctx,
      apiRequest("", { method: "POST", body, headers: { authorization: `Bearer ${token}` } }),
    );
    expect(withToken.status).toBe(202);
    expect(await withToken.json()).toMatchObject({ requestedBy: "rafa" });

    const anonymous = await handlers.createDeploy(
      ctx,
      apiRequest("", { method: "POST", body: { ...body, sha: "b".repeat(40) } }),
    );
    expect(await anonymous.json()).toMatchObject({ requestedBy: null });
  });
});

describe("GET /whoami", () => {
  it("returns the member, its role and grants, and the auth mode", async () => {
    const { ctx, env, store, clock } = await createTestContext();
    const { member, token } = await memberToken(store, clock.now(), {
      name: "rafa",
      role: "maintainer",
      grants: [["konectus-io/*", "prod*", "viewer"]],
      maxRole: "deployer",
    });
    expect(await (await handlers.whoami(ctx, apiRequest())).json()).toEqual({
      name: null,
      email: null,
      role: null,
      grants: [],
      tokenMaxRole: null,
      auth: "optional",
      anonymousRole: "deployer",
    });
    const mine = {
      name: "rafa",
      email: member.email,
      // The base role capped by the token.
      role: "deployer",
      grants: [{ repo: "konectus-io/*", scope: "prod*", service: "prod*", role: "viewer" }],
      tokenMaxRole: "deployer",
      auth: "optional",
      anonymousRole: "deployer",
    };
    expect(await (await handlers.whoami(ctx, bearer(token))).json()).toEqual(mine);

    env.KEEL_API_AUTH = "required";
    env.KEEL_ANONYMOUS_ROLE = "none";
    expect((await handlers.whoami(ctx, apiRequest())).status).toBe(401);
    expect(await (await handlers.whoami(ctx, bearer(token))).json()).toEqual({
      ...mine,
      auth: "required",
      anonymousRole: "none",
    });
    expect((await handlers.whoami(ctx, bearer("keel_pat_bad"))).status).toBe(401);
  });
});
