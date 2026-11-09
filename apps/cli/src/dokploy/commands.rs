use crate::dokploy::paths::Target;
use crate::dokploy::{
    approval,
    client::{
        DokployClient, ReadOperation, ServiceAction, ServiceKind, http_client, is_destructive,
        validate_procedure,
    },
    config::{ApprovalMode, Config, InstanceConfig},
    inventory::{self, Service},
    logs, net,
    plan::{self, Plan, PlannedAction},
    print_json,
    redact::{self, env_keys},
};
use crate::failure::{self, Kind};
use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};
use tokio::task::JoinSet;

/// `bail!` with a failure kind the harness can branch on (see `failure`).
macro_rules! refuse {
    ($kind:expr, $($arg:tt)+) => {
        return Err(crate::failure::fail($kind, format!($($arg)+)))
    };
}

#[derive(Subcommand)]
pub enum GetCommand {
    /// Env backups saved before each env-set, env-patch or env-restore (local, no values).
    EnvBackups {
        /// Only the backups of this service (as `get service` names it).
        service: Option<String>,
    },
    /// Volumes, bind mounts and file mounts of a service.
    Mounts {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
    },
    /// Backup destinations (S3 and compatible), without credentials.
    Destinations(Target),
    /// Scheduled backups of a database.
    Backups {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
    },
    /// Projects with their number of services.
    Projects(Target),
    /// Servers registered in the panel.
    Servers(Target),
    /// Detail of one server.
    Server {
        #[command(flatten)]
        target: Target,
        /// Server id (see get servers).
        #[arg(long)]
        id: String,
    },
    /// Services running on one server.
    ServerServices {
        #[command(flatten)]
        target: Target,
        /// Server id (see get servers).
        #[arg(long)]
        id: String,
    },
    /// Every service (apps, composes, databases) with its environment and status.
    Services {
        #[command(flatten)]
        target: Target,
        /// Only services whose project, environment, name or kind contain this text.
        filter: Option<String>,
    },
    /// Detail of one service: `name`, `environment/name` or `project/environment/name`.
    Service {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
        /// The full redacted API response instead of the summary.
        #[arg(long)]
        raw: bool,
    },
    /// The env keys of a service. Values never reach stdout.
    Env {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
        /// Save the real env block to a new owner-only file (absolute path that must not exist).
        #[arg(long)]
        write_to: Option<PathBuf>,
    },
    /// A Compose: its settings and, on request, a sanitized view or the real file.
    Compose {
        #[command(flatten)]
        target: Target,
        /// Compose id. Use --service to find it by name instead.
        #[arg(long, required_unless_present = "service", conflicts_with = "service")]
        id: Option<String>,
        /// Compose name: `name`, `environment/name` or `project/environment/name`.
        #[arg(long)]
        service: Option<String>,
        /// Include a sanitized Compose definition; environment and secret blocks are removed.
        #[arg(long)]
        show_compose: bool,
        /// Save the original Compose, including any secrets, to a new owner-only file.
        /// The path must be absolute and must not already exist.
        #[arg(long)]
        write_to: Option<PathBuf>,
    },
    /// Domains in Dokploy's registry (routing defined in Traefik labels is not listed here).
    Domains {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
    },
    /// Latest deployments of an application or Compose.
    Deployments {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
        #[arg(long, default_value_t = 15)]
        limit: usize,
    },
    /// The last lines a service's containers printed, with secrets redacted.
    Logs {
        #[command(flatten)]
        target: Target,
        /// `name`, `environment/name` or `project/environment/name`.
        query: String,
        /// Compose service (`web`), container name or id. Needed when a Compose
        /// runs several containers.
        #[arg(long)]
        container: Option<String>,
        /// Keep printing new lines until Ctrl-C (polls every few seconds).
        #[arg(short = 'f', long)]
        follow: bool,
        /// Lines to read, before --search (at most security.log_tail_max).
        #[arg(long, default_value_t = 200)]
        tail: u32,
        /// `all` or a duration: 30s, 10m, 1h, 2d.
        #[arg(long, default_value = "all")]
        since: String,
        /// Only lines containing this text, ignoring case. Matched here, after
        /// redaction; Dokploy never receives it.
        #[arg(long)]
        search: Option<String>,
    },
    /// The build and deploy log of an application or Compose, with secrets redacted.
    DeployLog {
        #[command(flatten)]
        target: Target,
        /// Service: `name`, `environment/name` or `project/environment/name`.
        query: String,
        /// Deployment id (see `get deployments`); the latest when omitted.
        #[arg(long)]
        deployment: Option<String>,
        /// Last lines to read, before --search (at most security.log_tail_max).
        #[arg(long, default_value_t = 200)]
        tail: u32,
        /// Only lines containing this text, ignoring case, matched after redaction.
        #[arg(long)]
        search: Option<String>,
    },
    /// Docker containers the panel sees.
    Containers {
        #[command(flatten)]
        target: Target,
        /// Server id; the panel's own host when omitted.
        #[arg(long)]
        server_id: Option<String>,
    },
    /// Any read procedure, redacted: `get raw project.one --param projectId=…`.
    Raw {
        #[command(flatten)]
        target: Target,
        /// Read procedure, e.g. project.one (router.procedure).
        procedure: String,
        /// Query parameter as key=value; repeatable.
        #[arg(long = "param")]
        params: Vec<String>,
    },
}

#[derive(Subcommand)]
pub enum PlanCommand {
    /// Plans waiting to be applied, with their target and expiry.
    List,
    /// Remove expired plans (with --all, pending ones too) from the state dir.
    Prune {
        #[arg(long)]
        all: bool,
        /// Skip the confirmation --all asks for.
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Change only some variables of a service's env.
    EnvPatch(EnvPatchArgs),
    /// Put back an env saved before an earlier change (see get env-backups).
    EnvRestore(EnvRestoreArgs),
    /// Add a volume, bind mount or file mount to a service.
    MountCreate(MountCreateArgs),
    /// One pending plan again: its summary, target and approval token.
    Show {
        /// Plan id (from plan, plan list or plan show).
        plan: String,
    },
    /// Replace a Compose file (refused if the remote one changed since the plan).
    ComposeUpdate(ComposeUpdateArgs),
    /// Create a Postgres database; deploy it afterwards with plan deploy.
    PostgresCreate(PostgresCreateArgs),
    /// Create a Mongo database; deploy it afterwards with plan deploy.
    MongoCreate(MongoCreateArgs),
    /// Add a scheduled backup to a Postgres, MySQL, MariaDB or Mongo service.
    BackupCreate(BackupCreateArgs),
    /// Deploy a service.
    Deploy(ServiceArgs),
    /// Redeploy an application or Compose.
    Redeploy(ServiceArgs),
    /// Start a stopped service.
    Start(ServiceArgs),
    /// Stop a service.
    Stop(ServiceArgs),
    /// Replace ALL env variables of a service with the content of a file.
    EnvSet(EnvSetArgs),
    /// Create a raw Compose from a file.
    ComposeCreate(ComposeCreateArgs),
    /// Change a Compose's source type, name or description.
    ComposeSettings(ComposeSettingsArgs),
    /// POST to a procedure listed in security.raw_post_allowlist.
    RawPost(RawPostArgs),
}
#[derive(Args)]
pub struct ComposeUpdateArgs {
    #[command(flatten)]
    target: Target,
    /// Compose id; or use --service to find it by name.
    #[arg(long, required_unless_present = "service", conflicts_with = "service")]
    compose_id: Option<String>,
    /// Compose name: `name`, `environment/name` or `project/environment/name`.
    #[arg(long)]
    service: Option<String>,
    /// Local file to plan with.
    #[arg(long)]
    file: PathBuf,
    /// Redeploy the Compose in the same plan.
    #[arg(long)]
    redeploy: bool,
    /// Plan even if keel cannot be asked whether this service is a keel scope.
    #[arg(long)]
    not_keel_managed: bool,
}
#[derive(Args)]
pub struct PostgresCreateArgs {
    #[command(flatten)]
    target: Target,
    /// Environment id (see get projects).
    #[arg(long)]
    environment_id: String,
    /// Name of the new service.
    #[arg(long)]
    name: String,
    /// Database to create.
    #[arg(long)]
    database_name: String,
    /// Database user.
    #[arg(long)]
    database_user: String,
    /// Environment variable holding the password; read only at apply time.
    #[arg(long)]
    password_env: String,
    /// Docker image (Dokploy default when omitted).
    #[arg(long)]
    docker_image: Option<String>,
    /// Server id; the panel host when omitted.
    #[arg(long)]
    server_id: Option<String>,
}
#[derive(Args)]
pub struct MongoCreateArgs {
    #[command(flatten)]
    target: Target,
    /// Environment id, or `project/environment` (e.g. landing/production).
    #[arg(long)]
    environment: String,
    /// Server id or name; the panel's own host when omitted.
    #[arg(long)]
    server: Option<String>,
    /// Name of the new service.
    #[arg(long)]
    name: String,
    #[arg(long)]
    description: Option<String>,
    /// Database user.
    #[arg(long)]
    database_user: String,
    /// Env var holding the password; read at apply time only.
    #[arg(long)]
    password_env: String,
    /// Required: the panel's default image is not a real Mongo tag.
    #[arg(long)]
    docker_image: String,
    /// Memory limit in bytes.
    #[arg(long)]
    memory_limit_bytes: Option<u64>,
}
#[derive(Args)]
pub struct BackupCreateArgs {
    #[command(flatten)]
    target: Target,
    /// `name`, `environment/name` or `project/environment/name`.
    service: String,
    /// Database to back up.
    #[arg(long)]
    database: String,
    /// Destination id or name; see `keel get destinations`.
    #[arg(long)]
    destination: String,
    /// Cron expression with five fields, e.g. "30 3 * * *".
    #[arg(long)]
    schedule: String,
    /// Path inside the destination, e.g. prod/shop-db/.
    #[arg(long)]
    prefix: String,
    /// Backups to keep.
    #[arg(long)]
    keep_latest_count: u32,
}
#[derive(Args)]
pub struct ServiceArgs {
    #[command(flatten)]
    target: Target,
    /// `name`, `environment/name` or `project/environment/name`.
    service: String,
    /// Plan even when keel cannot be asked whether this is a keel scope.
    #[arg(long)]
    not_keel_managed: bool,
}

#[derive(Args)]
pub struct EnvPatchArgs {
    #[command(flatten)]
    target: Target,
    service: String,
    /// Add or change KEY. The value comes from $KEEL_SET_<KEY>, is typed
    /// without echo, or (for a single --set) is read from stdin; never from
    /// the command line. Empty values are refused.
    #[arg(long = "set", value_name = "KEY")]
    set: Vec<String>,
    /// Add or change KEY with the content of a file (certificates, JSON).
    #[arg(long = "set-from-file", value_name = "KEY=/ABS/PATH")]
    set_from_file: Vec<String>,
    /// Remove KEY; fails if the env has no such key.
    #[arg(long = "unset", value_name = "KEY")]
    unset: Vec<String>,
    /// Redeploy the service in the same plan.
    #[arg(long)]
    redeploy: bool,
    /// Plan even if keel cannot be asked whether this service is a keel scope.
    #[arg(long)]
    not_keel_managed: bool,
}

#[derive(Args)]
pub struct EnvRestoreArgs {
    #[command(flatten)]
    target: Target,
    service: String,
    /// Timestamp of the backup (or a unique prefix), from get env-backups.
    #[arg(long)]
    backup: String,
    /// Redeploy the service in the same plan.
    #[arg(long)]
    redeploy: bool,
    /// Plan even if keel cannot be asked whether this service is a keel scope.
    #[arg(long)]
    not_keel_managed: bool,
}

#[derive(Clone, Copy, ValueEnum)]
pub enum MountType {
    Volume,
    Bind,
    File,
}

#[derive(Args)]
pub struct MountCreateArgs {
    #[command(flatten)]
    target: Target,
    service: String,
    #[arg(long = "type", value_enum)]
    mount_type: MountType,
    /// Path inside the container.
    #[arg(long)]
    mount_path: String,
    /// Docker volume name (--type volume).
    #[arg(long)]
    volume_name: Option<String>,
    /// Absolute path on the host (--type bind).
    #[arg(long)]
    host_path: Option<String>,
    /// Local file whose content is mounted (--type file).
    #[arg(long)]
    file: Option<PathBuf>,
    /// Redeploy the service in the same plan.
    #[arg(long)]
    redeploy: bool,
}
#[derive(Args)]
pub struct EnvSetArgs {
    #[command(flatten)]
    target: Target,
    service: String,
    /// dotenv file with the complete new env block.
    #[arg(long)]
    file: PathBuf,
    /// Redeploy the service in the same plan.
    #[arg(long)]
    redeploy: bool,
    /// Plan even if keel cannot be asked whether this service is a keel scope.
    #[arg(long)]
    not_keel_managed: bool,
}
#[derive(Args)]
pub struct ComposeCreateArgs {
    #[command(flatten)]
    target: Target,
    /// Environment id, or `project/environment` (e.g. landing/production).
    #[arg(long)]
    environment: String,
    /// Server id or name; the panel's own host when omitted.
    #[arg(long)]
    server: Option<String>,
    /// Name of the new service.
    #[arg(long)]
    name: String,
    #[arg(long)]
    description: Option<String>,
    /// Local file to plan with.
    #[arg(long)]
    file: PathBuf,
}
#[derive(Clone, Copy, ValueEnum)]
enum SourceType {
    Raw,
    Github,
    Gitlab,
    Bitbucket,
    Gitea,
    Git,
}
impl SourceType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Bitbucket => "bitbucket",
            Self::Gitea => "gitea",
            Self::Git => "git",
        }
    }
}
#[derive(Args)]
pub struct ComposeSettingsArgs {
    #[command(flatten)]
    target: Target,
    service: String,
    #[arg(long)]
    source_type: Option<SourceType>,
    #[arg(long)]
    name: Option<String>,
    #[arg(long)]
    description: Option<String>,
}
#[derive(Args)]
pub struct RawPostArgs {
    #[command(flatten)]
    target: Target,
    /// Read procedure, e.g. project.one (router.procedure).
    procedure: String,
    /// JSON object sent as the request body.
    #[arg(long)]
    body_file: PathBuf,
}
#[derive(Args)]
pub struct ApplyArgs {
    /// Plan id (from plan, plan list or plan show).
    #[arg(long)]
    plan: String,
    /// The plan approval_token_sha256, after a person reviewed the plan.
    #[arg(long)]
    approve: String,
}
#[derive(Subcommand)]
pub enum BackupCommand {
    /// Save a Compose file into a local, already-cloned backup repository.
    Compose(BackupComposeArgs),
}
#[derive(Args)]
pub struct BackupComposeArgs {
    #[command(flatten)]
    target: Target,
    /// Compose id.
    #[arg(long)]
    compose_id: String,
    /// Label of this backup (e.g. a date), used in the file name and commit.
    #[arg(long)]
    version: String,
    /// Commit the backup in the backup repository (never pushes).
    #[arg(long)]
    commit: bool,
}

