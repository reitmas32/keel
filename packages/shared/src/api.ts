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
});
export type CiResultRequest = z.infer<typeof ciResultRequestSchema>;

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
