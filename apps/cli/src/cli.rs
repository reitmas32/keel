//! The `keel` command tree and its dispatch.

use crate::dokploy::commands::{self as dk, ApplyArgs, BackupCommand, GetCommand, PlanCommand};
use crate::dokploy::paths::{self, Target};
use crate::dokploy::{extra, print_json};
use crate::failure::{self, Kind, fail};
use crate::keel::commands::{self as kc, Ctx, DeployArgs, LogsArgs};
use crate::keel::update::{self, UpdateStatus};
use crate::keel::{ops, skills};
use crate::ui;
use anyhow::{Context, Result};
use clap::{CommandFactory, Parser, Subcommand};
use serde_json::json;
use std::io::IsTerminal;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "keel",
    version = crate::VERSION,
    about = "Crea versiones, las despliega a Dokploy cuando su CI pasa y opera Dokploy con planes revisados",
    after_help = "Versiones y deploys pasan por el servidor de keel (create-version, deploy, promote, rollback, lock, scopes, deploys, changes, status).\nLas operaciones directas sobre Dokploy usan tu API key local (get, env diff, api, plan, apply, backup).\nPara preparar un repo: keel init. Skills para agentes: keel skills."
)]
pub struct Cli {
    /// Salida JSON (también los errores). Sin terminal, los errores ya salen en JSON.
    #[arg(long, global = true)]
    pub json: bool,
    /// Organización de keel (github.com:<org>) en lugar de la activa.
    #[arg(long, global = true, env = "KEEL_ORG")]
    pub org: Option<String>,
    /// config.toml de las instancias de Dokploy (por defecto ~/.keel/dokploy/config.toml).
    #[arg(long, global = true, env = "KEEL_CONFIG")]
    pub config: Option<PathBuf>,
    /// Directorio absoluto para planes, backups de env y audit.jsonl.
    #[arg(long, global = true)]
    pub state_dir: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    // ------------------------------------------------------------ session
    /// Registra una organización y la URL de su API de keel.
    /// La organización va en --org (p. ej. github.com:konectus-io).
    Login {
        /// URL de la API de keel.
        #[arg(long)]
        api_url: Option<String>,
        /// Token personal (keel_pat_…) de «Tokens de API» en el admin. Vacío lo borra;
        /// sin él se pregunta en una terminal. KEEL_TOKEN lo reemplaza al usarlo.
        #[arg(long)]
        token: Option<String>,
    },
    /// Selecciona la organización activa.
    Use {
        /// Organización a activar; si se omite, se pregunta.
        org: Option<String>,
    },
    /// Configuración de las instancias de Dokploy.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Instancias de Dokploy configuradas.
    Targets,
    /// Hacia dónde apunta esta carpeta: org y repo de keel, e instancia de Dokploy.
    #[command(visible_alias = "remote")]
    Context(Target),
    /// Comprueba keel (API) y Dokploy (DNS, panel, key, versión, inventario).
    Doctor(Target),
    /// Estado del repo: scopes, versión actual, último deploy, CI y Dokploy.
    Status(Target),
    /// Actualiza keel al último binario publicado en GitHub.
    Update {
        /// Solo avisa si hay una versión nueva.
        #[arg(long)]
        check: bool,
    },
    /// Script de autocompletado para tu shell.
    Completions { shell: clap_complete::Shell },

