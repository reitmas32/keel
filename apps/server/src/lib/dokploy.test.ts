import { describe, expect, it } from "vitest";
import {
  DokployError,
  type DokployTarget,
  HttpDokployClient,
  parseDokployServiceUrl,
  setEnvVariable,
  withImageTag,
} from "./dokploy";

type Call = { method: string; url: string; body: unknown; apiKey: string | null };

function fakeFetch(responses: Record<string, unknown>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      apiKey: new Headers(init?.headers).get("x-api-key"),
    });
    const key = url.pathname.replace("/api/", "");
    if (!(key in responses)) return new Response("not found", { status: 404 });
    return Response.json(responses[key]);
  }) as typeof fetch;
}

const application: DokployTarget = { kind: "application", id: "app1", tagVariable: null };
const compose: DokployTarget = { kind: "compose", id: "cmp1", tagVariable: "DOCKER_TAG" };

describe("parseDokployServiceUrl", () => {
  it("extracts application and compose ids", () => {
    expect(
      parseDokployServiceUrl("https://d.example.com/dashboard/project/p/environment/e/services/application/abc_1"),
    ).toEqual({ kind: "application", id: "abc_1" });
    expect(
      parseDokployServiceUrl(
        "http://dokploy.jalocompany.internal/dashboard/project/Rmw6YQC17nWl69GThNL69/environment/72mllf91AdxVOzAOLcE-8/services/compose/hxC-5Bno77LJuIicwXYWQ",
      ),
    ).toEqual({ kind: "compose", id: "hxC-5Bno77LJuIicwXYWQ" });
    expect(parseDokployServiceUrl("https://d.example.com/dashboard/projects")).toBeUndefined();
    expect(parseDokployServiceUrl("not a url")).toBeUndefined();
  });
});

describe("withImageTag", () => {
  it.each([
    ["ghcr.io/konectus-io/app:v1.0.0", "ghcr.io/konectus-io/app:v2.0.0"],
    ["ghcr.io/konectus-io/app", "ghcr.io/konectus-io/app:v2.0.0"],
    ["localhost:5000/app:latest", "localhost:5000/app:v2.0.0"],
    ["ghcr.io/o/app@sha256:abc", "ghcr.io/o/app:v2.0.0"],
  ])("%s → %s", (image, expected) => {
    expect(withImageTag(image, "v2.0.0")).toBe(expected);
  });
});

describe("setEnvVariable", () => {
  const env = "# imagen\nDOCKER_IMAGE=getfoundathyon/jalo-api\nDOCKER_TAG=v1.0.0\nDOCKER_TAG_SUFFIX=x\nSECRET=a=b\n";

  it("replaces only that variable and keeps everything else as is", () => {
    expect(setEnvVariable(env, "DOCKER_TAG", "v1.4.0")).toBe(
      "# imagen\nDOCKER_IMAGE=getfoundathyon/jalo-api\nDOCKER_TAG=v1.4.0\nDOCKER_TAG_SUFFIX=x\nSECRET=a=b\n",
    );
  });

  it("handles export prefixes, spaces around = and quoted values", () => {
    expect(setEnvVariable('export DOCKER_TAG = "v1"\n', "DOCKER_TAG", "v2")).toBe("export DOCKER_TAG =v2\n");
  });

  it("returns undefined when the variable isn't defined", () => {
    expect(setEnvVariable("DOCKER_IMAGE=x\n# DOCKER_TAG=v1\n", "DOCKER_TAG", "v2")).toBeUndefined();
    expect(setEnvVariable("", "DOCKER_TAG", "v2")).toBeUndefined();
  });
});

describe("HttpDokployClient — Application", () => {
  const app = {
    applicationId: "app1",
    sourceType: "docker",
    dockerImage: "ghcr.io/konectus-io/app:v1.0.0",
    username: "bot",
    password: "secret",
    registryUrl: "ghcr.io",
  };

  it("updates the image tag, keeping registry credentials, then deploys", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://dokploy.example.com/",
      "key-1",
      fakeFetch({ "application.one": app, "application.saveDockerProvider": {}, "application.deploy": {} }, calls),
    );

    expect(await client.deploy(application, "v2.0.0")).toBe("ghcr.io/konectus-io/app:v2.0.0");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/application.one?applicationId=app1",
      "POST /api/application.saveDockerProvider",
      "POST /api/application.deploy",
    ]);
    expect(calls[1]?.body).toEqual({
      applicationId: "app1",
      dockerImage: "ghcr.io/konectus-io/app:v2.0.0",
      username: "bot",
      password: "secret",
      registryUrl: "ghcr.io",
    });
    expect(calls[2]?.body).toEqual({ applicationId: "app1", title: "keel v2.0.0" });
    expect(calls.every((c) => c.apiKey === "key-1")).toBe(true);
  });

  it("refuses applications that don't deploy from a Docker image", async () => {
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch({ "application.one": { ...app, sourceType: "github" } }, []),
    );
    await expect(client.deploy(application, "v2.0.0")).rejects.toThrow(/sourceType=github/);
  });

  it("surfaces HTTP errors as DokployError", async () => {
    const client = new HttpDokployClient("https://d", "k", fakeFetch({}, []));
    await expect(client.deploy(application, "v2.0.0")).rejects.toBeInstanceOf(DokployError);
  });
});