pub(crate) fn envelope(instance: &InstanceConfig, data: Value) -> Value {
    json!({"organization": instance.organization, "instance": instance.name, "data": data})
}

// ------------------------------------------------------------------- doctor

/// The Dokploy checks of `keel doctor` and the failure kind of the first one that failed.
pub(crate) async fn doctor(config: &Config, target: &Target) -> Result<(Value, Option<Kind>)> {
    let selection = target.selection(config)?;
    let instance = selection.instance;
    let mut checks = Vec::new();
    let mut ok = true;
    let host = instance.base_url.host_str().unwrap_or_default().to_owned();
    let port = instance.base_url.port_or_known_default().unwrap_or(443);
    checks.push(json!({"check": "target", "ok": true, "selected_by": selection.selected_by}));

    let key = instance.api_key();
    let key_present = key.is_ok();
    checks.push(json!({
        "check": "config", "ok": key_present,
        "base_url": instance.base_url, "api_key": instance.key_source(),
        "approval": format!("{:?}", instance.approval(&config.security)).to_lowercase(),
        "hint": key.err().map(|e| e.to_string())
    }));
    ok &= key_present;

    // A private panel only resolves inside the VPN: DNS is diagnosed first.
    match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(addresses) => {
            let addresses: Vec<_> = addresses.map(|a| a.ip()).collect();
            let public_http = instance.base_url.scheme() == "http"
                && addresses.iter().any(|ip| !net::is_private_ip(*ip));
            checks.push(json!({
                "check": "dns", "ok": !public_http, "host": host,
                "addresses": addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "hint": if public_http { json!("an http panel resolves to a public address: the API key would leave the private network") } else { Value::Null }
            }));
            ok &= !public_http;
        }
        Err(_) => {
            checks.push(json!({"check": "dns", "ok": false, "host": host,
                "hint": "the name does not resolve; for a .internal panel, connect to the VPN"}));
            return finish_doctor(instance, checks, Some(Kind::Network));
        }
    }

    match http_client(instance)?
        .get(instance.base_url.clone())
        .send()
        .await
    {
        Ok(response) => checks
            .push(json!({"check": "panel", "ok": true, "http_status": response.status().as_u16()})),
        Err(_) => {
            checks.push(json!({"check": "panel", "ok": false,
                "hint": "the name resolves but nothing answers: is the VPN routing to it, is the panel up?"}));
            return finish_doctor(instance, checks, Some(Kind::Network));
        }
    }

    if !key_present {
        return finish_doctor(instance, checks, Some(Kind::Config));
    }
    let client = DokployClient::new(instance)?;
    if let Ok(version) = client
        .get_procedure("settings.getDokployVersion", &[])
        .await
    {
        checks.push(json!({"check": "version", "ok": true, "version": version}));
    }
    match inventory::load(&client).await {
        Ok(services) => {
            let projects: std::collections::BTreeSet<_> =
                services.iter().map(|s| s.project.clone()).collect();
            checks.push(json!({"check": "api", "ok": true, "projects": projects.len(), "services": services.len()}));
        }
        Err(error) => {
            let (report, _) = failure::report(&error);
            checks.push(json!({"check": "api", "ok": false, "error": report["error"]}));
            let kind = error
                .chain()
                .find_map(|e| e.downcast_ref::<failure::Failure>())
                .map_or(Kind::Error, |f| f.kind);
            return finish_doctor(instance, checks, Some(kind));
        }
    }
    finish_doctor(instance, checks, (!ok).then_some(Kind::Error))
}

/// Prints the checks; a failing doctor exits with the code of its first
/// failure kind (10 network, 2 config) so a harness can tell VPN from key.
pub(crate) fn finish_doctor(
    instance: &InstanceConfig,
    checks: Vec<Value>,
    failed: Option<Kind>,
) -> Result<(Value, Option<Kind>)> {
    Ok((
        json!({
            "organization": instance.organization, "instance": instance.name,
            "ok": failed.is_none(), "failure": failed, "checks": checks
        }),
        failed,
    ))
}

// --------------------------------------------------------------------- reads

