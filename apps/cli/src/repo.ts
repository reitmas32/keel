import { getActiveOrg, type OrgConfig, orgOwner } from "./config.js";
import { KeelError } from "./errors.js";
import { type GithubRepo, getOrigin } from "./git.js";

export interface RepoContext {
  org: OrgConfig;
  origin: GithubRepo;
  /** `owner/name` */
  repo: string;
}

/** Resolves the active org and the repo's origin, failing if the origin belongs to another org. */
export async function resolveRepo(cwd: string, home: string, action: string): Promise<RepoContext> {
  const org = await getActiveOrg(home);
  const origin = await getOrigin(cwd);
  if (origin.host !== "github.com" || origin.owner.toLowerCase() !== orgOwner(org.org).toLowerCase()) {
    throw new KeelError(
      `La configuración actual de keel (${org.org}) no puede ${action} en esta organización (${origin.host}:${origin.owner}). Usa \`keel use\`.`,
    );
  }
  return { org, origin, repo: `${origin.owner}/${origin.name}` };
}
