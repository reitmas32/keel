import * as p from "@clack/prompts";
import { keelHome, normalizeApiUrl, saveOrg, setActiveOrg, validateOrg } from "../config.js";
import { KeelError } from "../errors.js";

export interface LoginOptions {
  org?: string;
  apiUrl?: string;
}

export async function login(options: LoginOptions, home = keelHome()): Promise<void> {
  const org = options.org ?? (await ask("Organización (github.com:<org>)", "github.com:konectus-io", validateOrg));
  const orgError = validateOrg(org);
  if (orgError) throw new KeelError(orgError);

  const apiUrl = normalizeApiUrl(options.apiUrl ?? (await ask("URL de la API de keel", "keel.konectus.internal/api")));

  await saveOrg({ org, apiUrl }, home);
  await setActiveOrg(org, home);
  p.log.success(`${org} guardada (${apiUrl}) y seleccionada como organización activa.`);
}

async function ask(message: string, placeholder: string, validate?: (v: string) => string | undefined) {
  const value = await p.text({
    message,
    placeholder,
    validate: (v) => (v?.trim() ? validate?.(v.trim()) : "Requerido"),
  });
  if (p.isCancel(value)) throw new KeelError("Cancelado.");
  return value.trim();
}
