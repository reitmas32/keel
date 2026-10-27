import type { CreateDeployRequest, Deploy } from "@keel/shared";
import { KeelError } from "./errors.js";

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
      throw new KeelError(json?.error ?? `La API de keel respondió ${response.status} en ${path}.`);
    }
    return json as T;
  }
}
