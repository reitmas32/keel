import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KeelError } from "./errors.js";

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new KeelError(`git ${args.join(" ")} falló${stderr ? `: ${stderr}` : ""}`);
  }
}

export interface GithubRepo {
  host: string;
  owner: string;
  name: string;
}

/** Parses `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r.git`. */
export function parseGithubRemote(url: string): GithubRepo | undefined {
  const match =
    url.match(/^[\w.-]+@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?\/?$/) ??
    url.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!match) return undefined;
  const [, host, owner, name] = match as unknown as [string, string, string, string];
  return { host: host.toLowerCase(), owner, name };
}

/** Raw `remote.origin.url`, without `insteadOf` rewriting, so it reflects what the user configured. */
export async function getOrigin(cwd: string): Promise<GithubRepo> {
  let url: string;
  try {
    url = await git(cwd, "config", "--get", "remote.origin.url");
  } catch {
    throw new KeelError("Este repositorio no tiene un remote `origin`.");
  }
  const repo = parseGithubRemote(url);
  if (!repo) throw new KeelError(`No se reconoce el remote origin como un repo de GitHub: ${url}`);
  return repo;
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, "branch", "--show-current");
  if (!branch) throw new KeelError("Estás en detached HEAD. Cámbiate a una rama antes de crear una versión.");
  return branch;
}

/** Commits only in local (`ahead`) and only in `origin/<branch>` (`behind`), after fetching. */
export async function compareWithRemote(cwd: string, branch: string): Promise<{ ahead: number; behind: number }> {
  if ((await git(cwd, "ls-remote", "--heads", "origin", `refs/heads/${branch}`)) === "") {
    throw new KeelError(`La rama ${branch} no existe en origin. Súbela con \`git push -u origin ${branch}\`.`);
  }
  await git(cwd, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  const counts = await git(cwd, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branch}`);
  const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

export async function remoteTagExists(cwd: string, tag: string): Promise<boolean> {
  return (await git(cwd, "ls-remote", "--tags", "origin", `refs/tags/${tag}`)) !== "";
}

/** Tags on origin mapped to the commit they point at (annotated tags are peeled). */
export async function remoteTags(cwd: string): Promise<Map<string, string>> {
  const output = await git(cwd, "ls-remote", "--tags", "origin");
  const tags = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t") as [string, string];
    const peeled = ref.endsWith("^{}");
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

export async function localTagExists(cwd: string, tag: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { cwd });
    return true;
  } catch {
    return false;
  }
}