pub(crate) async fn get(config: &Config, state: &Path, command: GetCommand) -> Result<()> {
    use crate::dokploy::extra;
    match command {
        GetCommand::EnvBackups { service } => {
            print_json(&extra::env_backups_view(state, service.as_deref())?)
        }
        GetCommand::Mounts { target, query } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &query).await?;
            print_json(&envelope(instance, extra::mounts_view(&service, &detail)))
        }
        GetCommand::Destinations(target) => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let destinations = client.get_procedure("destination.all", &[]).await?;
            print_json(&envelope(instance, extra::destinations_view(&destinations)))
        }
        GetCommand::Backups { target, query } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &query).await?;
            if service.kind.backup_database_type().is_none() {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: only Postgres, MySQL, MariaDB and Mongo have scheduled backups",
                    service.label(),
                    service.kind.label()
                );
            }
            print_json(&envelope(instance, extra::backups_view(&service, &detail)))
        }
        GetCommand::Projects(target) => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let projects = client.get(ReadOperation::Projects, &[]).await?;
            let services = inventory::flatten(&projects);
            let rows: Vec<Value> = projects
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| {
                    let name = p.get("name").and_then(Value::as_str).unwrap_or_default();
                    json!({
                        "project": name, "project_id": p.get("projectId"),
                        "environments": p.get("environments").and_then(Value::as_array)
                            .map(|e| e.iter().map(|e| json!({"name": e.get("name"), "environment_id": e.get("environmentId")})).collect::<Vec<_>>()),
                        "services": services.iter().filter(|s| s.project == name).count()
                    })
                })
                .collect();
            print_json(&envelope(instance, json!(rows)))
        }
        GetCommand::Servers(target) => {
            let instance = target.resolve(config)?;
            let servers = DokployClient::new(instance)?
                .get(ReadOperation::Servers, &[])
                .await?;
            let rows: Vec<Value> = servers
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| json!({"name": s.get("name"), "ip": s.get("ipAddress"), "user": s.get("username"), "status": s.get("serverStatus"), "server_id": s.get("serverId")}))
                .collect();
            print_json(&envelope(instance, json!(rows)))
        }
        GetCommand::Server { target, id } => {
            raw_read(
                config,
                &target,
                ReadOperation::Server.endpoint(),
                &[("serverId", id)],
            )
            .await
        }
        GetCommand::ServerServices { target, id } => {
            raw_read(
                config,
                &target,
                ReadOperation::ServerServices.endpoint(),
                &[("serverId", id)],
            )
            .await
        }
        GetCommand::Services { target, filter } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let mut services = inventory::load(&client).await?;
            services.sort_by(|a, b| {
                (&a.project, &a.environment, &a.name).cmp(&(&b.project, &b.environment, &b.name))
            });
            let shown: Vec<&Service> = match filter.as_deref() {
                Some(filter) => inventory::filter(&services, filter),
                None => services.iter().collect(),
            };
            print_json(&envelope(instance, json!(shown)))
        }
        GetCommand::Service { target, query, raw } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &query).await?;
            let data = if raw {
                redact::redact(detail)
            } else {
                service_summary(&client, &service, &detail).await
            };
            print_json(&envelope(instance, data))
        }
        GetCommand::Env {
            target,
            query,
            write_to,
        } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &query).await?;
            if !service.kind.has_environment() {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: Dokploy keeps no env block for it",
                    service.label(),
                    service.kind.label()
                );
            }
            let env = detail
                .get("env")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut data = json!({
                "service": service.label(), "variables": env_keys(env),
                "values": "hidden; use --write-to to save them to an owner-only file"
            });
            if let Some(path) = write_to {
                ensure_new_absolute(&path)?;
                write_private(&path, env.as_bytes())?;
                data["written_to"] = json!(path);
                data["env_sha256"] = json!(plan::content_sha256(env));
            }
            print_json(&envelope(instance, data))
        }
        GetCommand::Compose {
            target,
            id,
            service,
            show_compose,
            write_to,
        } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let compose_id = match (id, service) {
                (Some(id), _) => id,
                (None, Some(query)) => compose_by_name(&client, &query).await?.id,
                (None, None) => bail!("pass --id or --service"),
            };
            let result = client
                .get(
                    ReadOperation::Compose,
                    &[("composeId", compose_id.as_str())],
                )
                .await?;
            let downloaded_to = write_to
                .as_deref()
                .map(|path| export_compose(&result, path))
                .transpose()?;
            print_json(&envelope(
                instance,
                compose_output(result, show_compose, downloaded_to.as_deref()),
            ))
        }
        GetCommand::Domains { target, query } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &query).await?;
            let domains: Vec<Value> = detail.get("domains").and_then(Value::as_array).into_iter().flatten()
                .map(|d| json!({"host": d.get("host"), "path": d.get("path"), "port": d.get("port"), "https": d.get("https"), "service_name": d.get("serviceName")}))
                .collect();
            let note = if domains.is_empty() {
                json!(
                    "no domains in Dokploy's registry; routing may live in Traefik labels inside the Compose"
                )
            } else {
                Value::Null
            };
            print_json(&envelope(
                instance,
                json!({"service": service.label(), "domains": domains, "note": note}),
            ))
        }
        GetCommand::Deployments {
            target,
            query,
            limit,
        } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let services = inventory::load(&client).await?;
            let service = inventory::resolve(&services, &query)?.clone();
            let Some(procedure) = service.kind.deployments_procedure() else {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: Dokploy keeps no deployment history for it; see `get service`",
                    service.label(),
                    service.kind.label()
                );
            };
            let deployments = client
                .get_procedure(procedure, &[(service.kind.id_param(), service.id.as_str())])
                .await?;
            let rows: Vec<Value> = deployments.as_array().into_iter().flatten().take(limit)
                .map(|d| json!({"created_at": d.get("createdAt"), "status": d.get("status"), "title": d.get("title"), "description": d.get("description"), "deployment_id": d.get("deploymentId")}))
                .collect();
            print_json(&envelope(
                instance,
                json!({"service": service.label(), "deployments": rows}),
            ))
        }
        GetCommand::Logs {
            target,
            query,
            container,
            follow,
            tail,
            since,
            search,
        } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let service = ServiceRef::Query(query);
            if follow {
                return crate::dokploy::extra::follow_logs(
                    config,
                    &client,
                    &service,
                    container.as_deref(),
                    search.as_deref(),
                    crate::dokploy::extra::FollowOutput::Json,
                )
                .await;
            }
            let data = fetch_logs(
                config,
                &client,
                &service,
                container.as_deref(),
                tail,
                &since,
                search.as_deref(),
            )
            .await?;
            print_json(&envelope(instance, data))
        }
        GetCommand::DeployLog {
            target,
            query,
            deployment,
            tail,
            search,
        } => {
            let instance = target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let data = fetch_deploy_log(
                config,
                &client,
                &ServiceRef::Query(query),
                deployment.as_deref(),
                None,
                tail,
                search.as_deref(),
            )
            .await?;
            print_json(&envelope(instance, data))
        }
        GetCommand::Containers { target, server_id } => {
            let instance = target.resolve(config)?;
            let query: Vec<(&str, &str)> = server_id
                .as_deref()
                .map(|id| vec![("serverId", id)])
                .unwrap_or_default();
            let containers = DokployClient::new(instance)?
                .get_procedure("docker.getContainers", &query)
                .await?;
            let rows: Vec<Value> = containers.as_array().into_iter().flatten()
                .map(|c| json!({"name": c.get("name"), "state": c.get("state").or_else(|| c.get("status")), "image": c.get("image"), "container_id": c.get("containerId")}))
                .collect();
            print_json(&envelope(instance, json!(rows)))
        }
        GetCommand::Raw {
            target,
            procedure,
            params,
        } => {
            let params = params
                .iter()
                .map(|p| {
                    p.split_once('=')
                        .map(|(k, v)| (k.to_owned(), v.to_owned()))
                        .with_context(|| format!("--param must be key=value, got {p:?}"))
                })
                .collect::<Result<Vec<_>>>()?;
            let action = procedure.split_once('.').map_or("", |(_, action)| action);
            if action.to_ascii_lowercase().contains("logs") {
                refuse!(
                    Kind::Refused,
                    "{procedure} returns raw logs that `get raw` cannot redact; use `get logs` or `get deploy-log`"
                );
            }
            raw_read(config, &target, &procedure, &params).await
        }
    }
}

/// A Dokploy service named by a person (`project/environment/name`) or by
/// its id (what keel stores for a scope).
#[derive(Clone, Debug)]
pub enum ServiceRef {
    Query(String),
    Id(String),
}

pub async fn resolve_ref(client: &DokployClient, service: &ServiceRef) -> Result<(Service, Value)> {
    match service {
        ServiceRef::Query(query) => resolve_detail(client, query).await,
        ServiceRef::Id(id) => {
            let services = inventory::load(client).await?;
            let Some(found) = services.iter().find(|s| &s.id == id) else {
                refuse!(
                    Kind::ServiceNotFound,
                    "Dokploy has no service with id {id}; it was deleted or belongs to another instance (see `keel context`)"
                );
            };
            let found = found.clone();
            let detail = client
                .get_procedure(
                    &format!("{}.one", found.kind.router()),
                    &[(found.kind.id_param(), found.id.as_str())],
                )
                .await?;
            Ok((found, detail))
        }
    }
}

/// The redacted last lines of a service's container, as `get logs` prints them.
pub async fn fetch_logs(
    config: &Config,
    client: &DokployClient,
    service: &ServiceRef,
    container: Option<&str>,
    tail: u32,
    since: &str,
    search: Option<&str>,
) -> Result<Value> {
    logs::validate_tail(tail, config.security.log_tail_max)?;
    let docker_since = logs::docker_since(since)?;
    if let Some(search) = search {
        logs::validate_search(search)?;
    }
    let (service, detail) = resolve_ref(client, service).await?;
    let mut params = vec![
        (service.kind.id_param(), service.id.clone()),
        ("tail", tail.to_string()),
        ("since", docker_since),
    ];
    let (container_name, container_state) = if service.kind == ServiceKind::Compose {
        let picked = compose_container(client, &service, &detail, container).await?;
        params.push(("containerId", picked.id));
        (json!(picked.name), json!(picked.state))
    } else {
        if container.is_some() {
            refuse!(
                Kind::Refused,
                "--container only applies to a Compose; {} is a {} with a single container",
                service.label(),
                service.kind.label()
            );
        }
        (
            detail.get("appName").cloned().unwrap_or_default(),
            Value::Null,
        )
    };
    let query: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let text = client
        .get_procedure(&format!("{}.readLogs", service.kind.router()), &query)
        .await?;
    let lines = redacted_lines(&detail, &text, search)?;
    Ok(json!({
        "service": service.label(), "container": container_name,
        "container_state": container_state, "tail": tail, "since": since,
        "search": search, "lines": lines
    }))
}

