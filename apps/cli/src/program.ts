import * as p from "@clack/prompts";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { createVersion } from "./commands/create-version.js";
import { deploy } from "./commands/deploy.js";
import { login } from "./commands/login.js";
import { use } from "./commands/use.js";

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
    .action(async (version: string) => {
      const spinner = p.spinner();
      spinner.start(`Validando y creando ${version}`);
      try {
        const result = await createVersion({ version });
        spinner.stop(`${result.tag} publicado en ${result.repo} (${result.branch} @ ${result.sha.slice(0, 7)})`);
      } catch (error) {
        spinner.error("No se creó la versión");
        throw error;
      }
    });

  program
    .command("deploy")
    .description("Solicita el deploy de una versión a un servicio de Dokploy")
    .option("-s, --service <alias>", "servicio de Dokploy; si se omite, se pregunta")
    .option("-v, --version <tag>", "versión a desplegar; si se omite, se pregunta")
    .option("-l, --latest", "usa la última versión creada")
    .action(async (opts: { service?: string; version?: string; latest?: boolean }) => {
      const result = await deploy(opts);
      p.log.success(`Deploy ${result.id} encolado: ${result.tag} → ${result.service} (${result.status})`);
      if (result.status === "ci_failed") p.log.warn(result.error ?? "El CI de esta versión falló.");
    });

  return program;
}
