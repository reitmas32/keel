import type { Version } from "@keel/shared";

export interface FakeKeelRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeKeel {
  fetch: typeof fetch;
  requests: FakeKeelRequest[];
  /** Versions keel knows of, keyed by tag; tests can seed CI outcomes here. */
  versions: Map<string, Version>;
  /** Make POST /deploys fail with this keel error. */
  failDeploysWith?: string;
}

const API = "https://keel.konectus.internal/api";

/**
 * An in-memory keel for konectus-io/app with the services `api-prod` and `worker`. With `legacy: true` it
 * answers like a server older than v0.4.0: the version routes don't exist (Next's 404, not a keel error).
 */
export function createFakeKeel({ legacy = false }: { legacy?: boolean } = {}): FakeKeel {
  const keel: FakeKeel = {
    requests: [],
    versions: new Map(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = input.toString().replace(API, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      keel.requests.push({ method, path, body });

      const notFound = () => new Response("<!DOCTYPE html><title>404</title>", { status: 404 });
      if (path === "/repos/konectus-io/app/services") {
        return Response.json({ repo: "konectus-io/app", services: [{ alias: "api-prod" }, { alias: "worker" }] });
      }
      if (path === "/deploys" && method === "POST") {
        if (keel.failDeploysWith) return Response.json({ error: keel.failDeploysWith }, { status: 409 });
        const ci = keel.versions.get(body.tag)?.ciStatus;
        const status = ci === "success" ? "ci_passed" : ci && ci !== "pending" ? "ci_failed" : "waiting_ci";
        return Response.json({ id: "d1", status, error: null, ...body }, { status: 202 });
      }
      if (legacy) return notFound();
      if (path === "/versions" && method === "POST") {
        const version: Version = {
          repo: body.repo,
          tag: body.tag,
          sha: body.sha,
          branch: body.branch ?? null,
          createdByName: body.createdByName ?? null,
          createdByEmail: body.createdByEmail ?? null,
          createdAt: new Date().toISOString(),
          ciStatus: "pending",
          ciFinishedAt: null,
          runUrl: null,
        };
        keel.versions.set(body.tag, version);
        return Response.json(version, { status: 201 });
      }
      if (path.startsWith("/repos/konectus-io/app/versions")) {
        const list = [...keel.versions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return Response.json({ repo: "konectus-io/app", versions: list });
      }
      return Response.json({ error: "no" }, { status: 404 });
    }) as typeof fetch,
  };
  return keel;
}

/** A version as keel would store it once its CI reported, created by `createdByEmail`. */
export function knownVersion(tag: string, sha: string, overrides: Partial<Version> = {}): Version {
  return {
    repo: "konectus-io/app",
    tag,
    sha,
    branch: "main",
    createdByName: "keel test",
    createdByEmail: "test@keel.local",
    createdAt: "2026-10-27T12:00:00.000Z",
    ciStatus: "success",
    ciFinishedAt: "2026-10-27T12:05:00.000Z",
    runUrl: null,
    ...overrides,
  };
}