/// The redacted build and deploy log of a deployment: the one given, the
/// newest one created at or after `after` (an ISO date), or the latest. A
/// database keeps no deployments in Dokploy, so for one this answers its
/// service logs instead, saying so.
pub async fn fetch_deploy_log(
    config: &Config,
    client: &DokployClient,
    service_ref: &ServiceRef,
    deployment: Option<&str>,
    after: Option<&str>,
    tail: u32,
    search: Option<&str>,
) -> Result<Value> {
    logs::validate_tail(tail, config.security.log_tail_max)?;
    if let Some(search) = search {
        logs::validate_search(search)?;
    }
    let (service, detail) = resolve_ref(client, service_ref).await?;
    let Some(procedure) = service.kind.deployments_procedure() else {
        if deployment.is_some() {
            refuse!(
                Kind::Refused,
                "{} is a {}: Dokploy keeps no deployments for it, so there is no deployment id to pick",
                service.label(),
                service.kind.label()
            );
        }
        // A database "deploy" starts its Swarm service: why it failed is in that service's log.
        let mut data = fetch_logs(
            config,
            client,
            &ServiceRef::Id(service.id.clone()),
            None,
            tail,
            "all",
            search,
        )
        .await?;
        data["deployment"] = Value::Null;
        data["note"] = json!(format!(
            "{} is a {}: Dokploy keeps no deployment log for databases, so these are the service's own logs, where a failed start shows",
            service.label(),
            service.kind.label()
        ));
        data["application_status"] = detail.get("applicationStatus").cloned().unwrap_or_default();
        return Ok(data);
    };
    let deployments = client
        .get_procedure(procedure, &[(service.kind.id_param(), service.id.as_str())])
        .await?;
    let mut deployments: Vec<&Value> = deployments.as_array().into_iter().flatten().collect();
    let created = |d: &Value| {
        d.get("createdAt")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    deployments.sort_by_key(|d| std::cmp::Reverse(created(d)));
    let id_of = |d: &Value| {
        d.get("deploymentId")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let chosen = match (deployment, after) {
        // Only a deployment of this service: its secrets are the ones redacted.
        (Some(id), _) => deployments.iter().find(|d| id_of(d).as_deref() == Some(id)),
        (None, Some(after)) => {
            let after = chrono::DateTime::parse_from_rfc3339(after).ok();
            // The oldest deployment that started at or after keel sent it to Dokploy.
            deployments.iter().rev().find(|d| {
                let at = created(d).and_then(|c| chrono::DateTime::parse_from_rfc3339(&c).ok());
                match (at, after) {
                    (Some(at), Some(after)) => at >= after - chrono::Duration::seconds(5),
                    _ => false,
                }
            })
        }
        (None, None) => deployments.first(),
    };
    let Some(chosen) = chosen else {
        refuse!(
            Kind::ServiceNotFound,
            "{} has no deployment {}; see `get deployments`",
            service.label(),
            deployment.unwrap_or(if after.is_some() {
                "after that deploy"
            } else {
                "yet"
            })
        );
    };
    let deployment_id = id_of(chosen).context("Dokploy listed a deployment without an id")?;
    let text = client
        .get_procedure(
            "deployment.readLogs",
            &[
                ("deploymentId", deployment_id.as_str()),
                ("tail", &tail.to_string()),
            ],
        )
        .await?;
    let lines = redacted_lines(&detail, &text, search)?;
    Ok(json!({
        "service": service.label(),
        "deployment": {
            "deployment_id": deployment_id, "status": chosen.get("status"),
            "title": chosen.get("title"), "created_at": chosen.get("createdAt")
        },
        "tail": tail, "search": search, "lines": lines
    }))
}

pub(crate) async fn raw_read<K: AsRef<str>, V: AsRef<str>>(
    config: &Config,
    target: &Target,
    procedure: &str,
    params: &[(K, V)],
) -> Result<()> {
    let instance = target.resolve(config)?;
    let query: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_ref(), v.as_ref()))
        .collect();
    let result = DokployClient::new(instance)?
        .get_procedure(procedure, &query)
        .await?;
    print_json(&envelope(instance, redact_raw(result)))
}

/// A raw read as it may be printed. Key-based redaction cannot see into a
/// procedure that answers text (a Traefik file, a command), so that text goes
/// through the log redactor's patterns; there is no service to take literal
/// secrets from.
pub(crate) fn redact_raw(result: Value) -> Value {
    match redact::redact(result) {
        Value::String(text) => Value::String(logs::Redactor::default().text(&text)),
        other => other,
    }
}

/// The container of a Compose whose logs `get logs` reads.
pub(crate) async fn compose_container(
    client: &DokployClient,
    service: &Service,
    detail: &Value,
    wanted: Option<&str>,
) -> Result<logs::Container> {
    let text = |key: &str, fallback: &'static str| {
        detail.get(key).and_then(Value::as_str).unwrap_or(fallback)
    };
    let app_name = detail
        .get("appName")
        .and_then(Value::as_str)
        .unwrap_or(&service.app_name);
    let app_type = match text("composeType", "docker-compose") {
        "stack" => "stack",
        _ => "docker-compose",
    };
    let mut query = vec![("appName", app_name), ("appType", app_type)];
    let server_id = text("serverId", "");
    if !server_id.is_empty() {
        query.push(("serverId", server_id));
    }
    let response = client
        .get_procedure("docker.getContainersByAppNameMatch", &query)
        .await?;
    let containers = logs::containers(&response, app_name);
    Ok(logs::pick_container(&containers, wanted, &service.label())?.clone())
}

/// A `readLogs` answer as redacted lines, filtered by `search` afterwards so
/// the filter never sees a secret.
pub(crate) fn redacted_lines(
    detail: &Value,
    response: &Value,
    search: Option<&str>,
) -> Result<Vec<logs::LogLine>> {
    let text = match response {
        Value::String(text) => text.as_str(),
        Value::Null => "",
        _ => bail!("Dokploy answered the logs with something other than text"),
    };
    Ok(logs::Redactor::for_service(detail)
        .lines(text)
        .into_iter()
        .filter(|line| search.is_none_or(|search| line.contains(search)))
        .collect())
}

pub(crate) async fn resolve_service(client: &DokployClient, query: &str) -> Result<Service> {
    let services = inventory::load(client).await?;
    Ok(inventory::resolve(&services, query)?.clone())
}

pub(crate) async fn resolve_detail(
    client: &DokployClient,
    query: &str,
) -> Result<(Service, Value)> {
    let service = resolve_service(client, query).await?;
    let detail = client
        .get_procedure(
            &format!("{}.one", service.kind.router()),
            &[(service.kind.id_param(), service.id.as_str())],
        )
        .await?;
    Ok((service, detail))
}

pub(crate) async fn compose_by_name(client: &DokployClient, query: &str) -> Result<Service> {
    let service = resolve_service(client, query).await?;
    if service.kind != ServiceKind::Compose {
        refuse!(
            Kind::Refused,
            "{} is a {}, not a Compose",
            service.label(),
            service.kind.label()
        );
    }
    Ok(service)
}

pub(crate) async fn server_name(client: &DokployClient, server_id: &str) -> Value {
    if server_id.is_empty() {
        return Value::Null;
    }
    let servers = client
        .get(ReadOperation::Servers, &[])
        .await
        .unwrap_or(Value::Null);
    let name = servers
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s.get("serverId").and_then(Value::as_str) == Some(server_id))
        .and_then(|s| s.get("name").cloned());
    json!({"server_id": server_id, "name": name})
}

pub(crate) async fn service_summary(
    client: &DokployClient,
    service: &Service,
    detail: &Value,
) -> Value {
    let field = |key: &str| detail.get(key).cloned().unwrap_or(Value::Null);
    let repository = detail
        .get("repository")
        .and_then(Value::as_str)
        .map(|repo| {
            format!(
                "{}/{} @ {}",
                detail
                    .get("owner")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                repo,
                detail.get("branch").and_then(Value::as_str).unwrap_or("?")
            )
        });
    let server_id = detail
        .get("serverId")
        .and_then(Value::as_str)
        .unwrap_or(&service.server_id)
        .to_owned();
    json!({
        "service": service.label(), "project": service.project, "environment": service.environment,
        "kind": service.kind, "name": field("name"), "app_name": field("appName"), "description": field("description"),
        "status": inventory::status_of(detail),
        "build_type": detail.get("buildType").or_else(|| detail.get("composeType")),
        "source_type": field("sourceType"), "image": field("dockerImage"), "repository": repository,
        "compose_path": field("composePath"), "replicas": field("replicas"), "command": field("command"),
        "server": server_name(client, &server_id).await,
        "created_at": field("createdAt"), "id": service.id,
        "env_keys": detail.get("env").and_then(Value::as_str).map(|env| env_keys(env).into_iter().map(|l| l.key).collect::<Vec<_>>()),
        "domains": detail.get("domains").and_then(Value::as_array).map(|d| d.iter().map(|d| json!({"host": d.get("host"), "path": d.get("path"), "port": d.get("port")})).collect::<Vec<_>>()),
        "mounts": detail.get("mounts").and_then(Value::as_array).map(|m| m.iter().map(|m| json!({"type": m.get("type"), "source": m.get("hostPath").or_else(|| m.get("volumeName")), "mount_path": m.get("mountPath")})).collect::<Vec<_>>()),
        "ports": detail.get("ports").and_then(Value::as_array).map(|p| p.iter().map(|p| json!({"published": p.get("publishedPort"), "target": p.get("targetPort"), "protocol": p.get("protocol")})).collect::<Vec<_>>()),
        "database": crate::dokploy::extra::database_view(service, detail),
    })
}

// ----------------------------------------------------------------------- api

/// Read procedures probed with a GET. A GET never runs a mutation in tRPC.
const API_READS: &[&str] = &[
    "project.all",
    "project.one",
    "settings.getDokployVersion",
    "settings.health",
    "server.all",
    "server.one",
    "server.getServices",
    "docker.getContainers",
    "docker.getConfig",
    "docker.getContainersByAppNameMatch",
    "compose.one",
    "compose.allServices",
    "application.one",
    "application.readAppMonitoring",
    "postgres.one",
    "mysql.one",
    "mariadb.one",
    "mongo.one",
    "redis.one",
    "libsql.one",
    "deployment.all",
    "deployment.allByCompose",
    "deployment.allByServer",
    "environment.one",
    "environment.byProjectId",
    "domain.byComposeId",
    "domain.byApplicationId",
    "destination.all",
    "registry.all",
    "sshKey.all",
    "certificates.all",
    "organization.all",
    "user.get",
    "schedule.list",
    "notification.all",
    "gitProvider.getAll",
    "backup.one",
    "mounts.allNamedByApplicationId",
    "application.readLogs",
    "compose.readLogs",
    "postgres.readLogs",
    "mysql.readLogs",
    "mariadb.readLogs",
    "mongo.readLogs",
    "redis.readLogs",
    "libsql.readLogs",
    "deployment.readLogs",
];

