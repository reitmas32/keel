import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { KeelError } from "./errors.js";

/** `github.com:<owner>`, e.g. `github.com:konectus-io`. */
const ORG_PATTERN = /^github\.com:[A-Za-z0-9][A-Za-z0-9._-]*$/;

const orgConfigSchema = z.object({
  org: z.string().regex(ORG_PATTERN),
  apiUrl: z.url(),
});
export type OrgConfig = z.infer<typeof orgConfigSchema>;

const CONFIG_FILE = "config.json";
const CURRENT_FILE = "current";

export function keelHome(): string {
  return process.env.KEEL_HOME ?? join(homedir(), ".keel");
}

export function validateOrg(org: string): string | undefined {
  return ORG_PATTERN.test(org) ? undefined : "Usa el formato github.com:<org>, p.ej. github.com:konectus-io";
}

/** Accepts `keel.konectus.internal/api` and defaults the scheme to https. */
export function normalizeApiUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = z.url().safeParse(withScheme);
  if (!parsed.success) throw new KeelError(`URL de API inválida: ${input}`);
  return withScheme;
}

/** Owner part of an org, e.g. `konectus-io` for `github.com:konectus-io`. */
export function orgOwner(org: string): string {
  return org.slice(org.indexOf(":") + 1);
}

export async function saveOrg(config: OrgConfig, home = keelHome()): Promise<void> {
  const parsed = orgConfigSchema.parse(config);
  const dir = join(home, parsed.org);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CONFIG_FILE), `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function readOrg(org: string, home = keelHome()): Promise<OrgConfig | undefined> {
  try {
    const raw = await readFile(join(home, org, CONFIG_FILE), "utf8");
    return orgConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listOrgs(home = keelHome()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const orgs: string[] = [];
  for (const entry of entries.filter((e) => ORG_PATTERN.test(e)).sort()) {
    if (await readOrg(entry, home)) orgs.push(entry);
  }
  return orgs;
}

export async function setActiveOrg(org: string, home = keelHome()): Promise<void> {
  if (!(await readOrg(org, home))) {
    throw new KeelError(`La organización ${org} no está configurada. Ejecuta \`keel login\`.`);
  }
  await mkdir(home, { recursive: true });
  await writeFile(join(home, CURRENT_FILE), `${org}\n`);
}

export async function getActiveOrg(home = keelHome()): Promise<OrgConfig> {
  let org: string;
  try {
    org = (await readFile(join(home, CURRENT_FILE), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KeelError("No hay organización activa. Ejecuta `keel login` o `keel use`.");
    }
    throw error;
  }
  const config = await readOrg(org, home);
  if (!config) {
    throw new KeelError(`La organización activa ${org} ya no está configurada. Ejecuta \`keel use\`.`);
  }
  return config;
}