    // ----------------------------------------------------- versions/deploys
    /// Valida el repo y crea y publica un tag de versión.
    CreateVersion {
        /// Versión semver, p. ej. v1.0.0.
        version: String,
        /// Después de crearla, despliega esta misma versión en ese scope.
        #[arg(short = 'd', long = "deploy", value_name = "SCOPE")]
        deploy: Option<String>,
        /// Con -d: espera a que el deploy termine.
        #[arg(long, requires = "deploy")]
        wait: bool,
    },
    /// Muestra las versiones del repo: quién las creó, desde qué rama y su CI.
    Versions {
        /// Cuántas mostrar (20 por defecto, 200 como máximo).
        #[arg(short = 'n', long)]
        limit: Option<u32>,
    },
    /// Pide el deploy de una versión a un scope (espera al CI en el servidor).
    Deploy {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Versión a desplegar; si se omite, se pregunta.
        #[arg(short = 'v', long = "version", value_name = "TAG")]
        version: Option<String>,
        /// La versión más alta del repo, esté como esté su CI.
        #[arg(short = 'l', long)]
        latest: bool,
        /// La versión más alta cuyo CI pasó.
        #[arg(short = 'r', long)]
        latest_ready: bool,
        /// Espera a que el deploy termine; sale con código 28 si falla.
        #[arg(long)]
        wait: bool,
        /// Si el deploy termina en deploy_failed, vuelve a la versión que corría antes
        /// (implica --wait). Sale con código 28 aunque el rollback funcione.
        #[arg(long)]
        rollback_on_failure: bool,
    },
    /// Vuelve un scope a la versión que tenía antes (o a --to, ya desplegada ahí).
    Rollback {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Versión a la que volver; debe haberse desplegado antes en ese scope.
        #[arg(long, value_name = "TAG")]
        to: Option<String>,
        /// No pedir confirmación (obligatorio sin terminal interactiva).
        #[arg(short = 'y', long)]
        yes: bool,
        /// Espera a que el deploy del rollback termine; sale con código 28 si falla.
        #[arg(long)]
        wait: bool,
    },
    /// Despliega en --to la versión que corre --from (p. ej. de staging a producción).
    Promote {
        /// Scope de origen: su versión desplegada es la que se promueve.
        #[arg(long, value_name = "SCOPE")]
        from: String,
        /// Scope de destino.
        #[arg(long, value_name = "SCOPE")]
        to: String,
        /// Espera a que el deploy termine; sale con código 28 si falla.
        #[arg(long)]
        wait: bool,
        /// Si el deploy termina en deploy_failed, vuelve a lo que corría --to (implica --wait).
        #[arg(long)]
        rollback_on_failure: bool,
        /// No pedir confirmación (obligatorio sin terminal interactiva).
        #[arg(short = 'y', long)]
        yes: bool,
        /// Desplegarla aunque --to ya corra esa versión.
        #[arg(long)]
        force: bool,
    },
    /// Commits y PRs entre lo que corre un scope y una versión (por defecto la más nueva).
    Changes {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Versión con la que comparar; por defecto el tag semver más alto.
        #[arg(short = 'v', long = "version", value_name = "TAG")]
        version: Option<String>,
    },
    /// Congela los deploys de un scope (incidente, freeze de releases) con un motivo.
    Lock {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Motivo, visible en `keel scopes` y en el error de quien intente desplegar.
        #[arg(short = 'm', long = "message", value_name = "MOTIVO")]
        message: Option<String>,
    },
    /// Vuelve a permitir deploys en un scope bloqueado con `keel lock`.
    Unlock {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
    },
    /// Prepara el repo para keel: workflow de release, vínculo en keel y secrets de GitHub.
    Init {
        /// Solo revisa; sale con código 2 si falta algo.
        #[arg(long)]
        check: bool,
        /// Reemplaza el workflow aunque esté adaptado.
        #[arg(long)]
        force: bool,
    },
    /// Skills para agentes (Claude Code, Codex, Copilot) publicados en el repo de keel.
    Skills {
        #[command(subcommand)]
        command: Option<SkillsCommand>,
        #[command(flatten)]
        scope: SkillsScope,
    },
    /// Scopes del repo: su servicio en Dokploy, la versión que corren y su último deploy.
    #[command(visible_alias = "services")]
    Scopes,
    /// Deploys del repo, o el detalle de uno (con --log, su log de Dokploy).
    Deploys {
        /// Id (o sus primeros caracteres) de un deploy.
        id: Option<String>,
        /// Solo los deploys de este scope.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Cuántos mostrar (20 por defecto, 200 como máximo).
        #[arg(short = 'n', long)]
        limit: Option<u32>,
        /// Con un id: agrega el deploy-log de Dokploy, redactado.
        #[arg(long)]
        log: bool,
        #[command(flatten)]
        target: Target,
    },
    /// Logs de un scope (redactados), por su nombre en keel.
    Logs {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "service", value_name = "SCOPE")]
        service: Option<String>,
        /// Contenedor del Compose (web, worker…).
        #[arg(long)]
        container: Option<String>,
        /// Sigue mostrando líneas nuevas hasta Ctrl-C.
        #[arg(short = 'f', long)]
        follow: bool,
        /// Líneas a leer (antes de --search).
        #[arg(long, default_value_t = 200)]
        tail: u32,
        /// `all` o una duración: 30s, 10m, 1h, 2d.
        #[arg(long, default_value = "all")]
        since: String,
        /// Solo líneas con este texto (se filtra aquí, después de redactar).
        #[arg(long)]
        search: Option<String>,
        #[command(flatten)]
        target: Target,
    },

    // ------------------------------------------------------------ dokploy
    /// Lecturas de Dokploy, redactadas.
    Get {
        #[command(subcommand)]
        command: GetCommand,
    },
    /// Procedimientos de lectura que responde el panel y mutaciones que se pueden planear.
    Api {
        #[command(flatten)]
        target: Target,
        /// Solo procedimientos que contengan este texto.
        filter: Option<String>,
    },
    /// Variables de entorno de servicios de Dokploy (solo nombres, nunca valores).
    Env {
        #[command(subcommand)]
        command: EnvCommand,
    },
    /// Diff saneado entre el Compose remoto y un archivo local.
    Compose {
        #[command(subcommand)]
        command: ComposeCommand,
    },
    /// Cambios en Dokploy: crea un plan revisable que caduca.
    Plan {
        #[command(subcommand)]
        command: PlanCommand,
    },
    /// Ejecuta un plan aprobado, una sola vez.
    Apply(ApplyArgs),
    /// Respaldos locales.
    Backup {
        #[command(subcommand)]
        command: BackupCommand,
    },
}

