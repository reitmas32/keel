import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { parseGithubRepoUrl } from "./scopes";
import { createTestContext, SHA } from "./testing";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://keel.test/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("API handlers", () => {
  it("runs the CLI + Action flow over HTTP", async () => {
    const { ctx, ciToken } = createTestContext();

    const services = await handlers.listServices(ctx, "konectus-io", "app");
    expect(await services.json()).toEqual({ repo: "konectus-io/app", services: [{ alias: "api-prod" }] });

    const created = await handlers.createDeploy(
      ctx,
      post({ repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, service: "api-prod" }),
    );
    expect(created.status).toBe(202);
    const deploy = await created.json();
    expect(deploy).toMatchObject({ status: "waiting_ci", service: "api-prod" });
    expect(deploy).not.toHaveProperty("serviceId");

    const ci = await handlers.ciResult(
      ctx,
      post(
        { repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" },
        { authorization: `Bearer ${ciToken}` },
      ),
    );
    expect(ci.status).toBe(200);

    const fetched = await handlers.getDeploy(ctx, deploy.id);
    expect((await fetched.json()).status).toBe("ci_passed");
  });

  it("returns 400 with the failing fields for an invalid body", async () => {
    const { ctx } = createTestContext();
    const response = await handlers.createDeploy(ctx, post({ repo: "konectus-io/app" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/tag/);

    const notJson = await handlers.createDeploy(ctx, post("{"));
    expect(notJson.status).toBe(400);
  });

  it("returns 401 for /ci-result without a valid token", async () => {
    const { ctx } = createTestContext();
    const response = await handlers.ciResult(
      ctx,
      post({ repo: "konectus-io/app", tag: "v1.0.0", sha: SHA, status: "success" }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 for an unknown deploy", async () => {
    const { ctx } = createTestContext();
    expect((await handlers.getDeploy(ctx, "missing")).status).toBe(404);
  });
});

describe("parseGithubRepoUrl", () => {
  it.each([
    "https://github.com/Konectus-IO/App",
    "https://github.com/konectus-io/app.git",
    "git@github.com:konectus-io/app.git",
    "konectus-io/app",
  ])("parses %s", (url) => {
    expect(parseGithubRepoUrl(url)).toBe("konectus-io/app");
  });

  it("rejects non-GitHub URLs", () => {
    expect(parseGithubRepoUrl("https://gitlab.com/konectus-io/app")).toBeUndefined();
  });
});
