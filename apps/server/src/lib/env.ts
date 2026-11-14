import { ANONYMOUS_ROLES, API_AUTH_MODES } from "@keel/shared";
import { z } from "zod";

export const DB_ENGINES = ["sqlite", "postgres"] as const;

/** Compose files pass unset variables as "", which should mean "use the default". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  } catch {
    return false;
  }
};

/** An optional http(s) URL that is a secret (a webhook): the message never echoes the value. */
const secretUrl = () =>
  optional(z.string().trim().refine(isHttpUrl, { error: "debe ser una URL http(s) válida." }).optional());

const isPostgresUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "";
  } catch {
    return false;
  }
};

const envSchema = z
  .object({
    DOKPLOY_URL: z.url(),
    DOKPLOY_API_KEY: z.string().min(1),
    KEEL_ADMIN_PASSWORD: z.string().min(12),
    DB_ENGINE: optional(
      z.enum(DB_ENGINES, { error: "debe ser sqlite o postgres (por defecto sqlite)." }).default("sqlite"),
    ),
    KEEL_DB_PATH: optional(z.string().trim().min(1).default("./data/keel.db")),
    // The message never echoes the value: a DSN carries the password.
    POSTGRES_DSN: optional(
      z
        .string()
        .trim()
        .refine(isPostgresUrl, {
          error: "debe ser una URL postgres://usuario:contraseña@host:5432/base (o postgresql://).",
        })
        .optional(),
    ),
    KEEL_CI_EXPIRY_MINUTES: z.coerce.number().int().positive().default(60),
    KEEL_DEPLOY_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(15),
    // How long a deploy that needs an approval may wait for one before it expires.
    KEEL_APPROVAL_EXPIRY_MINUTES: optional(z.coerce.number().int().positive().default(1440)),
    // `required`: every /api route except /health and /ci-result needs a personal API token.
    KEEL_API_AUTH: z.enum(API_AUTH_MODES).default("optional"),
    // What /api calls without a token may do while KEEL_API_AUTH=optional. `deployer` keeps keel's old behavior.
    KEEL_ANONYMOUS_ROLE: optional(
      z
        .enum(ANONYMOUS_ROLES, { error: "debe ser none, viewer, publisher o deployer (por defecto deployer)." })
        .default("deployer"),
    ),
    // Public origin of this keel (https://keel.example.com), for links in notifications.
    KEEL_PUBLIC_URL: optional(z.url().optional()),
    // Outgoing notifications configured by environment. They add to the channels created in the admin.
    KEEL_SLACK_WEBHOOK_URL: secretUrl(),
    KEEL_DISCORD_WEBHOOK_URL: secretUrl(),
    KEEL_WEBHOOK_URL: secretUrl(),
    // Signs generic webhook bodies: `X-Keel-Signature: sha256=<hmac>`.
    KEEL_WEBHOOK_SECRET: optional(z.string().min(1).optional()),
    // Comma-separated events the environment channels receive; empty or `*` means all of them.
    KEEL_NOTIFY_EVENTS: optional(z.string().trim().optional()),
  })
  .superRefine((env, ctx) => {
    if (env.DB_ENGINE === "postgres" && !env.POSTGRES_DSN) {
      ctx.addIssue({
        code: "custom",
        path: ["POSTGRES_DSN"],
        message: "es obligatoria con DB_ENGINE=postgres, p.ej. postgres://keel:contraseña@postgres:5432/keel.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parses the environment, throwing one error that lists every invalid variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `- ${i.path.join(".") || "entorno"}: ${i.message}`);
  throw new Error(`Configuración inválida de keel:\n${issues.join("\n")}`);
}