#[derive(Subcommand)]
pub enum ConfigCommand {
    /// Valida la configuración de Dokploy sin leer credenciales.
    Check,
    /// Mueve la configuración y el estado de dokploy-agent a ~/.keel.
    Migrate {
        /// Mostrar qué se movería sin mover nada.
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
pub enum EnvCommand {
    /// Compara las variables de dos servicios: solo en A, solo en B, valor distinto, igual.
    Diff {
        #[command(flatten)]
        target: Target,
        /// Servicio A: `name`, `environment/name` o `project/environment/name`.
        a: String,
        /// Servicio B.
        b: String,
    },
}

#[derive(Subcommand)]
pub enum SkillsCommand {
    /// Skills publicados y los que keel instaló aquí (lo mismo que `keel skills`).
    List,
    /// Instala uno o más skills.
    Add {
        #[arg(required = true)]
        skills: Vec<String>,
    },
    /// Quita skills que instaló keel (nunca uno escrito a mano).
    Remove {
        #[arg(required = true)]
        skills: Vec<String>,
    },
    /// Actualiza los skills que keel instaló aquí.
    Update,
}

#[derive(clap::Args)]
pub struct SkillsScope {
    /// Para tu usuario (~/.claude/skills, ~/.agents/skills) en vez de este repo.
    #[arg(short = 'g', long, global = true)]
    global: bool,
    /// Solo estos agentes: claude, codex, copilot (separados por comas).
    #[arg(long, global = true, value_name = "AGENTES")]
    agent: Option<String>,
    /// Lee los skills de una copia local del repo de keel en vez de GitHub.
    #[arg(long, global = true, value_name = "RUTA")]
    from: Option<PathBuf>,
    /// Rama o tag de reitmas32/keel (por defecto el de esta versión, o main).
    #[arg(long = "ref", global = true, value_name = "REF")]
    reference: Option<String>,
}

#[derive(Subcommand)]
pub enum ComposeCommand {
    /// Diff saneado: environment y secretos salen como [REDACTED].
    Diff {
        #[command(flatten)]
        target: Target,
        /// Compose: `name`, `environment/name` o `project/environment/name`.
        service: String,
        /// Compose local a comparar.
        #[arg(long)]
        file: PathBuf,
    },
}

/// Runs the CLI; errors become JSON (agents, `--json`, no terminal) or a short message.
pub async fn main() {
    let cli = Cli::parse();
    let json_errors = cli.json || !std::io::stdout().is_terminal();
    if let Err(error) = run(cli).await {
        let (report, code) = failure::report(&error);
        if json_errors {
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
        } else {
            let c = ui::Colors::new(
                std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
            );
            eprintln!(
                "{} {}",
                c.red("✖"),
                report["error"]["message"].as_str().unwrap_or("error")
            );
            if let Some(candidates) = report["error"]["details"]["candidates"].as_array() {
                for candidate in candidates {
                    eprintln!("  · {}", candidate.as_str().unwrap_or_default());
                }
            }
        }
        std::process::exit(code);
    }
}

pub async fn run(cli: Cli) -> Result<()> {
    let ctx = Ctx::new(cli.json, cli.org.clone())?;
    let config_arg = cli.config.clone();
    let state = || paths::state_dir(cli.state_dir.clone());
    let config = || paths::load_config(config_arg.clone());
    match cli.command {
        Command::Login { api_url, token } => kc::login(&ctx, cli.org.clone(), api_url, token).await,
        Command::Use { org } => kc::use_org(&ctx, org),
        Command::CreateVersion {
            version,
            deploy,
            wait,
        } => kc::create_version(&ctx, &version, deploy.as_deref(), wait).await,
        Command::Versions { limit } => kc::versions(&ctx, limit).await,
        Command::Deploy {
            service,
            version,
            latest,
            latest_ready,
            wait,
            rollback_on_failure,
        } => {
            kc::deploy(
                &ctx,
                DeployArgs {
                    service,
                    version,
                    latest,
                    latest_ready,
                    wait,
                    rollback_on_failure,
                },
            )
            .await
        }
        Command::Rollback {
            service,
            to,
            yes,
            wait,
        } => kc::rollback(&ctx, service, to, yes, wait).await,
        Command::Promote {
            from,
            to,
            wait,
            rollback_on_failure,
            yes,
            force,
        } => {
            ops::promote(
                &ctx,
                ops::PromoteArgs {
                    from,
                    to,
                    wait,
                    rollback_on_failure,
                    yes,
                    force,
                },
            )
            .await
        }
        Command::Changes { service, version } => ops::changes(&ctx, service, version).await,
        Command::Lock { service, message } => ops::lock(&ctx, service, message).await,
        Command::Unlock { service } => ops::unlock(&ctx, service).await,
        Command::Init { check, force } => crate::keel::init::init(&ctx, check, force).await,
        Command::Skills { command, scope } => {
            let action = match command {
                None | Some(SkillsCommand::List) => skills::SkillsAction::List,
                Some(SkillsCommand::Add { skills }) => skills::SkillsAction::Add(skills),
                Some(SkillsCommand::Remove { skills }) => skills::SkillsAction::Remove(skills),
                Some(SkillsCommand::Update) => skills::SkillsAction::Update,
            };
            skills::skills(
                &ctx,
                action,
                skills::Scope {
                    global: scope.global,
                    agents: scope.agent,
                },
                scope.from,
                scope.reference,
            )
            .await
        }
        Command::Env {
            command: EnvCommand::Diff { target, a, b },
        } => extra::env_diff_command(&config()?, &target, &a, &b, ctx.json).await,
        Command::Scopes => kc::scopes(&ctx).await,
        Command::Deploys {
            id,
            service,
            limit,
            log,
            target,
        } => kc::deploys(&ctx, id, service, limit, log, config_arg, &target).await,
        Command::Logs {
            service,
            container,
            follow,
            tail,
            since,
            search,
            target,
        } => {
            kc::logs(
                &ctx,
                LogsArgs {
                    service,
                    container,
                    follow,
                    tail,
                    since,
                    search,
                },
                config_arg,
                &target,
            )
            .await
        }
        Command::Status(target) => kc::status(&ctx, config_arg, &target).await,
        Command::Update { check } => update_command(&ctx, check).await,
        Command::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "keel", &mut std::io::stdout());
            Ok(())
        }
        Command::Context(target) => context(&ctx, &target, config_arg),
        Command::Doctor(target) => doctor(&ctx, &target, config_arg).await,
        Command::Config {
            command: ConfigCommand::Check,
        } => {
            let config = config()?;
            print_json(&json!({"ok": true, "instances": config.instances.len(),
                "config": paths::config_location(config_arg)?.path,
                "message": "La configuración es válida. No se leyeron credenciales."}))
        }
        Command::Config {
            command: ConfigCommand::Migrate { dry_run },
        } => migrate(dry_run),
        Command::Targets => {
            let config = config()?;
            print_json(&config.instances.iter().map(|i| json!({
                "organization": i.organization, "instance": i.name, "target": i.label(),
                "base_url": i.base_url, "api_key": i.key_source(),
                "approval": format!("{:?}", i.approval(&config.security)).to_lowercase(),
                "default": i.default, "paths": i.paths
            })).collect::<Vec<_>>())
        }
        Command::Get { command } => dk::get(&config()?, &state()?, command).await,
        Command::Api { target, filter } => dk::api(&config()?, &target, filter.as_deref()).await,
        Command::Compose {
            command:
                ComposeCommand::Diff {
                    target,
                    service,
                    file,
                },
        } => compose_diff(&config()?, &target, &service, &file).await,
        Command::Plan {
            command: PlanCommand::List,
        } => dk::list_plans(&config()?, &state()?),
        Command::Plan {
            command: PlanCommand::Show { plan },
        } => dk::show_plan(&config()?, &state()?, &plan),
        Command::Plan {
            command: PlanCommand::Prune { all, yes },
        } => {
            if all && !yes {
                if !ui::interactive() {
                    return Err(fail(
                        Kind::MissingInput,
                        "--all borra también planes pendientes: confirma con -y",
                    ));
                }
                if !ui::confirm("¿Borrar también los planes pendientes?")? {
                    return Err(fail(Kind::Cancelled, "Cancelado."));
                }
            }
            print_json(&extra::prune_plans(&state()?, all)?)
        }
        Command::Plan { command } => dk::create_plan(&config()?, &state()?, command).await,
        Command::Apply(args) => dk::apply(&config()?, &state()?, args).await,
        Command::Backup {
            command: BackupCommand::Compose(args),
        } => dk::backup_compose(&config()?, args).await,
    }
}