pub(crate) async fn api(config: &Config, target: &Target, filter: Option<&str>) -> Result<()> {
    let instance = target.resolve(config)?;
    let client = DokployClient::new(instance)?;
    let mut tasks = JoinSet::new();
    for procedure in API_READS {
        let client = client.clone();
        tasks.spawn(async move { (*procedure, client.probe(procedure).await) });
    }
    let mut reads = Vec::new();
    while let Some(Ok((procedure, status))) = tasks.join_next().await {
        let status = match status {
            Ok(200) => "ok".to_owned(),
            Ok(400) => "ok, needs parameters".to_owned(),
            Ok(405) => "post only".to_owned(),
            Ok(404) => continue,
            Ok(code) => format!("HTTP {code}"),
            Err(error) => format!("error: {error}"),
        };
        reads.push(json!({"procedure": procedure, "status": status}));
    }
    reads.sort_by(|a, b| a["procedure"].as_str().cmp(&b["procedure"].as_str()));
    let mutations = json!([
        {"plan": "deploy | redeploy | start | stop", "procedures": "<router>.deploy|redeploy|start|stop"},
        {"plan": "env-set", "procedures": "<router>.saveEnvironment"},
        {"plan": "compose-create", "procedures": "compose.create + compose.update (sourceType raw)"},
        {"plan": "compose-update | compose-settings", "procedures": "compose.update"},
        {"plan": "postgres-create", "procedures": "postgres.create"},
        {"plan": "mongo-create", "procedures": "mongo.create + mongo.update (memory limit)"},
        {"plan": "backup-create", "procedures": "backup.create"},
        {"plan": "raw-post", "procedures": config.security.raw_post_allowlist},
    ]);
    // Reads with their own command: the raw answer would carry secrets.
    let logs = json!([
        {"get": "logs", "procedures": "<router>.readLogs (+ docker.getContainersByAppNameMatch for a Compose)", "redacted": true},
        {"get": "deploy-log", "procedures": "deployment.readLogs", "redacted": true},
    ]);
    let keep =
        |v: &Value| filter.is_none_or(|f| v.to_string().to_lowercase().contains(&f.to_lowercase()));
    print_json(&envelope(
        instance,
        json!({
            "reads": reads.into_iter().filter(keep).collect::<Vec<_>>(),
            "logs": logs.as_array().unwrap().iter().filter(|v| keep(v)).collect::<Vec<_>>(),
            "mutations": mutations.as_array().unwrap().iter().filter(|v| keep(v)).collect::<Vec<_>>(),
            "destructive": "never available: deletes are run by a person from the Dokploy panel"
        }),
    ))
}

// --------------------------------------------------------------------- plans

pub(crate) async fn create_plan(config: &Config, state: &Path, command: PlanCommand) -> Result<()> {
    use crate::dokploy::extra::{self, Intent, keel_guard};
    let selected_by = plan_target(&command).selection(config)?.selected_by;
    let mut keel_note: Option<String> = None;
    let (instance, action) = match command {
        PlanCommand::ComposeUpdate(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let service = match (args.compose_id, args.service) {
                (Some(id), _) => {
                    resolve_ref(&client, &ServiceRef::Id(required("compose_id", id)?))
                        .await?
                        .0
                }
                (None, Some(query)) => compose_by_name(&client, &query).await?,
                (None, None) => bail!("pass --compose-id or --service"),
            };
            if service.kind != ServiceKind::Compose {
                refuse!(
                    Kind::Refused,
                    "{} is a {}, not a Compose",
                    service.label(),
                    service.kind.label()
                );
            }
            let compose_id = service.id.clone();
            let content = fs::read_to_string(&args.file)
                .with_context(|| format!("cannot read {}", args.file.display()))?;
            validate_compose(&content)?;
            let digest = plan::content_sha256(&content);
            let remote = client
                .get(
                    ReadOperation::Compose,
                    &[("composeId", compose_id.as_str())],
                )
                .await?;
            let remote_compose = remote
                .get("composeFile")
                .and_then(Value::as_str)
                .context("Dokploy response contains no composeFile")?;
            let guard = keel_guard(
                &service,
                Intent::ComposeFile { next: &content },
                args.not_keel_managed,
            )
            .await?;
            keel_note = Some(guard.note);
            let diff = extra::compose_diff(remote_compose, &content);
            (
                instance,
                PlannedAction::ComposeUpdate {
                    compose_id,
                    base_remote_sha256: plan::content_sha256(remote_compose),
                    diff: Some(if diff.is_empty() {
                        "(sin cambios visibles una vez saneado)".into()
                    } else {
                        diff
                    }),
                    warnings: guard.warnings,
                    redeploy: args.redeploy,
                    compose_file: content,
                    content_sha256: digest,
                },
            )
        }
        PlanCommand::PostgresCreate(args) => {
            let instance = args.target.resolve(config)?;
            crate::dokploy::config::validate_env_name(&args.password_env)?;
            (
                instance,
                PlannedAction::PostgresCreate {
                    environment_id: required("environment_id", args.environment_id)?,
                    name: required("name", args.name)?,
                    database_name: required("database_name", args.database_name)?,
                    database_user: required("database_user", args.database_user)?,
                    password_env: args.password_env,
                    docker_image: args.docker_image.filter(|s| !s.trim().is_empty()),
                    server_id: args.server_id.filter(|s| !s.trim().is_empty()),
                },
            )
        }
        PlanCommand::MongoCreate(args) => {
            let instance = args.target.resolve(config)?;
            crate::dokploy::config::validate_env_name(&args.password_env)?;
            if args.memory_limit_bytes == Some(0) {
                bail!("memory_limit_bytes must be greater than zero");
            }
            let client = DokployClient::new(instance)?;
            let environment_id = resolve_environment(&client, &args.environment).await?;
            let server_id = match args.server.as_deref() {
                Some(server) => Some(resolve_server(&client, server).await?),
                None => None,
            };
            (
                instance,
                PlannedAction::MongoCreate {
                    environment_id,
                    server_id,
                    name: required("name", args.name)?,
                    description: args.description.filter(|d| !d.trim().is_empty()),
                    database_user: required("database_user", args.database_user)?,
                    password_env: args.password_env,
                    docker_image: required("docker_image", args.docker_image)?,
                    memory_limit_bytes: args.memory_limit_bytes,
                },
            )
        }
        PlanCommand::BackupCreate(args) => {
            let instance = args.target.resolve(config)?;
            validate_schedule(&args.schedule)?;
            if args.keep_latest_count == 0 {
                bail!("keep_latest_count must be greater than zero");
            }
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &args.service).await?;
            let Some(database_type) = service.kind.backup_database_type() else {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: backup-create only covers Postgres, MySQL, MariaDB and Mongo",
                    service.label(),
                    service.kind.label()
                );
            };
            let (destination_id, destination) =
                resolve_destination(&client, &args.destination).await?;
            let prefix = required("prefix", args.prefix)?;
            let already = detail
                .get("backups")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|b| {
                    b.get("destinationId").and_then(Value::as_str) == Some(destination_id.as_str())
                        && b.get("prefix").and_then(Value::as_str) == Some(prefix.as_str())
                });
            if already {
                refuse!(
                    Kind::Refused,
                    "{} already has a backup to {destination} with prefix {prefix}",
                    service.label()
                );
            }
            (
                instance,
                PlannedAction::BackupCreate {
                    service_kind: service.kind,
                    service_id: service.id.clone(),
                    label: service.label(),
                    database_type: database_type.into(),
                    database: required("database", args.database)?,
                    destination_id,
                    destination,
                    schedule: args.schedule,
                    prefix,
                    keep_latest_count: args.keep_latest_count,
                },
            )
        }
        PlanCommand::List | PlanCommand::Show { .. } | PlanCommand::Prune { .. } => {
            unreachable!("dispatched in run")
        }
        PlanCommand::Deploy(args) => {
            let (instance, action, note) =
                service_action(config, args, ServiceAction::Deploy).await?;
            keel_note = Some(note);
            (instance, action)
        }
        PlanCommand::Redeploy(args) => {
            let (instance, action, note) =
                service_action(config, args, ServiceAction::Redeploy).await?;
            keel_note = Some(note);
            (instance, action)
        }
        PlanCommand::Start(args) => {
            let (instance, action, note) =
                service_action(config, args, ServiceAction::Start).await?;
            keel_note = Some(note);
            (instance, action)
        }
        PlanCommand::Stop(args) => {
            let (instance, action, note) =
                service_action(config, args, ServiceAction::Stop).await?;
            keel_note = Some(note);
            (instance, action)
        }
        PlanCommand::EnvPatch(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &args.service).await?;
            if !service.kind.has_environment() {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: Dokploy keeps no env block for it",
                    service.label(),
                    service.kind.label()
                );
            }
            if args.set.is_empty() && args.set_from_file.is_empty() && args.unset.is_empty() {
                bail!("nothing to change: pass --set, --set-from-file or --unset");
            }
            let mut values = Vec::new();
            let only_one = args.set.len() == 1 && args.set_from_file.is_empty();
            let mut sources = serde_json::Map::new();
            for key in &args.set {
                extra::validate_env_key(key)?;
                let (value, source) = extra::read_set_value(key, only_one)?;
                sources.insert(key.clone(), json!(source));
                values.push((key.clone(), value));
            }
            for spec in &args.set_from_file {
                let (key, value) = extra::read_set_from_file(spec)?;
                if value.is_empty() {
                    refuse!(
                        Kind::Refused,
                        "--set-from-file {key}: the file is empty; to remove the key use --unset {key}"
                    );
                }
                sources.insert(key.clone(), json!("file"));
                values.push((key, value));
            }
            for key in &args.unset {
                extra::validate_env_key(key)?;
            }
            let current = detail
                .get("env")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (env, mut changes) = extra::patch_env(current, &values, &args.unset)?;
            changes["value_sources"] = Value::Object(sources);
            let guard = keel_guard(
                &service,
                Intent::Env {
                    current,
                    next: &env,
                },
                args.not_keel_managed,
            )
            .await?;
            keel_note = Some(guard.note);
            (
                instance,
                PlannedAction::EnvSet {
                    service_kind: service.kind,
                    service_id: service.id.clone(),
                    label: service.label(),
                    env_sha256: plan::content_sha256(&env),
                    keys: env_keys(&env).into_iter().map(|line| line.key).collect(),
                    env,
                    base_env_sha256: plan::content_sha256(current),
                    key_changes: Some(changes),
                    origin: Some("env-patch".into()),
                    redeploy: args.redeploy,
                },
            )
        }
        PlanCommand::EnvRestore(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &args.service).await?;
            let (timestamp, env) = extra::read_env_backup(state, &service.label(), &args.backup)?;
            let current = detail
                .get("env")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if env == current {
                refuse!(
                    Kind::Refused,
                    "{} already has the env of backup {timestamp}",
                    service.label()
                );
            }
            let guard = keel_guard(
                &service,
                Intent::Env {
                    current,
                    next: &env,
                },
                args.not_keel_managed,
            )
            .await?;
            keel_note = Some(guard.note);
            (
                instance,
                PlannedAction::EnvSet {
                    service_kind: service.kind,
                    service_id: service.id.clone(),
                    label: service.label(),
                    env_sha256: plan::content_sha256(&env),
                    keys: env_keys(&env).into_iter().map(|line| line.key).collect(),
                    key_changes: Some(extra::diff_env_keys(current, &env)),
                    env,
                    base_env_sha256: plan::content_sha256(current),
                    origin: Some(format!("env-restore {timestamp}")),
                    redeploy: args.redeploy,
                },
            )
        }
        PlanCommand::MountCreate(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &args.service).await?;
            if !args.mount_path.starts_with('/') {
                bail!("--mount-path must be an absolute path inside the container");
            }
            let already = detail
                .get("mounts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .any(|m| {
                    m.get("mountPath").and_then(Value::as_str) == Some(args.mount_path.as_str())
                });
            if already {
                refuse!(
                    Kind::Refused,
                    "{} already has a mount at {}",
                    service.label(),
                    args.mount_path
                );
            }
            let (mount_type, host_path, volume_name, file_content) = match args.mount_type {
                MountType::Volume => {
                    let name = args
                        .volume_name
                        .context("--type volume needs --volume-name")?;
                    ("volume", None, Some(required("volume_name", name)?), None)
                }
                MountType::Bind => {
                    let host = args.host_path.context("--type bind needs --host-path")?;
                    if !host.starts_with('/') {
                        bail!("--host-path must be absolute");
                    }
                    ("bind", Some(host), None, None)
                }
                MountType::File => {
                    let file = args.file.context("--type file needs --file")?;
                    let content = fs::read_to_string(&file)
                        .with_context(|| format!("cannot read {}", file.display()))?;
                    ("file", None, None, Some(content))
                }
            };
            keel_note = Some(keel_guard(&service, Intent::Other, true).await?.note);
            (
                instance,
                PlannedAction::MountCreate {
                    service_kind: service.kind,
                    service_id: service.id.clone(),
                    label: service.label(),
                    mount_type: mount_type.into(),
                    mount_path: args.mount_path,
                    host_path,
                    volume_name,
                    file_content,
                    redeploy: args.redeploy,
                },
            )
        }
        PlanCommand::EnvSet(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let (service, detail) = resolve_detail(&client, &args.service).await?;
            if !service.kind.has_environment() {
                refuse!(
                    Kind::Refused,
                    "{} is a {}: Dokploy keeps no env block for it",
                    service.label(),
                    service.kind.label()
                );
            }
            let env = fs::read_to_string(&args.file)
                .with_context(|| format!("cannot read {}", args.file.display()))?;
            let keys = env_keys(&env)
                .into_iter()
                .map(|line| line.key)
                .collect::<Vec<_>>();
            if keys.is_empty() {
                refuse!(
                    Kind::Refused,
                    "{} has no KEY=value lines; refusing to wipe every variable",
                    args.file.display()
                );
            }
            let current = detail
                .get("env")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let guard = keel_guard(
                &service,
                Intent::Env {
                    current,
                    next: &env,
                },
                args.not_keel_managed,
            )
            .await?;
            keel_note = Some(guard.note);
            (
                instance,
                PlannedAction::EnvSet {
                    service_kind: service.kind,
                    service_id: service.id.clone(),
                    label: service.label(),
                    env_sha256: plan::content_sha256(&env),
                    key_changes: Some(extra::diff_env_keys(current, &env)),
                    env,
                    keys,
                    base_env_sha256: plan::content_sha256(current),
                    origin: Some("env-set".into()),
                    redeploy: args.redeploy,
                },
            )
        }
        PlanCommand::ComposeCreate(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            let content = fs::read_to_string(&args.file)
                .with_context(|| format!("cannot read {}", args.file.display()))?;
            validate_compose(&content)?;
            let environment_id = resolve_environment(&client, &args.environment).await?;
            let server_id = match args.server.as_deref() {
                Some(server) => Some(resolve_server(&client, server).await?),
                None => None,
            };
            (
                instance,
                PlannedAction::ComposeCreate {
                    environment_id,
                    server_id,
                    name: required("name", args.name)?,
                    description: args.description.filter(|d| !d.trim().is_empty()),
                    content_sha256: plan::content_sha256(&content),
                    compose_file: content,
                },
            )
        }
        PlanCommand::ComposeSettings(args) => {
            let instance = args.target.resolve(config)?;
            let client = DokployClient::new(instance)?;
            if args.source_type.is_none() && args.name.is_none() && args.description.is_none() {
                bail!("nothing to change: pass --source-type, --name or --description");
            }
            let service = compose_by_name(&client, &args.service).await?;
            (
                instance,
                PlannedAction::ComposeSettings {
                    compose_id: service.id.clone(),
                    label: service.label(),
                    source_type: args.source_type.map(|s| s.as_str().to_owned()),
                    name: args.name,
                    description: args.description,
                },
            )
        }
        PlanCommand::RawPost(args) => {
            let instance = args.target.resolve(config)?;
            validate_procedure(&args.procedure)?;
            if is_destructive(&args.procedure) {
                refuse!(
                    Kind::Refused,
                    "{} is destructive: deletes are run by a person from the Dokploy panel",
                    args.procedure
                );
            }
            if !config.security.raw_post_allowlist.contains(&args.procedure) {
                refuse!(
                    Kind::Refused,
                    "{} is not in security.raw_post_allowlist; add it there after reviewing its schema, or use a typed plan",
                    args.procedure
                );
            }
            let body: Value = serde_json::from_str(
                &fs::read_to_string(&args.body_file)
                    .with_context(|| format!("cannot read {}", args.body_file.display()))?,
            )
            .context("--body-file must contain JSON")?;
            if !body.is_object() {
                bail!("--body-file must contain a JSON object");
            }
            (
                instance,
                PlannedAction::RawPost {
                    procedure: args.procedure,
                    body,
                },
            )
        }
    };
    let plan = Plan::new(
        instance.organization.clone(),
        instance.name.clone(),
        action,
        config.security.plan_ttl_seconds,
    )?;
    plan::save(state, &plan)?;
    let mut output = plan.safe_output();
    // Which Dokploy this plan changes, and why: the operator approves this too.
    output["target"] = json!({
        "instance": instance.label(), "base_url": instance.base_url, "selected_by": selected_by
    });
    if let Some(note) = keel_note {
        output["keel"] = json!(note);
    }
    if instance.approval(&config.security) == ApprovalMode::Terminal {
        output["approval"] = json!(format!(
            "terminal: a person must run `keel apply --plan {} --approve <token>` in an interactive terminal and retype {}",
            plan.id,
            approval::short_id(&plan)
        ));
    }
    print_json(&output)
}