describe("HttpDokployClient — Compose", () => {
  const env = "DOCKER_IMAGE=getfoundathyon/jalo-api\nDOCKER_TAG=v1.0.0\nDATABASE_URL=postgres://u:p@db/x\n";

  it("sets the tag variable, keeping the rest of the env, then deploys", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch(
        { "compose.one": { composeId: "cmp1", env }, "compose.saveEnvironment": {}, "compose.deploy": true },
        calls,
      ),
    );

    expect(await client.deploy(compose, "v1.4.0")).toBe("DOCKER_TAG=v1.4.0");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/compose.one?composeId=cmp1",
      "POST /api/compose.saveEnvironment",
      "POST /api/compose.deploy",
    ]);
    expect(calls[1]?.body).toEqual({
      composeId: "cmp1",
      env: "DOCKER_IMAGE=getfoundathyon/jalo-api\nDOCKER_TAG=v1.4.0\nDATABASE_URL=postgres://u:p@db/x\n",
    });
    expect(calls[2]?.body).toEqual({ composeId: "cmp1", title: "keel v1.4.0" });
  });

  it("uses a custom tag variable", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch(
        {
          "compose.one": { composeId: "cmp1", env: "API_TAG=v1\n" },
          "compose.saveEnvironment": {},
          "compose.deploy": {},
        },
        calls,
      ),
    );
    await client.deploy({ ...compose, tagVariable: "API_TAG" }, "v2");
    expect(calls[1]?.body).toEqual({ composeId: "cmp1", env: "API_TAG=v2\n" });
  });

  it("refuses to deploy when the Compose doesn't define the variable, without saving anything", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch({ "compose.one": { composeId: "cmp1", env: "DOCKER_IMAGE=x\n" } }, calls),
    );
    await expect(client.deploy(compose, "v1.4.0")).rejects.toThrow(/no define DOCKER_TAG/);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});

describe("HttpDokployClient — deployment status", () => {
  const since = new Date("2026-10-26T12:00:00Z");
  const old = { status: "done", createdAt: "2026-10-25T10:00:00Z" };
  const status = async (target: DokployTarget, latest: Record<string, unknown> | undefined) => {
    const deployments = latest ? [old, { createdAt: "2026-10-26T12:00:02Z", ...latest }] : [old];
    const procedure = target.kind === "compose" ? "deployment.allByCompose" : "deployment.all";
    const calls: Call[] = [];
    const client = new HttpDokployClient("https://d", "k", fakeFetch({ [procedure]: deployments }, calls));
    return { result: await client.latestDeploymentStatus(target, since), url: calls[0]?.url };
  };

  it("queries the endpoint for each kind", async () => {
    expect((await status(application, { status: "running" })).url).toBe("/api/deployment.all?applicationId=app1");
    expect((await status(compose, { status: "running" })).url).toBe("/api/deployment.allByCompose?composeId=cmp1");
  });

  it("maps Dokploy statuses, ignoring deployments older than the trigger", async () => {
    expect((await status(compose, undefined)).result).toEqual({ status: "pending" });
    expect((await status(compose, { status: "running" })).result).toEqual({ status: "running" });
    expect((await status(compose, { status: "done" })).result).toEqual({ status: "done" });
    expect((await status(compose, { status: "error", errorMessage: "pull access denied" })).result).toEqual({
      status: "error",
      message: "pull access denied",
    });
    expect((await status(compose, { status: "cancelled" })).result).toEqual({
      status: "error",
      message: "Dokploy canceló el deployment.",
    });
  });
});