async fn update_command(ctx: &Ctx, check: bool) -> Result<()> {
    let (status, current, latest) = update::update(crate::VERSION, check).await?;
    if ctx.json {
        let status = match status {
            UpdateStatus::UpToDate => "up-to-date",
            UpdateStatus::Available => "available",
            UpdateStatus::Updated => "updated",
        };
        return print_json(&json!({"status": status, "current": current, "latest": latest}));
    }
    match status {
        UpdateStatus::UpToDate => ui::success(&format!("keel {current} ya es la última versión.")),
        UpdateStatus::Available => ui::info(&format!(
            "Hay una versión nueva: {latest} (tienes {current}). Instálala con `keel update`."
        )),
        UpdateStatus::Updated => ui::success(&format!("keel actualizado: {current} → {latest}.")),
    }
    Ok(())
}

fn context(ctx: &Ctx, target: &Target, config_arg: Option<PathBuf>) -> Result<()> {
    let keel = kc::context_info(&ctx.cwd, &ctx.home);
    let location = paths::config_location(config_arg.clone())?;
    let dokploy = match paths::load_config(config_arg) {
        Ok(config) => match target.selection(&config) {
            Ok(selection) => json!({
                "target": selection.instance.label(), "base_url": selection.instance.base_url,
                "selected_by": selection.selected_by,
                "approval": format!("{:?}", selection.instance.approval(&config.security)).to_lowercase(),
                "config": location.path, "legacy_config": location.legacy,
            }),
            Err(error) => {
                json!({"target": null, "error": failure::report(&error).0["error"], "config": location.path})
            }
        },
        Err(error) => {
            json!({"target": null, "error": failure::report(&error).0["error"], "config": location.path})
        }
    };
    print_json(&json!({
        "ok": true, "working_directory": ctx.cwd, "keel": keel, "dokploy": dokploy,
        "hint": location.legacy.then_some("usando la configuración de dokploy-agent; muévela con `keel config migrate`"),
    }))
}

