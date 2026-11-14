import type { Role } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { apiRequest, createTestContext, memberToken, SHA } from "./testing";

// The routes `keel init` uses to link a repo: GET /repos/:o/:n, POST /apps, POST …/ci-token, POST …/scopes and
// GET /dokploy/services.

const APP_URL = "https://dokploy.example.com/dashboard/project/p/environment/e/services/application/s1";
const COMPOSE_URL = "https://dokploy.example.com/dashboard/project/p/environment/e/services/compose/c1";

type Headers = Record<string, string>;
const get = (headers: Headers = {}) => apiRequest("", { headers });
const post = (body: unknown, headers: Headers = {}) => apiRequest("", { method: "POST", headers, body });

async function setup() {
  const t = await createTestContext();
  const as = async (role: Role, options: { grants?: [string, string, Role][]; maxRole?: Role } = {}) =>
    (await memberToken(t.store, t.clock.now(), { name: role, role, ...options })).headers;
  const ciResult = (repo: string, token: string) =>
    handlers.ciResult(
      t.ctx,
      apiRequest("", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: { repo, tag: "v1.0.0", sha: SHA, status: "success" },
      }),
    );
  return { ...t, as, ciResult };
}

const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

describe("GET /repos/:owner/:name", () => {
  it("returns the app and its scopes, as GET …/scopes lists them", async () => {
    const { ctx, app, as } = await setup();
    const response = await handlers.getRepo(ctx, get(await as("viewer")), "Konectus-IO", "app");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      app: { id: app.id, name: "app", repo: "konectus-io/app", createdAt: app.createdAt },
      scopes: (await (await handlers.listScopes(ctx, get(), "konectus-io", "app")).json()).scopes,
    });
    expect(body.scopes[0]).toMatchObject({ alias: "api-prod", kind: "application", dokployName: "DEV/production/app" });
  });

  it("returns 404 for a repo that isn't linked and 403 below viewer", async () => {
    const { ctx, env } = await setup();
    const missing = await handlers.getRepo(ctx, get(), "jalo", "nope");
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe("El repo jalo/nope no está vinculado a ninguna app de keel.");

    env.KEEL_ANONYMOUS_ROLE = "none";
    const anonymous = await handlers.getRepo(ctx, get(), "konectus-io", "app");
    expect(anonymous.status).toBe(403);
    expect(await errorOf(anonymous)).toBe(
      "Tu rol (none) no permite ver la app en konectus-io/app. Pide a un admin de keel que te dé acceso.",
    );
  });
});