describe("HttpDokployClient — describe", () => {
  const named = { name: "jalo-api", environment: { name: "staging", project: { name: "DEV" } } };

  it("names a service as project/environment/name and caches it", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient("https://d", "k", fakeFetch({ "compose.one": named }, calls));

    expect(await client.describe(compose)).toBe("DEV/staging/jalo-api");
    expect(await client.describe(compose)).toBe("DEV/staging/jalo-api");
    expect(calls.map((c) => c.url)).toEqual(["/api/compose.one?composeId=cmp1"]);
  });

  it("asks application.one for an Application and falls back to the bare name", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient("https://d", "k", fakeFetch({ "application.one": { name: "web" } }, calls));
    expect(await client.describe(application)).toBe("web");
    expect(calls[0]?.url).toBe("/api/application.one?applicationId=app1");
  });

  it("never throws: an unreachable or failing Dokploy describes as undefined", async () => {
    const failing = new HttpDokployClient("https://d", "k", fakeFetch({}, []));
    expect(await failing.describe(compose)).toBeUndefined();

    const down = new HttpDokployClient("https://d", "k", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(await down.describe(compose)).toBeUndefined();
  });
});

describe("HttpDokployClient — services", () => {
  it("finds an Application and builds its dashboard URL from its project and environment", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://d.example.com/",
      "k",
      fakeFetch(
        {
          "application.one": {
            applicationId: "app1",
            name: "web",
            appName: "dev-web-a1b2",
            environmentId: "env1",
            environment: { environmentId: "env1", name: "staging", projectId: "proj1", project: { name: "DEV" } },
          },
        },
        calls,
      ),
    );
    const service = await client.findService("application", "app1");
    expect(service).toEqual({
      kind: "application",
      id: "app1",
      name: "web",
      appName: "dev-web-a1b2",
      project: "DEV",
      environment: "staging",
      dashboardUrl: "https://d.example.com/dashboard/project/proj1/environment/env1/services/application/app1",
    });
    expect(parseDokployServiceUrl(service?.dashboardUrl ?? "")).toEqual({ kind: "application", id: "app1" });
    expect(calls[0]?.url).toBe("/api/application.one?applicationId=app1");
  });

  it("finds a Compose on a Dokploy without environments", async () => {
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch({ "compose.one": { composeId: "cmp1", name: "api", projectId: "p9", project: { name: "PROD" } } }, []),
    );
    expect(await client.findService("compose", "cmp1")).toMatchObject({
      project: "PROD",
      environment: null,
      appName: null,
      dashboardUrl: "https://d/dashboard/project/p9/services/compose/cmp1",
    });
  });

  it("returns undefined for a service Dokploy doesn't have, and throws on other errors", async () => {
    const missing = new HttpDokployClient("https://d", "k", fakeFetch({}, []));
    expect(await missing.findService("compose", "nope")).toBeUndefined();

    const failing = new HttpDokployClient(
      "https://d",
      "k",
      (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failing.findService("compose", "cmp1")).rejects.toMatchObject({ name: "DokployError", status: 500 });
  });

  it("lists the applications and composes of every project and environment from project.all", async () => {
    const calls: Call[] = [];
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch(
        {
          "project.all": [
            {
              projectId: "p1",
              name: "DEV",
              environments: [
                {
                  environmentId: "e1",
                  name: "production",
                  applications: [{ applicationId: "a1", name: "web", appName: "dev-web" }],
                  compose: [{ composeId: "c1", name: "api", appName: "dev-api" }],
                },
                { environmentId: "e2", name: "staging", applications: [], compose: [{ composeId: "c2", name: "w" }] },
              ],
            },
            { projectId: "p2", name: "OLD", applications: [{ applicationId: "a2", name: "legacy" }] },
          ],
        },
        calls,
      ),
    );
    expect(await client.listServices()).toEqual([
      {
        kind: "application",
        id: "a1",
        name: "web",
        appName: "dev-web",
        project: "DEV",
        environment: "production",
        dashboardUrl: "https://d/dashboard/project/p1/environment/e1/services/application/a1",
      },
      {
        kind: "compose",
        id: "c1",
        name: "api",
        appName: "dev-api",
        project: "DEV",
        environment: "production",
        dashboardUrl: "https://d/dashboard/project/p1/environment/e1/services/compose/c1",
      },
      {
        kind: "compose",
        id: "c2",
        name: "w",
        appName: null,
        project: "DEV",
        environment: "staging",
        dashboardUrl: "https://d/dashboard/project/p1/environment/e2/services/compose/c2",
      },
      {
        kind: "application",
        id: "a2",
        name: "legacy",
        appName: null,
        project: "OLD",
        environment: null,
        dashboardUrl: "https://d/dashboard/project/p2/services/application/a2",
      },
    ]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/project.all"]);
  });

  it("surfaces a failing project.all as DokployError", async () => {
    const client = new HttpDokployClient("https://d", "k", fakeFetch({}, []));
    await expect(client.listServices()).rejects.toBeInstanceOf(DokployError);
  });
});