async fn doctor(ctx: &Ctx, target: &Target, config_arg: Option<PathBuf>) -> Result<()> {
    // keel: the active org's API answers /health.
    let keel = match crate::keel::config::active_org(&ctx.home, ctx.org.as_deref()) {
        Ok(org) => match crate::keel::api::KeelApi::for_org(&org)?.health().await {
            Ok(body) => {
                let api = crate::keel::api::KeelApi::for_org(&org)?;
                let (user, ok) = match api.whoami().await {
                    Ok(Some(who)) => (
                        json!({"name": who.name, "auth": who.auth, "token": api.has_token()}),
                        true,
                    ),
                    Ok(None) => (json!({"supported": false, "token": api.has_token()}), true),
                    Err(error) => (
                        json!({"error": failure::report(&error).0["error"], "token": api.has_token()}),
                        false,
                    ),
                };
                json!({"ok": ok, "org": org.org, "api_url": org.api_url, "health": body, "user": user})
            }
            Err(error) => {
                json!({"ok": false, "org": org.org, "api_url": org.api_url, "error": failure::report(&error).0["error"]})
            }
        },
        Err(error) => json!({"ok": false, "error": failure::report(&error).0["error"]}),
    };
    let keel_ok = keel["ok"] == true;
    let (dokploy, failed) = match paths::load_config(config_arg) {
        Ok(config) => match dk::doctor(&config, target).await {
            Ok((report, failed)) => (report, failed),
            Err(error) => {
                let (report, _) = failure::report(&error);
                let kind = error
                    .chain()
                    .find_map(|e| e.downcast_ref::<failure::Failure>())
                    .map_or(Kind::Error, |f| f.kind);
                (json!({"ok": false, "error": report["error"]}), Some(kind))
            }
        },
        Err(error) => (
            json!({"ok": false, "skipped": true, "error": failure::report(&error).0["error"]}),
            None,
        ),
    };
    print_json(&json!({
        "ok": keel_ok && dokploy["ok"] == true,
        "version": crate::VERSION,
        "keel": keel,
        "dokploy": dokploy,
    }))?;
    let code = match (failed, keel_ok) {
        (Some(kind), _) => kind.exit_code(),
        (None, false) => Kind::KeelUnreachable.exit_code(),
        (None, true) => 0,
    };
    if code != 0 {
        std::process::exit(code);
    }
    Ok(())
}

