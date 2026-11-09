import { z } from "zod";
import { DEPLOY_STATUSES } from "./deploy";
import { ANONYMOUS_ROLES, ROLES } from "./roles";

export const CI_STATUSES = ["success", "failure", "cancelled"] as const;

export const createDeployRequestSchema = z.object({
  repo: z.string().min(1),
  tag: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/),
  service: z.string().min(1),
});
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

/** A deploy plus the service details `keel deploys <id>` shows. */
export interface DeployDetail extends Deploy {
  serviceKind: "application" | "compose" | null;
  tagVariable: string | null;
}

export const LOCK_REASON_MAX = 500;

/** `keel lock` body: why nobody should deploy the service for now. */
export const lockServiceRequestSchema = z.object({
  reason: z.string().trim().min(1).max(LOCK_REASON_MAX),
});
export type LockServiceRequest = z.infer<typeof lockServiceRequestSchema>;

/** A lock as listed with its service. `lockedBy` is the API token name, or null without a token. */
export const serviceLockInfoSchema = z.object({
  reason: z.string(),
  lockedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type ServiceLockInfo = z.infer<typeof serviceLockInfoSchema>;

/** `PUT /repos/:owner/:name/services/:alias/lock` response. */
export const serviceLockSchema = serviceLockInfoSchema.extend({ alias: z.string() });
export type ServiceLock = z.infer<typeof serviceLockSchema>;

/** `DELETE /repos/:owner/:name/services/:alias/lock` response. */
export const unlockServiceResponseSchema = z.object({ ok: z.literal(true), wasLocked: z.boolean() });
export type UnlockServiceResponse = z.infer<typeof unlockServiceResponseSchema>;

export const API_AUTH_MODES = ["optional", "required"] as const;
export type ApiAuthMode = (typeof API_AUTH_MODES)[number];

/** A member's grant as `GET /whoami` lists it: `role` on the repos and services matching the glob patterns. */
export const whoamiGrantSchema = z.object({
  repo: z.string(),
  service: z.string(),
  role: z.enum(ROLES),
});
export type WhoamiGrant = z.infer<typeof whoamiGrantSchema>;

/**
 * `GET /whoami`: who the call runs as and whether this server requires a token. Without a token `name`, `email`
 * and `role` are null and `anonymousRole` says what anonymous calls may do. The fields after `auth` are optional
 * because servers before members (v0.7.0) only send `name` (the token's name) and `auth`.
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

/** A service of a repo as `keel scopes` shows it. Servers before v0.5.0 only send `alias`. */
export const serviceSummarySchema = z.object({
  alias: z.string(),
  kind: z.enum(["application", "compose"]).optional(),
  tagVariable: z.string().nullable().optional(),
  dokployId: z.string().optional(),
  dokployUrl: z.string().optional(),
  // `project/environment/name` as Dokploy calls it; null when Dokploy didn't answer.
  dokployName: z.string().nullable().optional(),
  // The newest deploy that reached `deployed`: what the service runs, as far as keel knows.
  current: deploySchema.nullable().optional(),
  // The newest deploy of any status.
  last: deploySchema.nullable().optional(),
  // Null when the service can be deployed. Optional: servers before v0.6.0 don't send it.
  lock: serviceLockInfoSchema.nullable().optional(),
});
export type ServiceSummary = z.infer<typeof serviceSummarySchema>;
