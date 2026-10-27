import { spawn } from "node:child_process";
import { KeelError } from "../errors.js";
import { compareSemverDesc, isSemverTag } from "../semver.js";

/** GitHub repo whose Releases carry `keel-cli.tgz`. */
export const RELEASE_REPO = "reitmas32/keel";

export const releaseTarballUrl = (tag: string) =>
  `https://github.com/${RELEASE_REPO}/releases/download/${tag}/keel-cli.tgz`;

/** Runs a command with the terminal attached and resolves with its exit code. */
export type Runner = (command: string, args: string[]) => Promise<number>;

const runInTerminal: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

export interface UpdateOptions {
  currentVersion: string;
  /** Only report whether a newer version exists. */
  check?: boolean;
  fetch?: typeof fetch;
  run?: Runner;
  log?: (message: string) => void;
}

export type UpdateResult =
  | { status: "up-to-date"; current: string; latest: string }
  | { status: "available"; current: string; latest: string }
  | { status: "updated"; current: string; latest: string };

export async function latestReleaseTag(fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "keel-cli" },
    });
  } catch (error) {
    throw new KeelError(`No se pudo consultar GitHub: ${(error as Error).message}`);
  }
  if (!response.ok) throw new KeelError(`GitHub respondió ${response.status} al buscar la última versión de keel.`);
  const { tag_name: tag } = (await response.json()) as { tag_name?: string };
  if (!tag || !isSemverTag(tag)) throw new KeelError(`La última release de keel no tiene un tag válido: ${tag}`);
  return tag;
}

/** Installs the latest GitHub Release of the CLI with npm, unless this one is already the newest. */
export async function update({
  currentVersion,
  check = false,
  fetch: fetchImpl,
  run = runInTerminal,
  log = () => {},
}: UpdateOptions): Promise<UpdateResult> {
  const current = `v${currentVersion}`;
  const latest = await latestReleaseTag(fetchImpl);

  // compareSemverDesc < 0 means `latest` sorts before `current`, i.e. it is newer.
  if (isSemverTag(current) && compareSemverDesc(latest, current) >= 0) {
    return { status: "up-to-date", current, latest };
  }
  if (check) return { status: "available", current, latest };

  log(`Instalando keel ${latest} (tienes ${current})…`);
  const code = await run("npm", ["install", "--global", releaseTarballUrl(latest)]);
  if (code !== 0) {
    throw new KeelError(
      `npm terminó con código ${code} y keel sigue en ${current}. Si fue un error de permisos (EACCES), configura un prefix de npm propio o ejecuta: npm install --global ${releaseTarballUrl(latest)}`,
    );
  }
  return { status: "updated", current, latest };
}
