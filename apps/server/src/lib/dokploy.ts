import type { ServiceKind } from "./store";

export type DokployDeploymentStatus = "pending" | "running" | "done" | "error";

/** The Dokploy service a keel service points at. */
export interface DokployTarget {
  kind: ServiceKind;
  id: string;
  /** Compose only: env variable that holds the image tag, e.g. `DOCKER_TAG`. */
  tagVariable: string | null;
}

export interface DokployClient {
  /**
   * Points the service at `tag` and triggers a deploy: an Application gets `<image>:<tag>`, a Compose
   * gets `<tagVariable>=<tag>` in its env. Returns a short description of what changed.
   */
  deploy(target: DokployTarget, tag: string): Promise<string>;
  /** Newest deployment created at or after `since`; `pending` if Dokploy hasn't created it yet. */
  latestDeploymentStatus(
    target: DokployTarget,
    since: Date,
  ): Promise<{ status: DokployDeploymentStatus; message?: string }>;
  /** `project/environment/name` of the service, or undefined if Dokploy can't say. Never throws. */
  describe(target: DokployTarget): Promise<string | undefined>;
}

export class DokployError extends Error {
  override name = "DokployError";
}

/** Default env variable a Compose uses for its image tag (`image: ${DOCKER_IMAGE}:${DOCKER_TAG}`). */
export const DEFAULT_TAG_VARIABLE = "DOCKER_TAG";

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

/**
 * Sets `name=value` in a dotenv block, leaving every other line (comments, order, other variables) untouched.
 * Returns undefined when the variable isn't defined, so callers don't silently add one the Compose never reads.
 */
export function setEnvVariable(env: string, name: string, value: string): string | undefined {
  const line = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
  return line.test(env) ? env.replace(line, `$1${value}`) : undefined;
}

interface DokployApplication {
  applicationId: string;
  sourceType: string;
  dockerImage: string | null;
  username: string | null;
  password: string | null;
  registryUrl: string | null;
}

interface DokployCompose {
  composeId: string;
  env: string | null;
}

/** The fields `describe()` reads; `application.one` and `compose.one` both carry them. */
interface DokployNamed {
  name?: string;
  environment?: { name?: string; project?: { name?: string } };
}

/** How long a service's Dokploy name is reused before asking again. */
const DESCRIBE_TTL_MS = 10 * 60_000;
const DESCRIBE_TIMEOUT_MS = 3_000;

interface DokployDeployment {
  status: string;
  createdAt: string;
  errorMessage?: string | null;
}

/** Talks to the Dokploy REST API (`/api/<router>.<procedure>`) with an API key. */
export class HttpDokployClient implements DokployClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private readonly names = new Map<string, { name: string | undefined; expires: number }>();

  deploy(target: DokployTarget, tag: string): Promise<string> {
    return target.kind === "compose"
      ? this.deployCompose(target.id, target.tagVariable ?? DEFAULT_TAG_VARIABLE, tag)
      : this.deployApplication(target.id, tag);
  }

  async latestDeploymentStatus(
    target: DokployTarget,
    since: Date,
  ): Promise<{ status: DokployDeploymentStatus; message?: string }> {
    const deployments =
      target.kind === "compose"
        ? await this.get<DokployDeployment[]>("deployment.allByCompose", { composeId: target.id })
        : await this.get<DokployDeployment[]>("deployment.all", { applicationId: target.id });
    // Small allowance for clock skew between keel and Dokploy.
    const threshold = since.getTime() - 5_000;
    const latest = deployments
      .filter((d) => Date.parse(d.createdAt) >= threshold)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!latest) return { status: "pending" };
    if (latest.status === "done") return { status: "done" };
    if (latest.status === "error") return { status: "error", message: latest.errorMessage ?? undefined };
    if (latest.status === "cancelled") return { status: "error", message: "Dokploy canceló el deployment." };
    return { status: "running" };
  }

  async describe(target: DokployTarget): Promise<string | undefined> {
    const key = `${target.kind}:${target.id}`;
    const cached = this.names.get(key);
    if (cached && cached.expires > Date.now()) return cached.name;
    let name: string | undefined;
    try {
      // A slow Dokploy must not hold up `keel scopes`: past this, the service shows by its id.
      const signal = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
      const service =
        target.kind === "compose"
          ? await this.get<DokployNamed>("compose.one", { composeId: target.id }, signal)
          : await this.get<DokployNamed>("application.one", { applicationId: target.id }, signal);
      const parts = [service.environment?.project?.name, service.environment?.name, service.name];
      name = parts.every(Boolean) ? parts.join("/") : service.name;
    } catch {
      // Best effort: listing services must not fail because Dokploy is slow or down.
      return cached?.name;
    }
    this.names.set(key, { name, expires: Date.now() + DESCRIBE_TTL_MS });
    return name;
  }

  private async deployApplication(applicationId: string, tag: string): Promise<string> {
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
    await this.post("application.deploy", { applicationId, title: `keel ${tag}` });
    return dockerImage;
  }

  private async deployCompose(composeId: string, tagVariable: string, tag: string): Promise<string> {
    const compose = await this.get<DokployCompose>("compose.one", { composeId });
    const env = setEnvVariable(compose.env ?? "", tagVariable, tag);
    if (env === undefined) {
      throw new DokployError(
        `El Compose ${composeId} no define ${tagVariable} en su Environment. Agrégala (p.ej. ${tagVariable}=latest) y úsala en la imagen: image: <imagen>:\${${tagVariable}}.`,
      );
    }
    await this.post("compose.saveEnvironment", { composeId, env });
    await this.post("compose.deploy", { composeId, title: `keel ${tag}` });
    return `${tagVariable}=${tag}`;
  }

  private async get<T>(procedure: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = `${this.endpoint(procedure)}?${new URLSearchParams(query)}`;
    return this.request<T>(url, { method: "GET", ...(signal && { signal }) });
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