describe("POST /apps", () => {
  it("creates the app for an admin and returns the CI token only in that response", async () => {
    const { ctx, store, as, ciResult } = await setup();
    const headers = await as("admin");
    const response = await handlers.createApp(ctx, post({ repo: "https://github.com/Jalo/API.git" }, headers));
    expect(response.status).toBe(201);
    const { app, ciToken } = await response.json();
    expect(app).toEqual({ id: expect.any(String), name: "jalo/api", repo: "jalo/api", createdAt: expect.any(String) });
    expect(ciToken).toMatch(/^keel_/);

    // Nowhere else: not in the repo, not in the audit log.
    const repo = await handlers.getRepo(ctx, get(headers), "jalo", "api");
    expect(JSON.stringify(await repo.json())).not.toContain(ciToken);
    const [entry] = await store.listAudit();
    expect(entry).toMatchObject({ actor: "admin", action: "app.create", repo: "jalo/api", scope: null });
    expect(entry?.details).toMatchObject({ name: "jalo/api", via: "api" });
    expect(JSON.stringify(await store.listAudit())).not.toContain(ciToken);

    // And it is the token the repo's CI reports with.
    expect((await ciResult("jalo/api", ciToken)).status).toBe(200);
  });

  it("takes owner/name and an optional name", async () => {
    const { ctx, as } = await setup();
    const response = await handlers.createApp(ctx, post({ repo: "jalo/web", name: " Web " }, await as("admin")));
    expect((await response.json()).app).toMatchObject({ name: "Web", repo: "jalo/web" });
  });

  it("needs admin on the repo: a maintainer can't, an admin grant on org/* can", async () => {
    const { ctx, as } = await setup();
    const maintainer = await handlers.createApp(ctx, post({ repo: "jalo/api" }, await as("maintainer")));
    expect(maintainer.status).toBe(403);
    expect(await errorOf(maintainer)).toBe(
      "Tu rol (maintainer) no permite crear apps en jalo/api. Pide a un admin de keel que te dé acceso.",
    );

    const orgAdmin = await as("maintainer", { grants: [["jalo/*", "*", "admin"]] });
    expect((await handlers.createApp(ctx, post({ repo: "jalo/api" }, orgAdmin))).status).toBe(201);
    expect((await handlers.createApp(ctx, post({ repo: "other/api" }, orgAdmin))).status).toBe(403);

    // A token capped below admin can't, whatever its owner's role.
    const capped = await as("admin", { maxRole: "maintainer" });
    expect((await handlers.createApp(ctx, post({ repo: "jalo/x" }, capped))).status).toBe(403);
  });

  it("never lets anonymous calls create apps, and needs a token when KEEL_API_AUTH=required", async () => {
    const { ctx, env } = await setup();
    const anonymous = await handlers.createApp(ctx, post({ repo: "jalo/api" }));
    expect(anonymous.status).toBe(403);
    expect(await errorOf(anonymous)).toMatch(/^Tu rol \(deployer\) no permite crear apps en jalo\/api\./);

    env.KEEL_API_AUTH = "required";
    const required = await handlers.createApp(ctx, post({ repo: "jalo/api" }));
    expect(required.status).toBe(401);
    expect(await errorOf(required)).toMatch(/^Esta instancia de keel pide un token de API\./);
    const invalid = await handlers.createApp(ctx, post({ repo: "jalo/api" }, { authorization: "Bearer nope" }));
    expect(invalid.status).toBe(401);
  });

  it("returns 409 for a linked repo and 400 for an invalid one", async () => {
    const { ctx, as } = await setup();
    const headers = await as("admin");
    const linked = await handlers.createApp(ctx, post({ repo: "git@github.com:Konectus-IO/app.git" }, headers));
    expect(linked.status).toBe(409);
    expect(await errorOf(linked)).toBe("El repo konectus-io/app ya está vinculado a una app.");

    const invalid = await handlers.createApp(ctx, post({ repo: "https://gitlab.com/jalo/api" }, headers));
    expect(invalid.status).toBe(400);
    expect(await errorOf(invalid)).toBe("URL de repo de GitHub inválida: https://gitlab.com/jalo/api");
    expect((await handlers.createApp(ctx, post({}, headers))).status).toBe(400);
  });
});

describe("POST /repos/:owner/:name/ci-token", () => {
  it("rotates the token for a maintainer: the new one works, the old one stops", async () => {
    const { ctx, store, as, ciToken, ciResult } = await setup();
    const response = await handlers.rotateCiToken(ctx, post({}, await as("maintainer")), "konectus-io", "app");
    expect(response.status).toBe(200);
    const { ciToken: next } = await response.json();
    expect(next).toMatch(/^keel_/);
    expect(next).not.toBe(ciToken);

    expect((await ciResult("konectus-io/app", ciToken)).status).toBe(401);
    expect((await ciResult("konectus-io/app", next)).status).toBe(200);

    const entries = (await store.listAudit()).filter((e) => e.action === "ci_token.rotate");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: "maintainer", repo: "konectus-io/app", details: { via: "api" } });
    expect(JSON.stringify(await store.listAudit())).not.toContain(next);
  });

  it("needs maintainer and a linked repo", async () => {
    const { ctx, as } = await setup();
    const deployer = await handlers.rotateCiToken(ctx, post({}, await as("deployer")), "konectus-io", "app");
    expect(deployer.status).toBe(403);
    expect(await errorOf(deployer)).toBe(
      "Tu rol (deployer) no permite rotar el token de CI en konectus-io/app. Pide a un admin de keel que te dé acceso.",
    );
    expect((await handlers.rotateCiToken(ctx, post({}), "konectus-io", "app")).status).toBe(403);
    expect((await handlers.rotateCiToken(ctx, post({}, await as("admin")), "jalo", "nope")).status).toBe(404);
  });
});

