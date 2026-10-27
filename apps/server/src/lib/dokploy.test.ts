import { describe, expect, it } from "vitest";
import { DokployError, HttpDokployClient, parseDokployServiceUrl, withImageTag } from "./dokploy";

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

describe("parseDokployServiceUrl", () => {
  it("extracts application and compose ids", () => {
    expect(
      parseDokployServiceUrl("https://d.example.com/dashboard/project/p/environment/e/services/application/abc_1"),
    ).toEqual({ kind: "application", id: "abc_1" });
    expect(parseDokployServiceUrl("https://d.example.com/dashboard/project/p/services/compose/xyz")).toEqual({
      kind: "compose",
      id: "xyz",
    });
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

describe("HttpDokployClient", () => {
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

    expect(await client.deployImageTag("app1", "v2.0.0")).toBe("ghcr.io/konectus-io/app:v2.0.0");
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
    expect(calls.every((c) => c.apiKey === "key-1")).toBe(true);
  });

  it("refuses applications that don't deploy from a Docker image", async () => {
    const client = new HttpDokployClient(
      "https://d",
      "k",
      fakeFetch({ "application.one": { ...app, sourceType: "github" } }, []),
    );
    await expect(client.deployImageTag("app1", "v2.0.0")).rejects.toThrow(/sourceType=github/);
  });

  it("surfaces HTTP errors as DokployError", async () => {
    const client = new HttpDokployClient("https://d", "k", fakeFetch({}, []));
    await expect(client.deployImageTag("app1", "v2.0.0")).rejects.toBeInstanceOf(DokployError);
  });

  it("reports the newest deployment created since the trigger", async () => {
    const since = new Date("2026-10-26T12:00:00Z");
    const deployments = [
      { status: "done", createdAt: "2026-10-25T10:00:00Z" },
      { status: "running", createdAt: "2026-10-26T12:00:02Z" },
    ];
    const client = new HttpDokployClient("https://d", "k", fakeFetch({ "deployment.all": deployments }, []));
    expect(await client.latestDeploymentStatus("app1", since)).toBe("running");

    const old = new HttpDokployClient("https://d", "k", fakeFetch({ "deployment.all": deployments.slice(0, 1) }, []));
    expect(await old.latestDeploymentStatus("app1", since)).toBe("pending");
  });
});
