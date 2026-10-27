import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { resolveRepo } from "../repo.js";
import { renderScopes } from "../scopes-view.js";

export interface ScopesOptions {
  json?: boolean;
  color?: boolean;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
  now?: Date;
  timeZone?: string;
}

/** Renders the current repo's scopes (its Dokploy services): what each runs and how its last deploy went. */
export async function scopes({
  json = false,
  color = false,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
  now = new Date(),
  timeZone,
}: ScopesOptions): Promise<string> {
  const { org, repo } = await resolveRepo(cwd, home, "consultar scopes");
  const api = new KeelApi(org.apiUrl, fetchImpl);
  const services = await api.listServiceSummaries(repo);
  if (json) return JSON.stringify(services, null, 2);
  return renderScopes({ repo, org: org.org, apiUrl: org.apiUrl }, services, {
    now,
    color,
    ...(timeZone && { timeZone }),
  });
}