describe("POST /repos/:owner/:name/scopes", () => {
  const link = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], body: unknown, headers: Headers) =>
    handlers.linkScope(ctx, post(body, headers), "konectus-io", "app");

  it("links a scope by dashboard URL and returns it as GET …/scopes lists it", async () => {
    const { ctx, store, as } = await setup();
    const response = await link(ctx, { alias: "Api-Stg", dokployUrl: APP_URL }, await as("maintainer"));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      alias: "api-stg",
      kind: "application",
      tagVariable: null,
      dokployId: "s1",
      dokployUrl: APP_URL,
      dokployName: null,
      current: null,
      last: null,
      lock: null,
      healthCheck: null,
      autoRollback: false,
      requireApproval: false,
      freeze: null,
    });
    const [entry] = (await store.listAudit()).filter((e) => e.action === "scope.link");
    expect(entry).toMatchObject({
      actor: "maintainer",
      repo: "konectus-io/app",
      scope: "api-stg",
      details: { kind: "application", dokployId: "s1", tagVariable: null, via: "api" },
    });
  });

  it("links a scope by kind + dokployId once Dokploy confirms the service", async () => {
    const { ctx, store, app, as } = await setup();
    const headers = await as("maintainer");
    const response = await link(ctx, { alias: "worker", kind: "compose", dokployId: "cmp456" }, headers);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      alias: "worker",
      kind: "compose",
      dokployId: "cmp456",
      tagVariable: "DOCKER_TAG",
      dokployUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e2/services/compose/cmp456",
    });
    const custom = await link(
      ctx,
      { alias: "worker-2", kind: "compose", dokployId: "cmp456", tagVariable: "API_TAG" },
      headers,
    );
    expect((await custom.json()).tagVariable).toBe("API_TAG");
    expect((await store.getScopeByAlias(app.id, "worker"))?.dokployId).toBe("cmp456");

    const missing = await link(ctx, { alias: "ghost", kind: "application", dokployId: "nope" }, headers);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe("El servicio de Dokploy nope no existe.");
    // The kind must match too: cmp456 is a compose.
    expect((await link(ctx, { alias: "ghost", kind: "application", dokployId: "cmp456" }, headers)).status).toBe(404);
  });

  it("returns 502 when Dokploy can't confirm the service", async () => {
    const { ctx, dokploy, as } = await setup();
    dokploy.servicesError = "Dokploy respondió 500 en /api/compose.one: boom";
    const response = await link(ctx, { alias: "worker", kind: "compose", dokployId: "cmp456" }, await as("admin"));
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("Dokploy respondió 500 en /api/compose.one: boom");
  });

  it("returns 409 for an existing alias and the admin's 400s for invalid input", async () => {
    const { ctx, as } = await setup();
    const headers = await as("maintainer");
    const exists = await link(ctx, { alias: "API-prod", kind: "application", dokployId: "app123" }, headers);
    expect(exists.status).toBe(409);
    expect(await errorOf(exists)).toBe("Ya existe un scope con alias api-prod en konectus-io/app.");

    const alias = await link(ctx, { alias: "api prod", dokployUrl: APP_URL }, headers);
    expect(alias.status).toBe(400);
    expect(await errorOf(alias)).toBe("El alias solo puede tener minúsculas, números y guiones (p.ej. api-prod).");
    const url = await link(
      ctx,
      { alias: "web", dokployUrl: "https://dokploy.example.com/dashboard/projects" },
      headers,
    );
    expect(url.status).toBe(400);
    expect(await errorOf(url)).toMatch(/^URL de servicio de Dokploy inválida\./);
    const tag = await link(ctx, { alias: "web", dokployUrl: COMPOSE_URL, tagVariable: "DOCKER-TAG" }, headers);
    expect(tag.status).toBe(400);
    expect(await errorOf(tag)).toBe("Variable de tag inválida: DOCKER-TAG. Usa un nombre de variable como DOCKER_TAG.");

    for (const body of [
      { alias: "web" },
      { alias: "web", dokployUrl: APP_URL, kind: "application", dokployId: "s1" },
      { alias: "web", dokployId: "s1" },
      { alias: "web", kind: "application" },
      { alias: "web", kind: "service", dokployId: "s1" },
      { alias: "web", kind: "application", dokployId: "../x" },
    ]) {
      const response = await link(ctx, body, headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorOf(response)).toMatch(/^Petición inválida: /);
    }
  });

  it("needs maintainer on the repo or on that scope; a publisher can't", async () => {
    const { ctx, as } = await setup();
    const publisher = await link(ctx, { alias: "web", dokployUrl: APP_URL }, await as("publisher"));
    expect(publisher.status).toBe(403);
    expect(await errorOf(publisher)).toBe(
      "Tu rol (publisher) no permite vincular scopes en konectus-io/app/web. Pide a un admin de keel que te dé acceso.",
    );
    expect((await link(ctx, { alias: "web", dokployUrl: APP_URL }, {})).status).toBe(403);

    const stgOnly = await as("deployer", { grants: [["konectus-io/app", "*-stg", "maintainer"]] });
    expect((await link(ctx, { alias: "web-stg", dokployUrl: APP_URL }, stgOnly)).status).toBe(201);
    expect((await link(ctx, { alias: "web-prod", dokployUrl: APP_URL }, stgOnly)).status).toBe(403);
    expect(
      (await handlers.linkScope(ctx, post({ alias: "web", dokployUrl: APP_URL }, await as("admin")), "jalo", "nope"))
        .status,
    ).toBe(404);
  });
});