async fn compose_diff(
    config: &crate::dokploy::config::Config,
    target: &Target,
    service: &str,
    file: &std::path::Path,
) -> Result<()> {
    let instance = target.resolve(config)?;
    let client = crate::dokploy::client::DokployClient::new(instance)?;
    let compose = dk::compose_by_name(&client, service).await?;
    let remote = client
        .get(
            crate::dokploy::client::ReadOperation::Compose,
            &[("composeId", compose.id.as_str())],
        )
        .await?;
    let remote = remote
        .get("composeFile")
        .and_then(serde_json::Value::as_str)
        .context("la respuesta de Dokploy no trae composeFile")?;
    let local = std::fs::read_to_string(file)
        .with_context(|| format!("no se pudo leer {}", file.display()))?;
    let diff = extra::compose_diff(remote, &local);
    if std::io::stdout().is_terminal() && !diff.is_empty() {
        let c = ui::stdout_colors();
        for line in diff.lines() {
            let painted = if line.starts_with('+') && !line.starts_with("+++") {
                c.green(line)
            } else if line.starts_with('-') && !line.starts_with("---") {
                c.red(line)
            } else if line.starts_with("@@") {
                c.cyan(line)
            } else {
                line.to_owned()
            };
            println!("{painted}");
        }
        return Ok(());
    }
    print_json(&json!({
        "service": compose.label(), "compose_id": compose.id,
        "changed": !diff.is_empty(), "diff": diff,
        "next_step": "keel plan compose-update --service <compose> --file <file> [--redeploy]"
    }))
}

