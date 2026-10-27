import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveOrg, setActiveOrg } from "../config.js";

export const ORIGIN_URL = "git@github.com:konectus-io/app.git";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export interface GitFixture {
  root: string;
  home: string;
  work: string;
  remote: string;
  commit(cwd: string, file: string): Promise<void>;
  /** A second clone that pushes straight to the bare remote, simulating a teammate. */
  pushFromOtherClone(file: string): Promise<void>;
  cleanup(): Promise<void>;
}

function configureIdentity(cwd: string) {
  git(cwd, "config", "user.name", "keel test");
  git(cwd, "config", "user.email", "test@keel.local");
}

/**
 * A work repo whose `origin` looks like GitHub (konectus-io/app) but resolves to a local bare repo,
 * plus a KEEL_HOME with konectus-io (active) and jalocompany logged in.
 */
export async function createGitFixture(): Promise<GitFixture> {
  // Isolate from the developer's global git config (signing, hooks, aliases).
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const root = await mkdtemp(join(tmpdir(), "keel-git-"));
  const home = join(root, "home");
  const remote = join(root, "remote.git");
  const work = join(root, "work");

  const commit = async (cwd: string, file: string) => {
    await writeFile(join(cwd, file), file);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", file);
  };

  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", work);
  configureIdentity(work);
  git(work, "remote", "add", "origin", ORIGIN_URL);
  git(work, "config", `url.${remote}.insteadOf`, ORIGIN_URL);
  await commit(work, "a.txt");
  git(work, "push", "-q", "-u", "origin", "main");

  await saveOrg({ org: "github.com:konectus-io", apiUrl: "https://keel.konectus.internal/api" }, home);
  await saveOrg({ org: "github.com:jalocompany", apiUrl: "https://keel.jalo.internal/api" }, home);
  await setActiveOrg("github.com:konectus-io", home);

  return {
    root,
    home,
    work,
    remote,
    commit,
    async pushFromOtherClone(file) {
      const other = join(root, `other-${file}`);
      git(root, "clone", "-q", remote, other);
      configureIdentity(other);
      await commit(other, file);
      git(other, "push", "-q", "origin", "main");
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