describe("GET /dokploy/services", () => {
  it("lists Dokploy's services and which keel scope points at each", async () => {
    const { ctx, as } = await setup();
    const response = await handlers.listDokployServices(ctx, get(await as("maintainer")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      services: [
        {
          kind: "application",
          id: "app123",
          name: "app",
          appName: "dev-app-x1",
          project: "DEV",
          environment: "production",
          dashboardUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e1/services/application/app123",
          linked: { repo: "konectus-io/app", scope: "api-prod" },
        },
        {
          kind: "compose",
          id: "cmp456",
          name: "worker",
          project: "DEV",
          environment: "staging",
          dashboardUrl: "https://dokploy.example.com/dashboard/project/p1/environment/e2/services/compose/cmp456",
          linked: null,
        },
      ],
    });

    await handlers.linkScope(
      ctx,
      post({ alias: "worker", kind: "compose", dokployId: "cmp456" }, await as("admin")),
      "konectus-io",
      "app",
    );
    const after = await (await handlers.listDokployServices(ctx, get(await as("admin")))).json();
    expect(after.services[1].linked).toEqual({ repo: "konectus-io/app", scope: "worker" });
  });

  it("needs maintainer as base role or through a grant, capped by the token", async () => {
    const { ctx, as } = await setup();
    const status = async (headers: Headers) => (await handlers.listDokployServices(ctx, get(headers))).status;
    const deployer = await handlers.listDokployServices(ctx, get(await as("deployer")));
    expect(deployer.status).toBe(403);
    expect(await errorOf(deployer)).toBe(
      "Tu rol (deployer) no permite ver los servicios de Dokploy en keel. Pide a un admin de keel que te dé acceso.",
    );
    expect(await status({})).toBe(403);
    expect(await status(await as("admin"))).toBe(200);
    expect(await status(await as("deployer", { grants: [["jalo/*", "*", "maintainer"]] }))).toBe(200);
    expect(await status(await as("maintainer", { maxRole: "deployer" }))).toBe(403);
    expect(await status(await as("deployer", { grants: [["jalo/*", "*", "maintainer"]], maxRole: "deployer" }))).toBe(
      403,
    );
  });

  it("returns 502 with Dokploy's error", async () => {
    const { ctx, dokploy, as } = await setup();
    dokploy.servicesError = "No se pudo conectar con Dokploy en https://d: fetch failed";
    const response = await handlers.listDokployServices(ctx, get(await as("admin")));
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toBe("No se pudo conectar con Dokploy en https://d: fetch failed");
  });
});
