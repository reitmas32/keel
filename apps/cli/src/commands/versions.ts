import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { KeelError } from "../errors.js";
import { resolveRepo } from "../repo.js";
import { renderVersionList } from "../versions-view.js";

export interface VersionsOptions {
  limit?: number;
  json?: boolean;
  color?: boolean;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
  now?: Date;
  timeZone?: string;
}

/** Renders the versions keel knows of for the current repo: who created them, from which branch, and their CI. */
export async function versions({
  limit,
  json = false,
  color = false,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
  now = new Date(),
  timeZone,
}: VersionsOptions): Promise<string> {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new KeelError("-n debe ser un entero entre 1 y 200.");
  }

  const { org, repo } = await resolveRepo(cwd, home, "consultar versiones");
  const api = new KeelApi(org.apiUrl, fetchImpl);
  const list = await api.listVersions(repo, { ...(limit && { limit }) });
  if (!list) {
    throw new KeelError(`El servidor de keel en ${org.apiUrl} es anterior a v0.4.0 y no registra versiones.`);
  }
  if (json) return JSON.stringify(list, null, 2);
  return renderVersionList({ repo, org: org.org, apiUrl: org.apiUrl }, list, {
    now,
    color,
    ...(timeZone && { timeZone }),
  });
}
