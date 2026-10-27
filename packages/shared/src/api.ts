import { z } from "zod";
import { DEPLOY_STATUSES } from "./deploy";

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
});
export type Deploy = z.infer<typeof deploySchema>;

/** A deploy plus the service details `keel deploys <id>` shows. */
export interface DeployDetail extends Deploy {
  serviceKind: "application" | "compose" | null;
  tagVariable: string | null;
}
