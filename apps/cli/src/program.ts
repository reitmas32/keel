import * as p from "@clack/prompts";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { createVersion } from "./commands/create-version.js";
import { deploy } from "./commands/deploy.js";
import { deploys } from "./commands/deploys.js";
import { login } from "./commands/login.js";
import { update } from "./commands/update.js";
import { use } from "./commands/use.js";
import { versions } from "./commands/versions.js";
import { describeVersion } from "./versions-view.js";

export function buildProgram(): Command {
  const program = new Command()
    .name("keel")
    .description("Crea versiones y dispara deploys hacia Dokploy")
    .version(pkg.version);

  program
    .command("login")
    .description("Registra una organización y la URL de su API")
    .option("--org <org>", "organización, p.ej. github.com:konectus-io")
    .option("--api-url <url>", "URL de la API de keel")
    .action((opts: { org?: string; apiUrl?: string }) => login(opts));

  program
    .command("use")
    .description("Selecciona la organización activa")
    .argument("[org]", "organización a activar; si se omite, se pregunta")
    .action((org?: string) => use(org));

  program
    .command("create-version")
    .description("Valida el repo y crea + publica un tag de versión")
    .argument("<version>", "versión semver, p.ej. v1.0.0")
    .option("-d, --deploy <alias>", "después de crearla, despliega esta misma versión en ese servicio")
    .action(async (version: string, opts: { deploy?: string }) => {
      const spinner = p.spinner();
      spinner.start(`Validando y creando ${version}`);
      let result: Awaited<ReturnType<typeof createVersion>>;
      try {
        result = await createVersion({ version, ...(opts.deploy && { deploy: opts.deploy }) });
      } catch (error) {
        spinner.error("No se creó la versión");
        throw error;
      }
      spinner.stop(`${result.tag} publicado en ${result.repo} (${result.branch} @ ${result.sha.slice(0, 7)})`);
      if (result.registerWarning) p.log.warn(result.registerWarning);
      if (result.deploy) {
        const d = result.deploy;
        p.log.success(`Deploy ${d.id} encolado: ${d.tag} → ${d.service} (${d.status})`);
      } else if (result.deployError) {
        p.log.error(result.deployError);
        process.exitCode = 1;
      } else {
        p.log.info(`Para desplegarla: keel deploy -s <servicio> -v ${result.tag}`);
      }
    });

  program
    .command("deploy")
    .description("Solicita el deploy de una versión a un servicio de Dokploy")
    .option("-s, --service <alias>", "servicio de Dokploy; si se omite, se pregunta")
    .option("-v, --version <tag>", "versión a desplegar; si se omite, se pregunta")
    .option("-l, --latest", "usa la versión más alta del repo, esté como esté su CI")
    .option("-r, --latest-ready", "usa la versión más alta cuyo CI pasó")
    .action(async (opts: { service?: string; version?: string; latest?: boolean; latestReady?: boolean }) => {
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const result = await deploy({
        ...opts,
        ...(interactive && {
          confirm: async (message: string) => {
            const answer = await p.confirm({ message, initialValue: false });
            return answer === true;
          },
        }),
      });
      if (result.version) p.log.info(describeVersion(result.version, { now: new Date(), color: false }));
      if (result.createdByOther && !interactive) {
        p.log.warn("La creó otra persona. Si querías la tuya, despliégala con -v <versión>.");
      }
      const d = result.deploy;
      p.log.success(`Deploy ${d.id} encolado: ${d.tag} → ${d.service} (${d.status})`);
      if (d.status === "ci_failed") p.log.warn(d.error ?? "El CI de esta versión falló.");
    });

  program
    .command("versions")
    .description("Muestra las versiones del repo actual: quién las creó, desde qué rama y cómo terminó su CI")
    .option("-n, --limit <n>", "cuántas mostrar (por defecto 20, máximo 200)", (v) => Number(v))
    .option("--json", "salida JSON para scripts")
    .action(async (opts: { limit?: number; json?: boolean }) => {
      const output = await versions({ ...opts, color: process.stdout.isTTY === true && !process.env.NO_COLOR });
      console.log(output);
    });

  program
    .command("deploys")
    .description("Muestra los deploys del repo actual: estado, cuándo terminaron y por qué fallaron")
    .argument("[id]", "id (o sus primeros caracteres) de un deploy para ver su detalle")
    .option("-s, --service <alias>", "solo los deploys de un servicio")
    .option("-n, --limit <n>", "cuántos mostrar (por defecto 20, máximo 200)", (v) => Number(v))
    .option("--json", "salida JSON para scripts")
    .action(async (id: string | undefined, opts: { service?: string; limit?: number; json?: boolean }) => {
      const output = await deploys({
        ...opts,
        ...(id && { id }),
        color: process.stdout.isTTY === true && !process.env.NO_COLOR,
      });
      console.log(output);
    });

  program
    .command("update")
    .description("Actualiza la CLI a la última versión publicada en GitHub")
    .option("--check", "solo revisa si hay una versión nueva, sin instalarla")
    .action(async (opts: { check?: boolean }) => {
      const result = await update({ currentVersion: pkg.version, ...opts, log: (m) => p.log.step(m) });
      if (result.status === "up-to-date") p.log.success(`keel ${result.current} ya es la última versión.`);
      if (result.status === "available") {
        p.log.info(
          `Hay una versión nueva: ${result.latest} (tienes ${result.current}). Instálala con \`keel update\`.`,
        );
      }
      if (result.status === "updated") p.log.success(`keel actualizado: ${result.current} → ${result.latest}.`);
    });

  return program;
}
