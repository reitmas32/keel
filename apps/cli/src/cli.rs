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
        /// URL de la API de keel que usan los runners de GitHub (la variable KEEL_API_URL
        /// que pone keel init), si no es --api-url: p. ej. un gateway público delante de
        /// un keel interno. Vacío la borra.
        #[arg(long, value_name = "URL")]
        ci_api_url: Option<String>,
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
    /// Hacia dónde apunta esta carpeta: org y app de keel, e instancia de Dokploy.
    #[command(visible_alias = "remote")]
    Context(Target),
    /// Comprueba keel (API) y Dokploy (DNS, panel, key, versión, inventario).
    Doctor(Target),
    /// Estado de la app: sus scopes, versión actual, último deploy, CI y Dokploy.
    Status(Target),
    /// Quién eres para keel: tu nombre, rol y permisos por app y scope.
    Whoami,
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
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
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
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
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
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
        /// Versión con la que comparar; por defecto el tag semver más alto.
        #[arg(short = 'v', long = "version", value_name = "TAG")]
        version: Option<String>,
    },
    /// Congela los deploys de un scope (incidente, freeze de releases) con un motivo.
    Lock {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
        /// Motivo, visible en `keel scopes` y en el error de quien intente desplegar.
        #[arg(short = 'm', long = "message", value_name = "MOTIVO")]
        message: Option<String>,
    },
    /// Aprueba el deploy de otra persona en un scope que pide aprobación.
    Approve {
        /// Id del deploy (o sus primeros 4+ caracteres), como lo muestra `keel deploys`.
        id: String,
        /// Comentario opcional, visible en el historial.
        #[arg(short = 'm', long = "message", value_name = "COMENTARIO")]
        message: Option<String>,
    },
    /// Rechaza el deploy de otra persona: termina como deploy_failed con el motivo.
    Reject {
        /// Id del deploy (o sus primeros 4+ caracteres).
        id: String,
        /// Motivo del rechazo (obligatorio).
        #[arg(short = 'm', long = "message", value_name = "MOTIVO")]
        message: Option<String>,
    },
    /// Vuelve a permitir deploys en un scope bloqueado con `keel lock`.
    Unlock {
        /// Scope; si se omite, se pregunta.
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
    },
    /// Prepara el repo para keel: app en keel, scopes, secret y variable de GitHub y
    /// workflow de release. Se puede repetir: lo que ya está se salta.
    #[command(
        after_help = "Ejemplos:\n  keel init -y --scope prod=<id-de-compose> --scope stg=<url-de-dokploy>\n  keel init -y --ci-api-url https://gateway.acme.dev/keel/api --secret DEPLOY_API_TOKEN\n  keel init --rotate-token\n  keel init --pr\n  keel init --check\n\nEl token de CI solo pasa por el stdin de gh (nunca por argv ni por la salida), salvo con\n--no-github --show-token, que lo muestra una sola vez en la terminal."
    )]
    Init {
        /// Solo revisa (no crea ni cambia nada); sale con código 2 si falta algo.
        #[arg(
            long,
            conflicts_with_all = ["yes", "rotate_token", "scope", "tag_variable", "no_github", "show_token", "pr", "workflow"]
        )]
        check: bool,
        /// Reemplaza el workflow aunque esté adaptado.
        #[arg(long)]
        force: bool,
        /// No pregunta antes de crear la app o rotar su token.
        #[arg(short = 'y', long)]
        yes: bool,
        /// Rota el token de CI de una app existente y reemplaza el secret DEPLOY_API_TOKEN
        /// en el mismo paso (el CI con el token anterior deja de poder reportar).
        #[arg(long)]
        rotate_token: bool,
        /// Agrega un scope: alias=<id-de-dokploy|url-de-dokploy>. Se puede repetir; un
        /// alias que ya existe se salta.
        #[arg(long = "scope", value_name = "ALIAS=ID|URL", value_parser = crate::keel::init::parse_scope_arg)]
        scope: Vec<crate::keel::init::ScopeArg>,
        /// Variable del tag de un compose: alias=VARIABLE (DOCKER_TAG por defecto).
        #[arg(long = "tag-variable", value_name = "ALIAS=VARIABLE", value_parser = crate::keel::init::parse_tag_variable)]
        tag_variable: Vec<crate::keel::init::TagVariableArg>,
        /// Se salta GitHub (secret, variable y PR). Para crear la app o rotar su token
        /// exige --show-token.
        #[arg(long, conflicts_with = "pr")]
        no_github: bool,
        /// Con --no-github, muestra el token de CI una sola vez en la terminal.
        #[arg(long, requires = "no_github")]
        show_token: bool,
        /// Abre un PR con el workflow desde la rama keel/init.
        #[arg(long)]
        pr: bool,
        /// Secret de GitHub donde se guarda el token de CI.
        #[arg(long, value_name = "NOMBRE", default_value = "DEPLOY_API_TOKEN", value_parser = crate::keel::init::parse_secret_name)]
        secret: String,
        /// Valor de la variable KEEL_API_URL: la URL de la API de keel que alcanzan los
        /// runners de GitHub (p. ej. un gateway público). Reemplaza la que tenga el repo;
        /// sin ella se respeta la existente y, si falta, se usa la de `keel login
        /// --ci-api-url` o la URL de la API.
        #[arg(long, value_name = "URL", value_parser = crate::keel::init::parse_ci_api_url)]
        ci_api_url: Option<String>,
        /// Crea .github/workflows/keel-release.yml aunque el repo ya tenga un workflow de
        /// release que notifica a keel (p. ej. main.yml con un job notify-keel).
        #[arg(long)]
        workflow: bool,
    },
    /// Skills para agentes (Claude Code, Codex, Copilot) publicados en el repo de keel.
    Skills {
        #[command(subcommand)]
        command: Option<SkillsCommand>,
        #[command(flatten)]
        scope: SkillsScope,
    },
    /// Scopes de la app: a qué aplicación o compose de Dokploy apunta cada uno, la
    /// versión que corren y su último deploy.
    #[command(alias = "services")]
    Scopes,
    /// Deploys de la app, o el detalle de uno (con --log, su log de Dokploy).
    Deploys {
        /// Id (o sus primeros caracteres) de un deploy.
        id: Option<String>,
        /// Solo los deploys de este scope.
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
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
        #[arg(short = 's', long = "scope", alias = "service", value_name = "SCOPE")]
        scope: Option<String>,
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
        /// Instancia de Dokploy de B (organización/instancia), si no es la de A.
        #[arg(long = "target-b", value_name = "ORG/INSTANCIA")]
        target_b: Option<String>,
        /// Compara solo esta variable (se puede repetir): «iguales» si coinciden en A y B.
        #[arg(long = "key", value_name = "KEY")]
        keys: Vec<String>,
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
        Command::Login {
            api_url,
            token,
            ci_api_url,
        } => kc::login(&ctx, cli.org.clone(), api_url, token, ci_api_url).await,
        Command::Use { org } => kc::use_org(&ctx, org),
        Command::CreateVersion {
            version,
            deploy,
            wait,
        } => kc::create_version(&ctx, &version, deploy.as_deref(), wait).await,
        Command::Versions { limit } => kc::versions(&ctx, limit).await,
        Command::Deploy {
            scope,
            version,
            latest,
            latest_ready,
            wait,
            rollback_on_failure,
        } => {
            kc::deploy(
                &ctx,
                DeployArgs {
                    scope,
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
            scope,
            to,
            yes,
            wait,
        } => kc::rollback(&ctx, scope, to, yes, wait).await,
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
        Command::Changes { scope, version } => ops::changes(&ctx, scope, version).await,
        Command::Lock { scope, message } => ops::lock(&ctx, scope, message).await,
        Command::Unlock { scope } => ops::unlock(&ctx, scope).await,
        Command::Approve { id, message } => ops::decide(&ctx, id, true, message).await,
        Command::Reject { id, message } => ops::decide(&ctx, id, false, message).await,
        Command::Init {
            check,
            force,
            yes,
            rotate_token,
            scope,
            tag_variable,
            no_github,
            show_token,
            pr,
            secret,
            ci_api_url,
            workflow,
        } => {
            crate::keel::init::init(
                &ctx,
                crate::keel::init::InitArgs {
                    check,
                    force,
                    yes,
                    rotate_token,
                    scopes: scope,
                    tag_variables: tag_variable,
                    no_github,
                    show_token,
                    pr,
                    secret,
                    ci_api_url,
                    workflow,
                },
            )
            .await
        }
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
            command:
                EnvCommand::Diff {
                    target,
                    a,
                    b,
                    target_b,
                    keys,
                },
        } => {
            let target_b = target_b.map(|t| crate::dokploy::paths::Target { target: Some(t) });
            extra::env_diff_command(
                &config()?,
                &target,
                target_b.as_ref(),
                &a,
                &b,
                &keys,
                ctx.json,
            )
            .await
        }
        Command::Scopes => kc::scopes(&ctx).await,
        Command::Deploys {
            id,
            scope,
            limit,
            log,
            target,
        } => kc::deploys(&ctx, id, scope, limit, log, config_arg, &target).await,
        Command::Logs {
            scope,
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
                    scope,
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
        Command::Whoami => ops::whoami(&ctx).await,
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
                        json!({"name": who.name, "role": who.role, "auth": who.auth, "token": api.has_token()}),
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
        assert!(parse(&["scopes", "--json"]).is_ok());
        assert!(parse(&["services", "--json"]).is_ok());
        assert!(parse(&["deploy", "--scope", "prod", "-l"]).is_ok());
        // The pre-0.3.0 flag keeps working for scripts.
        assert!(parse(&["deploy", "--service", "prod", "-l"]).is_ok());
        assert!(parse(&["logs", "--service", "prod"]).is_ok());
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
        assert!(
            parse(&[
                "init",
                "-y",
                "--scope",
                "prod=cmp1",
                "--scope",
                "stg=https://dokploy.acme.dev/x",
                "--tag-variable",
                "prod=IMAGE_TAG",
                "--pr"
            ])
            .is_ok()
        );
        assert!(parse(&["init", "--scope", "prod"]).is_err());
        assert!(parse(&["init", "--check", "--rotate-token"]).is_err());
        assert!(parse(&["init", "--show-token"]).is_err());
        assert!(parse(&["init", "--no-github", "--show-token", "--rotate-token"]).is_ok());
        assert!(parse(&["init", "--no-github", "--pr"]).is_err());
        assert!(parse(&["init", "--check", "--secret", "KEEL_CI_TOKEN"]).is_ok());
        assert!(parse(&["init", "--check", "--workflow"]).is_err());
        assert!(parse(&["init", "--secret", "GITHUB_TOKEN"]).is_err());
        assert!(
            parse(&[
                "init",
                "--ci-api-url",
                "gateway.acme.dev/keel/api",
                "--workflow"
            ])
            .is_ok()
        );
        assert!(parse(&["login", "--ci-api-url", "https://gateway.acme.dev/keel/api"]).is_ok());
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
                "env-copy",
                "--from",
                "stg/api",
                "--to",
                "prod/api",
                "--key",
                "API_KEY",
                "--key",
                "RSA:JWT_KEY",
                "--from-target",
                "acme/staging",
                "--overwrite",
                "--redeploy"
            ])
            .is_ok()
        );
        // Nothing to copy without --key, and never a value on the command line.
        assert!(parse(&["plan", "env-copy", "--from", "a", "--to", "b"]).is_err());
        assert!(
            parse(&[
                "env",
                "diff",
                "stg/api",
                "api",
                "--target-b",
                "acme/other",
                "--key",
                "A",
                "--key",
                "B"
            ])
            .is_ok()
        );
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
