import { KeelApi } from "../api.js";
import { keelHome } from "../config.js";
import { renderDeployDetail, renderDeployList } from "../deploys-view.js";
import { KeelError } from "../errors.js";
import { resolveRepo } from "../repo.js";

export interface DeploysOptions {
  id?: string;
  service?: string;
  limit?: number;
  json?: boolean;
  color?: boolean;
  cwd?: string;
  home?: string;
  fetch?: typeof fetch;
  now?: Date;
  timeZone?: string;
}

/** Renders the deploys of the current repo (or one of them, by id prefix) as text or JSON. */
export async function deploys({
  id,
  service,
  limit,
  json = false,
  color = false,
  cwd = process.cwd(),
  home = keelHome(),
  fetch: fetchImpl,
  now = new Date(),
  timeZone,
}: DeploysOptions): Promise<string> {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new KeelError("-n debe ser un entero entre 1 y 200.");
  }

  const { org, repo } = await resolveRepo(cwd, home, "consultar deploys");
  const api = new KeelApi(org.apiUrl, fetchImpl);
  const view = { now, color, ...(timeZone && { timeZone }) };

  if (id) {
    const detail = await api.getRepoDeploy(repo, id);
    return json ? JSON.stringify(detail, null, 2) : renderDeployDetail(detail, view);
  }

  const list = await api.listDeploys(repo, { ...(service && { service }), ...(limit && { limit }) });
  if (json) return JSON.stringify(list, null, 2);
  return renderDeployList({ repo, org: org.org, apiUrl: org.apiUrl }, list, {
    ...view,
    ...(service && { service }),
  });
}