/// A pending plan as a harness needs it after losing its conversation:
/// what it does, where, until when, and the token to apply it.
pub(crate) fn plan_view(config: &Config, plan: &Plan) -> Value {
    let mut view = plan.safe_output();
    let expired = plan.expires_at <= chrono::Utc::now();
    view["status"] = json!(if expired { "expired" } else { "pending" });
    view["created_at"] = json!(plan.created_at);
    if let Ok(instance) = config.instance(&plan.organization, &plan.instance) {
        view["target"] = json!({"instance": instance.label(), "base_url": instance.base_url});
        if instance.approval(&config.security) == ApprovalMode::Terminal {
            view["approval"] = json!(format!(
                "terminal: a person must apply it from an interactive terminal and retype {}",
                approval::short_id(plan)
            ));
        }
    }
    if expired {
        view["next_step"] = json!("expired: create and review a new plan");
    }
    view
}

pub(crate) fn pending_plans(state: &Path) -> Result<Vec<Plan>> {
    let directory = state.join("plans");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut plans = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let path = entry?.path();
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".json"))
            .filter(|n| !n.starts_with('.'))
        else {
            continue;
        };
        plans.push(plan::load(state, id)?);
    }
    plans.sort_by_key(|p| p.created_at);
    Ok(plans)
}

pub(crate) fn list_plans(config: &Config, state: &Path) -> Result<()> {
    let plans: Vec<Value> = pending_plans(state)?
        .iter()
        .map(|plan| {
            let view = plan_view(config, plan);
            json!({
                "plan_id": plan.id, "status": view["status"], "operation": view["operation"],
                "target": view.get("target"), "changes": view["changes"],
                "created_at": plan.created_at, "expires_at": plan.expires_at
            })
        })
        .collect();
    print_json(&json!({"plans": plans}))
}

