import { z } from "zod";

const envSchema = z.object({
  DOKPLOY_URL: z.url(),
  DOKPLOY_API_KEY: z.string().min(1),
  KEEL_ADMIN_PASSWORD: z.string().min(12),
  KEEL_DB_PATH: z.string().default("./data/keel.db"),
  KEEL_CI_EXPIRY_MINUTES: z.coerce.number().int().positive().default(60),
  KEEL_DEPLOY_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}
