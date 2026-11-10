import { z } from "zod";
import { DEPLOY_STATUSES } from "./deploy";
import { ANONYMOUS_ROLES, ROLES } from "./roles";

export const CI_STATUSES = ["success", "failure", "cancelled"] as const;

/**
 * `POST /deploys`. The deploy target is `scope`; clients before v0.7.0 send it as `service`, which is still accepted.
 * At least one is required, and when both come they must match. Parsing leaves only `scope`.
 */
export const createDeployRequestSchema = z
  .object({
    repo: z.string().min(1),
    tag: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    scope: z.string().min(1).optional(),
    /** Deprecated: the name of `scope` before v0.7.0. */
    service: z.string().min(1).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.scope === undefined && body.service === undefined) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "falta el scope al que desplegar" });
    } else if (body.scope !== undefined && body.service !== undefined && body.scope !== body.service) {
      ctx.addIssue({
        code: "custom",
        path: ["service"],
        message: `no coincide con scope (${body.scope}); manda solo scope`,
      });
    }
  })
  .transform(({ scope, service, ...rest }) => ({ ...rest, scope: (scope ?? service) as string }));
export type CreateDeployRequest = z.infer<typeof createDeployRequestSchema>;

export const ciResultRequestSchema = z.object({
  repo: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  tag: z.string().min(1),
  status: z.enum(CI_STATUSES),
  // Link to the workflow run. Optional: Actions written before keel v0.4.0 don't send it.
  runUrl: z.url().optional(),
});
export type CiResultRequest = z.infer<typeof ciResultRequestSchema>;

/** What the CI of a version reported; `pending` until it does, `expired` if it never did. */
export const VERSION_CI_STATUSES = ["pending", "success", "failure", "cancelled", "expired"] as const;
export type VersionCiStatus = (typeof VERSION_CI_STATUSES)[number];

/** `keel create-version` registers the tag it just pushed. Informational: deploys still follow `ci-result`. */
export const registerVersionRequestSchema = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  branch: z.string().min(1).optional(),
  createdByName: z.string().max(200).optional(),
  createdByEmail: z.string().max(200).optional(),
});
export type RegisterVersionRequest = z.infer<typeof registerVersionRequestSchema>;

export const versionSchema = z.object({
  repo: z.string(),
  tag: z.string(),
  sha: z.string(),
  // Null when keel only learned of the version from its CI (no `create-version` registration).
  branch: z.string().nullable(),
  createdByName: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  createdAt: z.string(),
  ciStatus: z.enum(VERSION_CI_STATUSES),
  ciFinishedAt: z.string().nullable(),
  runUrl: z.string().nullable(),
});
export type Version = z.infer<typeof versionSchema>;

export const deploySchema = z.object({
  id: z.string(),
  repo: z.string(),
  tag: z.string(),
  sha: z.string(),
  scope: z.string(),
  /** The same as `scope`, under its name before v0.7.0, for older clients. */
  service: z.string(),
  status: z.enum(DEPLOY_STATUSES),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Milestones (ISO dates). Optional because keel servers before v0.3.0 don't send them.
  ciPassedAt: z.string().nullable().optional(),
  deployStartedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  // Name of the API token that asked for it; null without a token. Optional: servers before v0.6.0 don't send it.
  requestedBy: z.string().nullable().optional(),
});
export type Deploy = z.infer<typeof deploySchema>;

/** A deploy plus the scope details `keel deploys <id>` shows. */
export interface DeployDetail extends Deploy {
  scopeKind: "application" | "compose" | null;
  /** The same as `scopeKind`, under its name before v0.7.0, for older clients. */
  serviceKind: "application" | "compose" | null;
  tagVariable: string | null;
}

export const LOCK_REASON_MAX = 500;

/** `keel lock` body: why nobody should deploy the scope for now. */
export const lockScopeRequestSchema = z.object({
  reason: z.string().trim().min(1).max(LOCK_REASON_MAX),
});
export type LockScopeRequest = z.infer<typeof lockScopeRequestSchema>;