pub(crate) fn show_plan(config: &Config, state: &Path, id: &str) -> Result<()> {
    let plan = plan::load(state, id)?;
    plan.verify().or_else(|error| {
        // An expired plan is still shown, marked as such; a tampered one is not.
        if plan.expires_at <= chrono::Utc::now() {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    print_json(&plan_view(config, &plan))
}

pub(crate) fn plan_target(command: &PlanCommand) -> &Target {
    match command {
        PlanCommand::List | PlanCommand::Show { .. } | PlanCommand::Prune { .. } => {
            unreachable!("plan list/show/prune are dispatched before create_plan")
        }
        PlanCommand::EnvPatch(a) => &a.target,
        PlanCommand::EnvRestore(a) => &a.target,
        PlanCommand::MountCreate(a) => &a.target,
        PlanCommand::ComposeUpdate(a) => &a.target,
        PlanCommand::PostgresCreate(a) => &a.target,
        PlanCommand::MongoCreate(a) => &a.target,
        PlanCommand::BackupCreate(a) => &a.target,
        PlanCommand::Deploy(a)
        | PlanCommand::Redeploy(a)
        | PlanCommand::Start(a)
        | PlanCommand::Stop(a) => &a.target,
        PlanCommand::EnvSet(a) => &a.target,
        PlanCommand::ComposeCreate(a) => &a.target,
        PlanCommand::ComposeSettings(a) => &a.target,
        PlanCommand::RawPost(a) => &a.target,
    }
}

pub(crate) async fn service_action(
    config: &Config,
    args: ServiceArgs,
    action: ServiceAction,
) -> Result<(&InstanceConfig, PlannedAction, String)> {
    let instance = args.target.resolve(config)?;
    let client = DokployClient::new(instance)?;
    let service = resolve_service(&client, &args.service).await?;
    if !service.kind.supports(action) {
        refuse!(
            Kind::Refused,
            "{} is a {}: Dokploy has no {} for it",
            service.label(),
            service.kind.label(),
            action.name()
        );
    }
    let intent = match action {
        ServiceAction::Deploy | ServiceAction::Redeploy => crate::dokploy::extra::Intent::Deploy,
        ServiceAction::Start | ServiceAction::Stop => crate::dokploy::extra::Intent::Other,
    };
    let guard = crate::dokploy::extra::keel_guard(&service, intent, args.not_keel_managed).await?;
    Ok((
        instance,
        PlannedAction::ServiceAction {
            service_kind: service.kind,
            service_id: service.id.clone(),
            label: service.label(),
            action,
        },
        guard.note,
    ))
}

/// An environment id, or the id of `project/environment`.
pub(crate) async fn resolve_environment(client: &DokployClient, query: &str) -> Result<String> {
    let projects = client.get(ReadOperation::Projects, &[]).await?;
    let mut matches = Vec::new();
    for project in projects.as_array().into_iter().flatten() {
        let project_name = project
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        for environment in project
            .get("environments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = environment
                .get("environmentId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = environment
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if id == query || format!("{project_name}/{name}").eq_ignore_ascii_case(query) {
                matches.push(id.to_owned());
            }
        }
    }
    match matches.as_slice() {
        [only] => Ok(only.clone()),
        [] => refuse!(
            Kind::ServiceNotFound,
            "no environment matches {query:?}; use an id or project/environment (see `get projects`)"
        ),
        _ => refuse!(
            Kind::ServiceAmbiguous,
            "{query:?} matches several environments; use the environment id"
        ),
    }
}

/// A server id, or the id of the server with that name.
pub(crate) async fn resolve_server(client: &DokployClient, query: &str) -> Result<String> {
    let servers = client.get(ReadOperation::Servers, &[]).await?;
    let matches: Vec<String> = servers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| {
            s.get("serverId").and_then(Value::as_str) == Some(query)
                || s.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(query))
        })
        .filter_map(|s| s.get("serverId").and_then(Value::as_str).map(str::to_owned))
        .collect();
    match matches.as_slice() {
        [only] => Ok(only.clone()),
        [] => refuse!(
            Kind::ServiceNotFound,
            "no server matches {query:?}; see `get servers`"
        ),
        _ => refuse!(
            Kind::ServiceAmbiguous,
            "{query:?} matches several servers; use the server id"
        ),
    }
}

/// A backup destination by id or name, as (id, name).
pub(crate) async fn resolve_destination(
    client: &DokployClient,
    query: &str,
) -> Result<(String, String)> {
    let destinations = client.get_procedure("destination.all", &[]).await?;
    let matches: Vec<(String, String)> = destinations
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| {
            d.get("destinationId").and_then(Value::as_str) == Some(query)
                || d.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.eq_ignore_ascii_case(query))
        })
        .filter_map(|d| {
            let id = d.get("destinationId").and_then(Value::as_str)?;
            let name = d.get("name").and_then(Value::as_str).unwrap_or_default();
            Some((id.to_owned(), name.to_owned()))
        })
        .collect();
    match matches.as_slice() {
        [only] => Ok(only.clone()),
        [] => refuse!(
            Kind::ServiceNotFound,
            "no backup destination matches {query:?}; see `keel get destinations`"
        ),
        _ => refuse!(
            Kind::ServiceAmbiguous,
            "{query:?} matches several backup destinations; use the destination id"
        ),
    }
}

/// Dokploy stores the schedule as it comes: a typo would only show as a backup
/// that never runs.
pub(crate) fn validate_schedule(schedule: &str) -> Result<()> {
    let valid_field = |field: &str| {
        field
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'*' | b'/' | b',' | b'-'))
    };
    let fields: Vec<&str> = schedule.split_whitespace().collect();
    if fields.len() != 5 || !fields.iter().all(|field| valid_field(field)) {
        bail!("schedule must be a cron expression with five fields, got {schedule:?}");
    }
    Ok(())
}

// --------------------------------------------------------------------- apply

pub(crate) async fn apply(config: &Config, state: &Path, args: ApplyArgs) -> Result<()> {
    // Everything that can refuse happens before the plan is claimed, so a
    // refusal leaves it runnable; once claimed it can never run twice.
    let reviewed = plan::load(state, &args.plan)?;
    reviewed.verify()?;
    if args.approve != reviewed.digest {
        refuse!(
            Kind::ApprovalMismatch,
            "approval token does not match the reviewed plan"
        );
    }
    let instance = config.instance(&reviewed.organization, &reviewed.instance)?;
    if instance.approval(&config.security) == ApprovalMode::Terminal {
        approval::confirm_in_terminal(&reviewed)?;
    }
    let plan = plan::claim(state, &args.plan)?;
    if plan.digest != reviewed.digest {
        refuse!(
            Kind::PlanUnavailable,
            "plan changed between review and claim"
        );
    }
    let client = DokployClient::new(instance)?;
    match execute(&client, state, &plan).await {
        Ok(mut output) => {
            plan::audit_success(state, &plan)?;
            output["target"] = json!({"instance": instance.label(), "base_url": instance.base_url});
            print_json(&output)
        }
        Err(error) => {
            plan::audit_failure(state, &plan, &error.to_string())?;
            Err(error)
        }
    }
}

pub(crate) async fn execute(client: &DokployClient, state: &Path, plan: &Plan) -> Result<Value> {
    let mut extra = serde_json::Map::new();
    match &plan.action {
        PlannedAction::ComposeUpdate {
            compose_id,
            base_remote_sha256,
            ..
        } => {
            let remote = client
                .get(
                    ReadOperation::Compose,
                    &[("composeId", compose_id.as_str())],
                )
                .await?;
            let remote_compose = remote
                .get("composeFile")
                .and_then(Value::as_str)
                .context("Dokploy response contains no composeFile")?;
            if plan::content_sha256(remote_compose) != *base_remote_sha256 {
                refuse!(
                    Kind::Drift,
                    "remote Compose changed since this plan was created; download, review, and create a new plan"
                );
            }
        }
        PlannedAction::EnvSet {
            service_kind,
            service_id,
            label,
            base_env_sha256,
            ..
        } => {
            let detail = client
                .get_procedure(
                    &format!("{}.one", service_kind.router()),
                    &[(service_kind.id_param(), service_id.as_str())],
                )
                .await?;
            let current = detail
                .get("env")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if plan::content_sha256(current) != *base_env_sha256 {
                refuse!(
                    Kind::Drift,
                    "the env of {label} changed since this plan was created; create a new plan"
                );
            }
            let backup = backup_env(state, label, current)?;
            extra.insert("previous_env_backup".into(), json!(backup));
            extra.insert(
                "next_step".into(),
                json!("the new env applies on the next deploy"),
            );
        }
        PlannedAction::ComposeCreate { .. } => {
            let created = client
                .post(plan.action.endpoint(), plan::request_body(plan)?)
                .await?;
            let compose_id = created.get("composeId").and_then(Value::as_str).context(
                "compose.create answered without a composeId; check the panel before retrying",
            )?;
            // Dokploy creates a Compose with a git source; a raw one needs this second call.
            let settings = client
                .post_procedure("compose.update", json!({"composeId": compose_id, "sourceType": "raw"}))
                .await
                .with_context(|| format!("Compose {compose_id} was created but setting sourceType raw failed; fix it with plan compose-settings"))?;
            return Ok(json!({
                "ok": true, "plan_id": plan.id, "operation": plan.action.operation_name(),
                "compose_id": compose_id, "source_type": settings.get("sourceType"),
                "next_step": "deploy it with plan deploy"
            }));
        }
        PlannedAction::MongoCreate {
            memory_limit_bytes, ..
        } => {
            let created = client
                .post(plan.action.endpoint(), plan::request_body(plan)?)
                .await?;
            let mongo_id = created.get("mongoId").and_then(Value::as_str).context(
                "mongo.create answered without a mongoId; check the panel before retrying",
            )?;
            if let Some(limit) = memory_limit_bytes {
                // The limit is a string in Dokploy's schema.
                client
                    .post_procedure(
                        "mongo.update",
                        json!({"mongoId": mongo_id, "memoryLimit": limit.to_string()}),
                    )
                    .await
                    .with_context(|| {
                        format!("Mongo {mongo_id} was created but setting its memory limit failed; it has no limit yet")
                    })?;
            }
            return Ok(json!({
                "ok": true, "plan_id": plan.id, "operation": plan.action.operation_name(),
                "mongo_id": mongo_id, "app_name": created.get("appName"),
                "memory_limit_bytes": memory_limit_bytes,
                "next_step": "deploy it with plan deploy"
            }));
        }
        _ => {}
    }
    let response = client
        .post(plan.action.endpoint(), plan::request_body(plan)?)
        .await?;
    let mut output = json!({"ok": true, "plan_id": plan.id, "operation": plan.action.operation_name(), "response": redact::redact(response)});
    for (key, value) in extra {
        output[key] = value;
    }
    if let Some((kind, id)) = plan.action.redeploy_after() {
        let action = kind.redeploy_action();
        match client
            .post(
                crate::dokploy::client::WriteEndpoint::Action(kind, action),
                json!({ kind.id_param(): id }),
            )
            .await
        {
            Ok(redeploy) => {
                output["redeploy"] =
                    json!({"ok": true, "action": action, "response": redact::redact(redeploy)});
                output["next_step"] =
                    json!("follow it with `keel get deploy-log` or `keel get logs -f`");
            }
            Err(error) => {
                // The change is saved, as in Dokploy; say how to undo it.
                return Err(error.context(format!(
                    "the change was saved but the {} failed; redeploy with `keel plan {} <service>`{}",
                    action.name(),
                    action.name(),
                    match output.get("previous_env_backup") {
                        Some(_) => ", or undo it with `keel plan env-restore <service> --backup <backup>`",
                        None => "",
                    }
                )));
            }
        }
    }
    Ok(output)
}

