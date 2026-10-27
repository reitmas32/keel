import type {
  CreateDeployRequest,
  Deploy,
  DeployDetail,
  RegisterVersionRequest,
  Version,
  VersionCiStatus,
} from "@keel/shared";
import { KeelApiError, KeelError } from "./errors.js";

/** Client for a keel API instance (the org's `apiUrl`). */
export class KeelApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listServices(repo: string): Promise<string[]> {
    const body = await this.request<{ services: { alias: string }[] }>("GET", `/repos/${repo}/services`);
    return body.services.map((s) => s.alias);
  }

  createDeploy(request: CreateDeployRequest): Promise<Deploy> {
    return this.request<Deploy>("POST", "/deploys", request);
  }

  getDeploy(id: string): Promise<Deploy> {
    return this.request<Deploy>("GET", `/deploys/${encodeURIComponent(id)}`);
  }

  async listDeploys(repo: string, options: { service?: string; limit?: number } = {}): Promise<Deploy[]> {
    const query = new URLSearchParams();
    if (options.service) query.set("service", options.service);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query}` : "";
    const body = await this.request<{ deploys: Deploy[] }>("GET", `/repos/${repo}/deploys${suffix}`);
    return body.deploys;
  }

  /** Registers a version `create-version` just pushed. Throws KeelApiError (`unsupported`) on servers < v0.4.0. */
  registerVersion(request: RegisterVersionRequest): Promise<Version> {
    return this.request<Version>("POST", "/versions", request);
  }

  /** Newest first. Returns undefined when the server is older than v0.4.0 and doesn't track versions. */
  async listVersions(
    repo: string,
    options: { limit?: number; status?: VersionCiStatus } = {},
  ): Promise<Version[] | undefined> {
    const query = new URLSearchParams();
    if (options.limit) query.set("limit", String(options.limit));
    if (options.status) query.set("status", options.status);
    const suffix = query.size ? `?${query}` : "";
    try {
      const body = await this.request<{ versions: Version[] }>("GET", `/repos/${repo}/versions${suffix}`);
      return body.versions;
    } catch (error) {
      if (error instanceof KeelApiError && error.unsupported) return undefined;
      throw error;
    }
  }

  /** One deploy of `repo` by its id or a unique prefix of it (at least 4 characters). */
  getRepoDeploy(repo: string, idPrefix: string): Promise<DeployDetail> {
    return this.request<DeployDetail>("GET", `/repos/${repo}/deploys/${encodeURIComponent(idPrefix)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new KeelError(`No se pudo conectar con la API de keel en ${this.baseUrl}: ${(error as Error).message}`);
    }
    const json = (await response.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
    if (!response.ok) {
      const fromKeel = typeof json?.error === "string";
      throw new KeelApiError(
        json?.error ?? `La API de keel respondió ${response.status} en ${path}.`,
        response.status,
        fromKeel,
      );
    }
    return json as T;
  }
}
