import type { ServiceKind } from "./store";

export type DokployDeploymentStatus = "pending" | "running" | "done" | "error";

export interface DokployClient {
  /** Points the application at `<image>:<tag>` and triggers a deploy. Returns the new image. */
  deployImageTag(applicationId: string, tag: string): Promise<string>;
  /** Status of the newest deployment created at or after `since`; `pending` if Dokploy hasn't created it yet. */
  latestDeploymentStatus(applicationId: string, since: Date): Promise<DokployDeploymentStatus>;
}

export class DokployError extends Error {
  override name = "DokployError";
}

/**
 * Extracts the service id from a Dokploy dashboard URL, e.g.
 * `https://dokploy.example.com/dashboard/project/<p>/environment/<e>/services/application/<id>`.
 */
export function parseDokployServiceUrl(url: string): { kind: ServiceKind; id: string } | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const match = pathname.match(/\/services\/(application|compose)\/([A-Za-z0-9_-]+)\/?$/);
  return match ? { kind: match[1] as ServiceKind, id: match[2] as string } : undefined;
}

/** Replaces the tag (and drops any digest) of an image reference, keeping registry ports intact. */
export function withImageTag(image: string, tag: string): string {
  const withoutDigest = image.split("@")[0] as string;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const repository = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  return `${repository}:${tag}`;
}

interface DokployApplication {
  applicationId: string;
  sourceType: string;
  dockerImage: string | null;
  username: string | null;
  password: string | null;
  registryUrl: string | null;
}

interface DokployDeployment {
  status: string;
  createdAt: string;
}

/** Talks to the Dokploy REST API (`/api/<router>.<procedure>`) with an API key. */
export class HttpDokployClient implements DokployClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deployImageTag(applicationId: string, tag: string): Promise<string> {
    const app = await this.get<DokployApplication>("application.one", { applicationId });
    if (app.sourceType !== "docker" || !app.dockerImage) {
      throw new DokployError(
        `La aplicación ${applicationId} no usa una imagen Docker (sourceType=${app.sourceType}). Configúrala con proveedor Docker en Dokploy.`,
      );
    }
    const dockerImage = withImageTag(app.dockerImage, tag);
    await this.post("application.saveDockerProvider", {
      applicationId,
      dockerImage,
      username: app.username,
      password: app.password,
      registryUrl: app.registryUrl,
    });
    await this.post("application.deploy", { applicationId });
    return dockerImage;
  }

  async latestDeploymentStatus(applicationId: string, since: Date): Promise<DokployDeploymentStatus> {
    const deployments = await this.get<DokployDeployment[]>("deployment.all", { applicationId });
    // Small allowance for clock skew between keel and Dokploy.
    const threshold = since.getTime() - 5_000;
    const latest = deployments
      .filter((d) => Date.parse(d.createdAt) >= threshold)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!latest) return "pending";
    if (latest.status === "done" || latest.status === "error" || latest.status === "running") return latest.status;
    return "running";
  }

  private async get<T>(procedure: string, query: Record<string, string>): Promise<T> {
    const url = `${this.endpoint(procedure)}?${new URLSearchParams(query)}`;
    return this.request<T>(url, { method: "GET" });
  }

  private async post<T>(procedure: string, body: unknown): Promise<T> {
    return this.request<T>(this.endpoint(procedure), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private endpoint(procedure: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/api/${procedure}`;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { ...init.headers, accept: "application/json", "x-api-key": this.apiKey },
      });
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
      throw new DokployError(`No se pudo conectar con Dokploy en ${this.baseUrl}: ${cause}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new DokployError(`Dokploy respondió ${response.status} en ${new URL(url).pathname}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