/// Saves the env a plan is about to replace, owner-only, under the state dir.
pub(crate) fn backup_env(state: &Path, label: &str, env: &str) -> Result<PathBuf> {
    let directory = state.join("backups");
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let name: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = directory.join(format!(
        "{name}-{}.env",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
    ));
    write_private(&path, env.as_bytes())?;
    Ok(path)
}

// -------------------------------------------------------------------- backup

pub(crate) async fn backup_compose(config: &Config, args: BackupComposeArgs) -> Result<()> {
    let backup = config
        .compose_backup
        .as_ref()
        .context("compose_backup is not configured")?;
    if !backup.repository_path.join(".git").is_dir() {
        bail!("compose_backup.repository_path must be an existing Git checkout");
    }
    if let Some(expected_url) = &backup.repository_url {
        if git_output(&backup.repository_path, &["remote", "get-url", "origin"])? != *expected_url {
            bail!("backup repository origin does not match compose_backup.repository_url");
        }
    }
    if git_output(&backup.repository_path, &["branch", "--show-current"])? != backup.branch {
        bail!(
            "backup repository is not on configured branch {:?}",
            backup.branch
        );
    }
    let instance = args.target.resolve(config)?;
    let result = DokployClient::new(instance)?
        .get(
            ReadOperation::Compose,
            &[("composeId", args.compose_id.as_str())],
        )
        .await?;
    let content = result
        .get("composeFile")
        .and_then(|v| v.as_str())
        .context("Dokploy response contains no composeFile")?;
    validate_compose(content)?;
    let directory = backup
        .repository_path
        .join("dokploy")
        .join(safe_segment(&instance.organization)?)
        .join(safe_segment(&instance.name)?)
        .join(safe_segment(&args.compose_id)?);
    fs::create_dir_all(&directory)?;
    let file = directory.join(format!("{}.yaml", safe_segment(&args.version)?));
    if file.exists() {
        bail!("snapshot already exists: {}", file.display());
    }
    write_private(&file, content.as_bytes())?;
    if args.commit {
        git(
            &backup.repository_path,
            &[
                "add",
                "--",
                file.strip_prefix(&backup.repository_path)?
                    .to_str()
                    .context("non-UTF8 path")?,
            ],
        )?;
        git(
            &backup.repository_path,
            &[
                "commit",
                "-m",
                &format!(
                    "backup({}): {} {}",
                    instance.organization, args.compose_id, args.version
                ),
            ],
        )?;
    }
    print_json(
        &json!({"ok": true, "snapshot": file, "sha256": plan::content_sha256(content), "committed": args.commit, "branch": backup.branch, "pushed": false}),
    )
}

pub(crate) fn git(dir: &Path, arguments: &[&str]) -> Result<()> {
    let status = Command::new("git")
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(arguments)
        .status()
        .context("cannot invoke git")?;
    if !status.success() {
        bail!("git command failed");
    }
    Ok(())
}
pub(crate) fn git_output(dir: &Path, arguments: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(arguments)
        .output()
        .context("cannot invoke git")?;
    if !output.status.success() {
        bail!("git command failed");
    }
    Ok(String::from_utf8(output.stdout)
        .context("git emitted non-UTF8 output")?
        .trim()
        .to_owned())
}

// ------------------------------------------------------------------- helpers

pub(crate) fn ensure_new_absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("--write-to must be an absolute path");
    }
    if path.exists() {
        bail!("refusing to overwrite existing file: {}", path.display());
    }
    Ok(())
}
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub(crate) fn validate_compose(content: &str) -> Result<()> {
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(content).context("Compose YAML is invalid")?;
    if yaml.get("services").is_none() {
        bail!("Compose YAML must contain a top-level services mapping");
    }
    Ok(())
}
pub(crate) fn required(name: &str, value: String) -> Result<String> {
    if value.trim().is_empty() {
        bail!("{name} cannot be empty")
    } else {
        Ok(value)
    }
}
pub(crate) fn safe_segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        bail!("backup path values must contain only letters, numbers, dot, underscore, or hyphen")
    }
    Ok(value)
}

pub(crate) fn compose_output(
    response: Value,
    show_compose: bool,
    downloaded_to: Option<&Path>,
) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "composeId",
        "name",
        "appName",
        "description",
        "serverId",
        "environmentId",
        "sourceType",
        "composeType",
        "composeStatus",
        "createdAt",
        "updatedAt",
    ] {
        if let Some(value) = response.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    if show_compose {
        let view = response
            .get("composeFile")
            .and_then(Value::as_str)
            .map(safe_compose_view)
            .unwrap_or_else(|| Value::String("[REDACTED: Compose unavailable]".into()));
        output.insert("compose".into(), view);
    } else {
        output.insert(
            "compose".into(),
            Value::String("[REDACTED: pass --show-compose for a sanitized service view]".into()),
        );
    }
    if let Some(path) = downloaded_to {
        output.insert(
            "downloaded_to".into(),
            Value::String(path.display().to_string()),
        );
        if let Some(content) = response.get("composeFile").and_then(Value::as_str) {
            output.insert(
                "compose_sha256".into(),
                Value::String(plan::content_sha256(content)),
            );
        }
    }
    Value::Object(output)
}

pub(crate) fn export_compose(response: &Value, path: &Path) -> Result<PathBuf> {
    ensure_new_absolute(path)?;
    let content = response
        .get("composeFile")
        .and_then(Value::as_str)
        .context("Dokploy response contains no composeFile")?;
    validate_compose(content)?;
    write_private(path, content.as_bytes())?;
    Ok(path.to_path_buf())
}

/// Services of a Compose with only non-secret fields. Labels are included:
/// they carry Traefik routing (hosts, ports), which is what operators check.
pub(crate) fn safe_compose_view(content: &str) -> Value {
    let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return Value::String("[REDACTED: Compose could not be safely parsed]".into());
    };
    let Some(services) = yaml.get("services").and_then(serde_yaml::Value::as_mapping) else {
        return Value::String("[REDACTED: Compose has no services mapping]".into());
    };
    let mut output = serde_json::Map::new();
    for (name, service) in services {
        let mut details = serde_json::Map::new();
        if let Some(mapping) = service.as_mapping() {
            for field in [
                "image",
                "ports",
                "volumes",
                "networks",
                "restart",
                "depends_on",
                "deploy",
                "labels",
                "healthcheck",
            ] {
                if let Some(value) = mapping.get(serde_yaml::Value::String(field.into())) {
                    if let Ok(json) = serde_json::to_value(value) {
                        let json = if field == "labels" {
                            redact::redact_labels(json)
                        } else {
                            redact::redact(json)
                        };
                        details.insert(field.into(), json);
                    }
                }
            }
            if mapping.contains_key(serde_yaml::Value::String("environment".into()))
                || mapping.contains_key(serde_yaml::Value::String("env_file".into()))
            {
                details.insert("environment".into(), Value::String(redact::REDACTED.into()));
            }
        }
        output.insert(
            name.as_str().unwrap_or("unnamed").into(),
            Value::Object(details),
        );
    }
    json!({"services": output})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(args: &[&str]) -> GetCommand {
        use clap::Parser;
        let cli = crate::cli::Cli::try_parse_from([&["keel", "get"], args].concat()).unwrap();
        match cli.command {
            crate::cli::Command::Get { command } => command,
            _ => unreachable!(),
        }
    }

    #[test]
    fn backup_schedules_need_five_cron_fields() {
        for ok in ["30 3 * * *", "*/15 0-6 * * 1,3"] {
            assert!(validate_schedule(ok).is_ok(), "{ok}");
        }
        for bad in ["", "30 3 * *", "30 3 * * * *", "@daily", "30 3 * * ; rm"] {
            assert!(validate_schedule(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn logs_arguments_have_bounded_defaults() {
        let GetCommand::Logs {
            query,
            container,
            tail,
            since,
            search,
            ..
        } = get(&["logs", "Platform/development/[API] Core"])
        else {
            panic!("not get logs");
        };
        assert_eq!(query, "Platform/development/[API] Core");
        assert_eq!(
            (container, tail, since.as_str(), search),
            (None, 200, "all", None)
        );

        let GetCommand::Logs {
            container,
            tail,
            since,
            search,
            ..
        } = get(&[
            "logs",
            "core",
            "--container",
            "web",
            "--tail",
            "100",
            "--since",
            "10m",
            "--search",
            "connection already closed",
        ])
        else {
            panic!("not get logs");
        };
        assert_eq!(container.as_deref(), Some("web"));
        assert_eq!((tail, since.as_str()), (100, "10m"));
        assert_eq!(search.as_deref(), Some("connection already closed"));
    }

    #[test]
    fn raw_text_answers_are_redacted_too() {
        assert_eq!(
            redact_raw(json!(
                "ok\nAuthorization: Bearer abcdefgh12345678\nurl: redis://:pw-1234@cache:6379\n"
            )),
            json!("ok\nAuthorization: [REDACTED]\nurl: redis://:[REDACTED]@cache:6379\n")
        );
        // JSON answers keep key-based redaction; their other strings are untouched.
        assert_eq!(
            redact_raw(json!({"name": "password=visible-by-key-rules", "env": "A=1"})),
            json!({"name": "password=visible-by-key-rules", "env": "[REDACTED]"})
        );
    }

    #[test]
    fn deploy_log_takes_an_optional_deployment() {
        let GetCommand::DeployLog {
            deployment, tail, ..
        } = get(&[
            "deploy-log",
            "core",
            "--deployment",
            "zOU80is0",
            "--tail",
            "50",
        ])
        else {
            panic!("not get deploy-log");
        };
        assert_eq!((deployment.as_deref(), tail), (Some("zOU80is0"), 50));
        use clap::Parser;
        assert!(
            crate::cli::Cli::try_parse_from(["keel", "get", "logs", "core", "--tail", "-1"])
                .is_err()
        );
    }
}