/// Moves dokploy-agent's config (`~/.config/dokploy-agent`) and state to keel's places.
fn migrate(dry_run: bool) -> Result<()> {
    let mut moves = Vec::new();
    let destination = paths::dokploy_home()?;
    if let Some(source) = paths::legacy_config_dir().filter(|d| d.exists()) {
        if destination.exists() {
            return Err(fail(
                Kind::Refused,
                format!(
                    "{} ya existe: revisa a mano qué conservar de {}",
                    destination.display(),
                    source.display()
                ),
            ));
        }
        moves.push((source, destination));
    }
    let state = paths::keel_state_dir()?;
    if let Some(source) = paths::legacy_state_dir().filter(|d| d.exists()) {
        if !state.exists() {
            moves.push((source, state));
        }
    }
    if moves.is_empty() {
        return print_json(&json!({"ok": true, "moved": [], "message": "nada que migrar"}));
    }
    if !dry_run {
        for (from, to) in &moves {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(from, to).with_context(|| {
                format!(
                    "no se pudo mover {} a {} (¿otro disco? muévelo a mano)",
                    from.display(),
                    to.display()
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    print_json(&json!({
        "ok": true, "dry_run": dry_run,
        "moved": moves.iter().map(|(f, t)| json!({"from": f, "to": t})).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::try_parse_from([&["keel"], args].concat())
    }

    #[test]
    fn command_tree_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn keeps_the_typescript_cli_flags() {
        assert!(parse(&["deploy", "-r", "-s", "api-prod"]).is_ok());
        assert!(parse(&["deploy", "-l", "-s", "stg", "--wait"]).is_ok());
        assert!(parse(&["create-version", "v1.4.0", "-d", "stg"]).is_ok());
        assert!(parse(&["create-version", "v1.4.0", "--wait"]).is_err());
        assert!(parse(&["rollback", "-s", "api-prod", "--to", "v1.2.0", "-y"]).is_ok());
        assert!(parse(&["deploys", "d3f1", "--log"]).is_ok());
        assert!(parse(&["deploys", "-s", "staging", "-n", "50"]).is_ok());
        assert!(parse(&["services", "--json"]).is_ok());
        assert!(parse(&["remote"]).is_ok());
        assert!(parse(&["login", "--token", "keel_pat_x"]).is_ok());
        assert!(
            parse(&[
                "deploy",
                "-s",
                "prod",
                "-v",
                "v1.0.0",
                "--rollback-on-failure"
            ])
            .is_ok()
        );
        assert!(parse(&["promote", "--from", "stg", "--to", "prod", "-y", "--wait"]).is_ok());
        assert!(parse(&["promote", "--from", "stg"]).is_err());
        assert!(parse(&["changes", "-s", "prod", "-v", "v1.2.0"]).is_ok());
        assert!(parse(&["lock", "-s", "prod", "-m", "incidente"]).is_ok());
        assert!(parse(&["unlock", "-s", "prod"]).is_ok());
        assert!(parse(&["init", "--check", "--json"]).is_ok());
        assert!(parse(&["skills"]).is_ok());
        assert!(parse(&["skills", "add", "keel-cli", "-g", "--agent", "claude"]).is_ok());
        assert!(parse(&["skills", "add"]).is_err());
        assert!(parse(&["skills", "remove", "keel-cli", "--from", "/tmp/keel"]).is_ok());
        assert!(
            parse(&[
                "env",
                "diff",
                "shop/stg/api",
                "shop/prod/api",
                "--target",
                "acme"
            ])
            .is_ok()
        );
        assert!(
            parse(&[
                "login",
                "--org",
                "github.com:acme",
                "--api-url",
                "keel.acme.dev/api"
            ])
            .is_ok()
        );
    }

    #[test]
    fn dokploy_commands_take_a_target() {
        assert!(
            parse(&[
                "get",
                "logs",
                "shop/production/api",
                "--container",
                "web",
                "-f"
            ])
            .is_ok()
        );
        assert!(parse(&["get", "services", "--target", "acme/production"]).is_ok());
        assert!(
            parse(&[
                "plan",
                "env-patch",
                "api",
                "--set",
                "TOKEN",
                "--unset",
                "OLD",
                "--redeploy"
            ])
            .is_ok()
        );
        assert!(
            parse(&[
                "plan",
                "mount-create",
                "api",
                "--type",
                "volume",
                "--mount-path",
                "/data",
                "--volume-name",
                "d"
            ])
            .is_ok()
        );
        assert!(parse(&["plan", "prune", "--all", "-y"]).is_ok());
        assert!(parse(&["compose", "diff", "docs", "--file", "/tmp/x.yaml"]).is_ok());
        assert!(parse(&["get", "logs", "core", "--tail", "-1"]).is_err());
    }
}