/** A lock as listed with its scope. `lockedBy` is the API token name, or null without a token. */
export const scopeLockInfoSchema = z.object({
  reason: z.string(),
  lockedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type ScopeLockInfo = z.infer<typeof scopeLockInfoSchema>;

/** `PUT /repos/:owner/:name/scopes/:alias/lock` response. */
export const scopeLockSchema = scopeLockInfoSchema.extend({ alias: z.string() });
export type ScopeLock = z.infer<typeof scopeLockSchema>;

/** `DELETE /repos/:owner/:name/scopes/:alias/lock` response. */
export const unlockScopeResponseSchema = z.object({ ok: z.literal(true), wasLocked: z.boolean() });
export type UnlockScopeResponse = z.infer<typeof unlockScopeResponseSchema>;

export const API_AUTH_MODES = ["optional", "required"] as const;
export type ApiAuthMode = (typeof API_AUTH_MODES)[number];

/** A member's grant as `GET /whoami` lists it: `role` on the repos and scopes matching the glob patterns. */
export const whoamiGrantSchema = z.object({
  repo: z.string(),
  scope: z.string(),
  /** The same as `scope`, under its name before v0.7.0, for older clients. */
  service: z.string(),
  role: z.enum(ROLES),
});
export type WhoamiGrant = z.infer<typeof whoamiGrantSchema>;

/**
 * `GET /whoami`: who the call runs as and whether this server requires a token. Without a token `name`, `email`
 * and `role` are null and `anonymousRole` says what anonymous calls may do. The fields after `auth` are optional
 * because servers before members (v0.6.0) only send `name` (the token's name) and `auth`.
 */
export const whoamiResponseSchema = z.object({
  /** The member's name (the token's name for tokens created before members); null without a token. */
  name: z.string().nullable(),
  auth: z.enum(API_AUTH_MODES),
  email: z.string().nullable().optional(),
  /** The member's base role, capped by the token's `tokenMaxRole`; null without a token. */
  role: z.enum(ROLES).nullable().optional(),
  grants: z.array(whoamiGrantSchema).optional(),
  tokenMaxRole: z.enum(ROLES).nullable().optional(),
  anonymousRole: z.enum(ANONYMOUS_ROLES).optional(),
});
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

/** A scope of an app as `keel scopes` shows it. Servers before v0.5.0 only send `alias`. */
export const scopeSummarySchema = z.object({
  alias: z.string(),
  kind: z.enum(["application", "compose"]).optional(),
  tagVariable: z.string().nullable().optional(),
  dokployId: z.string().optional(),
  dokployUrl: z.string().optional(),
  // `project/environment/name` as Dokploy calls it; null when Dokploy didn't answer.
  dokployName: z.string().nullable().optional(),
  // The newest deploy that reached `deployed`: what the scope runs, as far as keel knows.
  current: deploySchema.nullable().optional(),
  // The newest deploy of any status.
  last: deploySchema.nullable().optional(),
  // Null when the scope can be deployed. Optional: servers before v0.6.0 don't send it.
  lock: scopeLockInfoSchema.nullable().optional(),
});
export type ScopeSummary = z.infer<typeof scopeSummarySchema>;

// --- Linking repos (`keel init`) ---

export const SCOPE_KINDS = ["application", "compose"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** An app: a GitHub repo linked to keel. */
export const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `owner/name`, lowercase. */
  repo: z.string(),
  createdAt: z.string(),
});
export type AppInfo = z.infer<typeof appSchema>;

/** `GET /repos/:owner/:name`: the app linked to the repo and its scopes (the same items as `GET …/scopes`). */
export const repoResponseSchema = z.object({
  app: appSchema,
  scopes: z.array(scopeSummarySchema),
});
export type RepoResponse = z.infer<typeof repoResponseSchema>;

/** `POST /apps`. `repo` is `owner/name` or a GitHub URL (`https://github.com/o/r(.git)`, `git@github.com:o/r.git`). */
export const createAppRequestSchema = z.object({
  repo: z.string().trim().min(1),
  /** Defaults to the repo. */
  name: z.string().max(200).optional(),
});
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;

/** `POST /apps` response. `ciToken` is the plaintext CI token: this is the only time keel returns it. */
export const createAppResponseSchema = z.object({ app: appSchema, ciToken: z.string() });
export type CreateAppResponse = z.infer<typeof createAppResponseSchema>;

/** `POST /repos/:owner/:name/ci-token` response: the new CI token, shown once. The previous one stops working. */
export const rotateCiTokenResponseSchema = z.object({ ciToken: z.string() });
export type RotateCiTokenResponse = z.infer<typeof rotateCiTokenResponseSchema>;

/**
 * `POST /repos/:owner/:name/scopes`: links a Dokploy service as a scope. The service comes either as `dokployUrl`
 * (its dashboard URL, as in the admin) or as `kind` + `dokployId`, never both. `tagVariable` only applies to a
 * Compose (default `DOCKER_TAG`).
 */
export const linkScopeRequestSchema = z
  .object({
    alias: z.string().trim().min(1),
    dokployUrl: z.string().trim().min(1).optional(),
    kind: z.enum(SCOPE_KINDS).optional(),
    dokployId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]+$/, "id de servicio de Dokploy inválido")
      .optional(),
    tagVariable: z.string().optional(),
  })
  .superRefine((body, ctx) => {
    const byId = body.kind !== undefined || body.dokployId !== undefined;
    if (body.dokployUrl !== undefined && byId) {
      ctx.addIssue({ code: "custom", path: ["dokployUrl"], message: "manda dokployUrl o kind + dokployId, no ambos" });
    } else if (body.dokployUrl === undefined && !byId) {
      ctx.addIssue({ code: "custom", path: ["dokployUrl"], message: "falta dokployUrl (o kind + dokployId)" });
    } else if (byId && body.kind === undefined) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "falta kind (application o compose)" });
    } else if (byId && body.dokployId === undefined) {
      ctx.addIssue({ code: "custom", path: ["dokployId"], message: "falta el id del servicio de Dokploy" });
    }
  });
export type LinkScopeRequest = z.infer<typeof linkScopeRequestSchema>;

/** A Dokploy application or compose as `GET /dokploy/services` lists it. */
export const dokployServiceSchema = z.object({
  kind: z.enum(SCOPE_KINDS),
  id: z.string(),
  name: z.string(),
  /** Dokploy's internal app name (the container/stack name), when it has one. */
  appName: z.string().optional(),
  project: z.string(),
  /** Null on Dokploy versions without environments. */
  environment: z.string().nullable(),
  /** The service in the Dokploy dashboard; what `POST …/scopes` takes as `dokployUrl`. */
  dashboardUrl: z.string(),
  /** The keel scope already pointing at it, if any. */
  linked: z.object({ repo: z.string(), scope: z.string() }).nullable(),
});
export type DokployService = z.infer<typeof dokployServiceSchema>;

/** `GET /dokploy/services` response. */
export const dokployServicesResponseSchema = z.object({ services: z.array(dokployServiceSchema) });
export type DokployServicesResponse = z.infer<typeof dokployServicesResponseSchema>;
