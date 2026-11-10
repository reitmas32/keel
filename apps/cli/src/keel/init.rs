//! `keel init`: links the repo to keel and leaves it ready for releases, in
//! idempotent steps (each prints ✔ done, • already there or ▲ warning):
//!
//! 1. repo and org; 2. `gh` with a session (before creating anything: the CI
//!    token is shown only once and `gh` is where it goes);
//! 3. the app in keel (created, or its token rotated with `--rotate-token`),
//!    and the `DEPLOY_API_TOKEN` secret right away, through gh's stdin;
//! 4. scopes (`--scope alias=<id|url>`, or picked at a terminal);
//! 5. the `KEEL_API_URL` variable; 6. the workflow (and `--pr`);
//! 7. final checks and the same audit as `--check`.

use crate::dokploy::print_json;
use crate::failure::{Failure, Kind, fail, fail_with};
use crate::keel::api::{
    CiToken, DokployService, KeelApi, LINK_UNSUPPORTED, http_status, is_unsupported,
};
use crate::keel::commands::{Ctx, need_terminal, resolve_repo};
use crate::keel::github::{self, Gh, GhState, PrOutcome, SECRET, SystemGh, VARIABLE};
use crate::keel::{config, git};
use crate::ui;
use anyhow::Result;
use regex::Regex;
use serde_json::{Value, json};
use std::net::IpAddr;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

/// The workflow every repo deployed with keel runs on its version tags.
pub const WORKFLOW: &str = include_str!("../../../../templates/github/keel-release.yml");
pub const WORKFLOW_PATH: &str = ".github/workflows/keel-release.yml";

pub use github::gh_names;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Missing,
    Same,
    Customized,
}

pub fn workflow_state(root: &Path) -> FileState {
    match std::fs::read_to_string(root.join(WORKFLOW_PATH)) {
        Err(_) => FileState::Missing,
        Ok(content) if content == WORKFLOW => FileState::Same,
        Ok(_) => FileState::Customized,
    }
}

/// Where apps are created in keel's admin: same origin as the API, `/apps`.
pub fn admin_url(api_url: &str) -> String {
    url::Url::parse(api_url)
        .map(|u| format!("{}/apps", u.origin().ascii_serialization()))
        .unwrap_or_else(|_| api_url.to_owned())
}

// ------------------------------------------------------------------ the flags

static ALIAS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$").unwrap());
static ENV_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());

/// What a `--scope` points to in Dokploy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeTarget {
    /// An application or compose id; keel's `/dokploy/services` says its kind.
    Id(String),
    /// The service's URL in the Dokploy dashboard.
    Url(String),
}

/// `--scope prod=<dokploy-id|dokploy-url>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeArg {
    pub alias: String,
    pub target: ScopeTarget,
}

fn valid_alias(alias: &str) -> Result<(), String> {
    if ALIAS.is_match(alias) {
        Ok(())
    } else {
        Err(format!(
            "alias inválido «{alias}»: usa letras, números, «-», «_» o «.» (p. ej. prod, stg)"
        ))
    }
}

pub fn parse_scope_arg(input: &str) -> Result<ScopeArg, String> {
    let (alias, target) = input
        .split_once('=')
        .ok_or_else(|| format!("usa alias=<id-de-dokploy|url-de-dokploy>, no «{input}»"))?;
    let (alias, target) = (alias.trim(), target.trim());
    valid_alias(alias)?;
    if target.is_empty() {
        return Err(format!(
            "falta el id o la URL de Dokploy después de «{alias}=»"
        ));
    }
    let lower = target.to_ascii_lowercase();
    let target = if lower.starts_with("http://") || lower.starts_with("https://") {
        url::Url::parse(target).map_err(|_| format!("URL de Dokploy inválida: {target}"))?;
        ScopeTarget::Url(target.trim_end_matches('/').to_owned())
    } else if target.chars().any(|c| c.is_whitespace() || c == '/') {
        return Err(format!("«{target}» no parece un id ni una URL de Dokploy"));
    } else {
        ScopeTarget::Id(target.to_owned())
    };
    Ok(ScopeArg {
        alias: alias.to_owned(),
        target,
    })
}

/// `--tag-variable prod=IMAGE_TAG`, for composes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagVariableArg {
    pub alias: String,
    pub variable: String,
}

pub fn parse_tag_variable(input: &str) -> Result<TagVariableArg, String> {
    let (alias, variable) = input
        .split_once('=')
        .ok_or_else(|| format!("usa alias=VARIABLE, no «{input}»"))?;
    let (alias, variable) = (alias.trim(), variable.trim());
    valid_alias(alias)?;
    if !ENV_NAME.is_match(variable) {
        return Err(format!("nombre de variable inválido: «{variable}»"));
    }
    Ok(TagVariableArg {
        alias: alias.to_owned(),
        variable: variable.to_owned(),
    })
}

/// Every `--tag-variable` names a `--scope`, at most once.
pub fn check_tag_variables(scopes: &[ScopeArg], tags: &[TagVariableArg]) -> Result<()> {
    for (i, tag) in tags.iter().enumerate() {
        if !scopes.iter().any(|s| s.alias == tag.alias) {
            return Err(fail(
                Kind::Error,
                format!(
                    "--tag-variable {}={} no corresponde a ningún --scope {}=….",
                    tag.alias, tag.variable, tag.alias
                ),
            ));
        }
        if tags[..i].iter().any(|t| t.alias == tag.alias) {
            return Err(fail(
                Kind::Error,
                format!("--tag-variable repite el alias {}.", tag.alias),
            ));
        }
    }
    for (i, scope) in scopes.iter().enumerate() {
        if scopes[..i].iter().any(|s| s.alias == scope.alias) {
            return Err(fail(
                Kind::Error,
                format!("--scope repite el alias {}.", scope.alias),
            ));
        }
    }
    Ok(())
}

/// The body of `POST /repos/<repo>/scopes` for a `--scope`. An id (or a URL
/// keel knows) goes as `{alias, kind, dokployId, tagVariable?}`; any other URL
/// as `{alias, dokployUrl}` for the server to resolve.
pub fn scope_body(
    arg: &ScopeArg,
    tag_variable: Option<&str>,
    services: &[DokployService],
) -> Result<Value> {
    let service = match &arg.target {
        ScopeTarget::Id(id) => Some(services.iter().find(|s| &s.id == id).ok_or_else(|| {
            fail(
                Kind::ServiceNotFound,
                format!(
                    "No hay ninguna aplicación ni compose de Dokploy con id {id} (--scope {}). Revisa el id en el panel de Dokploy o pasa su URL.",
                    arg.alias
                ),
            )
        })?),
        ScopeTarget::Url(url) => services.iter().find(|s| {
            s.dashboard_url
                .as_deref()
                .is_some_and(|d| d.trim_end_matches('/') == url)
        }),
    };
    let Some(service) = service else {
        if tag_variable.is_some() {
            return Err(fail(
                Kind::Error,
                format!(
                    "--tag-variable {} necesita el id del compose en --scope (la URL no dice si es un compose).",
                    arg.alias
                ),
            ));
        }
        let ScopeTarget::Url(url) = &arg.target else {
            unreachable!("an id always resolves to a service or fails")
        };
        return Ok(json!({"alias": arg.alias, "dokployUrl": url}));
    };
    if let Some(link) = &service.linked {
        return Err(fail(
            Kind::Refused,
            format!(
                "{} ya es el scope {} de {}: un servicio de Dokploy pertenece a un solo scope.",
                service.path(),
                link.scope,
                link.repo
            ),
        ));
    }
    let mut body = json!({"alias": arg.alias, "kind": service.kind, "dokployId": service.id});
    if let Some(variable) = tag_variable {
        if service.kind != "compose" {
            return Err(fail(
                Kind::Error,
                format!(
                    "--tag-variable {} solo aplica a composes, y {} es una aplicación.",
                    arg.alias,
                    service.path()
                ),
            ));
        }
        body["tagVariable"] = json!(variable);
    }
    Ok(body)
}

/// The alias offered at the terminal: `prod`, then `stg`, then nothing.
pub fn suggest_alias(existing: &[String]) -> &'static str {
    ["prod", "stg"]
        .into_iter()
        .find(|a| !existing.iter().any(|e| e == a))
        .unwrap_or("")
}

// ------------------------------------------------------------------- the plan

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    Create,
    Rotate,
    Keep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretAction {
    /// `gh secret set` with the fresh token on stdin.
    Set,
    /// `--no-github --show-token`: shown once at the terminal.
    Print,
    /// No fresh token: only check the secret is there.
    Verify,
    /// Nothing to do on GitHub (`--no-github`, or no gh without a fresh token).
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenPlan {
    pub app: AppAction,
    pub secret: SecretAction,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PlanInput {
    pub app_exists: bool,
    pub rotate: bool,
    pub gh_ready: bool,
    pub no_github: bool,
    pub show_token: bool,
    /// A person at a terminal, without `--json`.
    pub terminal: bool,
}

/// Why keel refuses before creating the app or rotating its token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanRefusal {
    /// The token would have nowhere to go: gh is missing or without a session.
    NeedGh,
    /// `--no-github` without `--show-token` at a terminal.
    NeedShowToken,
}

/// What happens to the app and to the token, decided before touching keel.
pub fn plan_token(input: PlanInput) -> Result<TokenPlan, PlanRefusal> {
    let app = if !input.app_exists {
        AppAction::Create
    } else if input.rotate {
        AppAction::Rotate
    } else {
        AppAction::Keep
    };
    let secret = match app {
        AppAction::Keep if input.no_github || !input.gh_ready => SecretAction::Skip,
        AppAction::Keep => SecretAction::Verify,
        _ if input.no_github && input.show_token && input.terminal => SecretAction::Print,
        _ if input.no_github => return Err(PlanRefusal::NeedShowToken),
        _ if input.gh_ready => SecretAction::Set,
        _ => return Err(PlanRefusal::NeedGh),
    };
    Ok(TokenPlan { app, secret })
}

// -------------------------------------------------------- reachability checks

/// Names GitHub-hosted runners can't resolve.
pub fn private_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || [".localhost", ".local", ".internal"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

/// Loopback, private, link-local, CGNAT or unspecified addresses.
pub fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return private_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The warning for an API host GitHub's runners can't reach, given what it resolves to.
pub fn reachability_warning(host: &str, addresses: &[IpAddr]) -> Option<String> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let why = if private_name(host) {
        format!("{host} es un nombre interno")
    } else {
        let ip = addresses.iter().find(|ip| private_ip(**ip))?;
        if host.parse::<IpAddr>().is_ok() {
            format!("{host} es una IP privada")
        } else {
            format!("{host} resuelve a {ip}, una IP privada")
        }
    };
    Some(format!(
        "{why}: los runners de GitHub (ubuntu-latest) no llegan a /api/ci-result, así que keel no se entera del CI. Usa runners self-hosted en tu red o publica la API en un dominio público."
    ))
}

async fn reachability(api_url: &str) -> Option<String> {
    let url = url::Url::parse(api_url).ok()?;
    let host = url.host_str()?.to_owned();
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<IpAddr> = if let Ok(ip) = bare.parse::<IpAddr>() {
        vec![ip]
    } else if private_name(&host) {
        Vec::new()
    } else {
        let port = url.port_or_known_default().unwrap_or(443);
        match tokio::time::timeout(
            Duration::from_secs(3),
            tokio::net::lookup_host((host.as_str(), port)),
        )
        .await
        {
            Ok(Ok(addrs)) => addrs.map(|a| a.ip()).collect(),
            _ => Vec::new(),
        }
    };
    reachability_warning(&host, &addresses)
}

/// Whether any scope or Dokploy service says it pulls with registry credentials.
fn shows_registry(items: &[Value]) -> bool {
    items.iter().any(|item| {
        ["registry", "registryId", "registryUrl"]
            .iter()
            .any(|k| item.get(*k).is_some_and(|v| !v.is_null() && v != ""))
    })
}

pub const REGISTRY_HINT: &str = "Si la imagen de ghcr.io es privada, Dokploy necesita credenciales del registry (Settings → Registry) asignadas a cada servicio.";

// ----------------------------------------------------------------- the steps

/// Prints each step as it happens and keeps it for `--json`.
struct Steps {
    json: bool,
    colors: ui::Colors,
    items: Vec<Value>,
    warnings: Vec<String>,
}

impl Steps {
    fn new(ctx: &Ctx) -> Self {
        Self {
            json: ctx.json,
            colors: ctx.colors(),
            items: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn push(&mut self, step: &str, status: &str, message: String) {
        if !self.json {
            let mark = match status {
                "done" => self.colors.green("✔"),
                "skipped" => self.colors.cyan("•"),
                _ => self.colors.yellow("▲"),
            };
            println!("{mark} {message}");
        }
        if status == "warning" {
            self.warnings.push(message.clone());
        }
        self.items
            .push(json!({"step": step, "status": status, "message": message}));
    }

    fn done(&mut self, step: &str, message: impl Into<String>) {
        self.push(step, "done", message.into());
    }

    fn skipped(&mut self, step: &str, message: impl Into<String>) {
        self.push(step, "skipped", message.into());
    }

    fn warn(&mut self, step: &str, message: impl Into<String>) {
        self.push(step, "warning", message.into());
    }
}

pub struct InitArgs {
    pub check: bool,
    pub force: bool,
    pub yes: bool,
    pub rotate_token: bool,
    pub scopes: Vec<ScopeArg>,
    pub tag_variables: Vec<TagVariableArg>,
    pub no_github: bool,
    pub show_token: bool,
    pub pr: bool,
}

/// Adds what a 403 means for `keel init`, keeping the kind `forbidden`.
fn forbidden(error: anyhow::Error, needs: &str) -> anyhow::Error {
    if http_status(&error) != Some(403) {
        return error;
    }
    let details = error
        .chain()
        .find_map(|e| e.downcast_ref::<Failure>())
        .and_then(|f| f.details.clone())
        .unwrap_or_default();
    fail_with(
        Kind::Forbidden,
        format!("{} — {needs}", error.to_string().trim_end_matches('.')),
        details,
    )
}

const NEEDS_ADMIN: &str =
    "crear apps requiere rol admin; pide a un admin que la cree o que te dé el rol.";
const NEEDS_MAINTAINER_TOKEN: &str =
    "rotar el token de CI requiere rol maintainer en la app; pídeselo a un admin.";
const NEEDS_MAINTAINER_SCOPES: &str =
    "agregar scopes requiere rol maintainer en la app; pídeselo a un admin.";

enum AppState {
    /// From `GET /repos/<repo>` (v0.8.0+).
    Linked(Vec<Value>),
    Missing,
    /// A v0.7.0 server, where the app exists (its scopes from `/scopes`).
    OldLinked(Vec<Value>),
}

pub async fn init(ctx: &Ctx, args: InitArgs) -> Result<()> {
    let root = git::git(&ctx.cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| {
        fail(
            Kind::GitState,
            "keel init se ejecuta dentro de un repo de git.",
        )
    })?;
    let root = Path::new(&root);
    let origin = git::origin(root)?;
    if args.check {
        return check(ctx, root, &origin.slug()).await;
    }
    check_tag_variables(&args.scopes, &args.tag_variables)?;
    let terminal = ui::interactive() && !ctx.json;
    let mut steps = Steps::new(ctx);

    // 1. Repo and org.
    let target = resolve_repo(ctx, "vincular repos")?;
    let (repo, api) = (target.repo.clone(), &target.api);
    steps.done(
        "repo",
        format!("{repo} en la organización {}", target.org.org),
    );

    // 2. gh, before creating anything.
    let gh = SystemGh::new(root);
    let gh_state = if args.no_github {
        steps.skipped("gh", "GitHub omitido (--no-github)");
        None
    } else {
        let state = github::gh_state(&gh, &origin.host);
        match &state {
            GhState::Ready => steps.done("gh", format!("gh con sesión en {}", origin.host)),
            other => steps.warn("gh", other.instructions(&origin.host)),
        }
        Some(state)
    };
    let gh_ready = gh_state.as_ref().is_some_and(GhState::is_ready);
    if args.pr && !gh_ready {
        return Err(fail(
            Kind::Refused,
            format!(
                "--pr necesita gh. {}",
                gh_state.map_or_else(String::new, |s| s.instructions(&origin.host))
            ),
        ));
    }

    // 3. The app.
    let app = match api.get_repo(&repo).await {
        Ok(Some(linked)) => AppState::Linked(linked.scopes),
        Ok(None) => AppState::Missing,
        Err(error) if is_unsupported(&error) => {
            if args.rotate_token || !args.scopes.is_empty() {
                return Err(fail(Kind::KeelUnreachable, LINK_UNSUPPORTED));
            }
            match api.list_scopes_raw(&repo).await {
                Ok(Value::Array(scopes)) => AppState::OldLinked(scopes),
                Ok(_) => AppState::OldLinked(Vec::new()),
                Err(error) if http_status(&error) == Some(404) => {
                    return Err(fail(Kind::KeelUnreachable, LINK_UNSUPPORTED));
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    let old_server = matches!(app, AppState::OldLinked(_));
    let mut scopes = match &app {
        AppState::Linked(s) | AppState::OldLinked(s) => s.clone(),
        AppState::Missing => Vec::new(),
    };
    let mut aliases: Vec<String> = scopes
        .iter()
        .filter_map(|s| s["alias"].as_str().map(str::to_owned))
        .collect();
    let plan = plan_token(PlanInput {
        app_exists: !matches!(app, AppState::Missing),
        rotate: args.rotate_token,
        gh_ready,
        no_github: args.no_github,
        show_token: args.show_token,
        terminal,
    })
    .map_err(|refusal| match refusal {
        PlanRefusal::NeedGh => fail(
            Kind::Refused,
            format!(
                "No se creó nada: {}",
                gh_state
                    .as_ref()
                    .map_or_else(String::new, |s| s.instructions(&origin.host))
            ),
        ),
        PlanRefusal::NeedShowToken => fail(
            Kind::Refused,
            "No se creó nada: con --no-github el token de CI no tiene dónde guardarse. Pasa también --show-token en una terminal interactiva (sin --json) para verlo una sola vez, o quita --no-github.",
        ),
    })?;

    // The --scope flags are resolved before creating anything, so a typo costs nothing.
    let pending: Vec<&ScopeArg> = args
        .scopes
        .iter()
        .filter(|s| !aliases.contains(&s.alias))
        .collect();
    let mut services: Option<Vec<DokployService>> = None;
    let mut bodies = Vec::new();
    if !pending.is_empty() {
        // URLs don't need the listing (keel resolves them), so a Dokploy that
        // doesn't answer only matters when an id has to be looked up.
        let only_urls = pending
            .iter()
            .all(|a| matches!(a.target, ScopeTarget::Url(_)));
        let list = match api.dokploy_services().await {
            Ok(list) => list,
            Err(_) if only_urls => Vec::new(),
            Err(e) => return Err(forbidden(e, NEEDS_MAINTAINER_SCOPES)),
        };
        for arg in &pending {
            let tag = args
                .tag_variables
                .iter()
                .find(|t| t.alias == arg.alias)
                .map(|t| t.variable.as_str());
            bodies.push(scope_body(arg, tag, &list)?);
        }
        services = Some(list);
    }

    let mut token: Option<CiToken> = None;
    let app_status = match plan.app {
        AppAction::Create => {
            if !args.yes {
                if !terminal {
                    return Err(need_terminal("-y para crear la app en keel"));
                }
                if !ui::confirm(&format!("{repo} no está vinculado en keel. ¿Crear la app?"))? {
                    return Err(fail(Kind::Cancelled, "Cancelado: no se creó la app."));
                }
            }
            let created = api
                .create_app(&repo, None)
                .await
                .map_err(|e| forbidden(e, NEEDS_ADMIN))?;
            token = Some(created.ci_token);
            steps.done("app", format!("app {repo} creada en keel"));
            "created"
        }
        AppAction::Rotate => {
            if !args.yes {
                if !terminal {
                    return Err(need_terminal("-y para rotar el token de CI"));
                }
                if !ui::confirm(&format!(
                    "Rotar el token de CI de {repo} invalida el token que usa el CI actual; se reemplaza el secret en el mismo paso. ¿Continuar?"
                ))? {
                    return Err(fail(Kind::Cancelled, "Cancelado: el token no cambió."));
                }
            }
            token = Some(
                api.rotate_ci_token(&repo)
                    .await
                    .map_err(|e| forbidden(e, NEEDS_MAINTAINER_TOKEN))?,
            );
            steps.done("app", format!("token de CI de {repo} rotado"));
            "rotated"
        }
        AppAction::Keep => {
            steps.skipped(
                "app",
                format!(
                    "{repo} ya está vinculado en keel ({} scope(s))",
                    aliases.len()
                ),
            );
            if old_server {
                steps.warn(
                    "app",
                    "Tu servidor de keel es anterior a v0.8.0: init solo revisa (no crea apps, scopes ni tokens).",
                );
            }
            "linked"
        }
    };

    // The fresh token goes to GitHub right away: it is never shown again.
    let secret_status = match (plan.secret, &token) {
        (SecretAction::Set, Some(token)) => {
            github::set_secret(&gh, &repo, token)?;
            steps.done(
                "secret",
                format!("secret {SECRET} guardado en {repo} (por stdin de gh)"),
            );
            "set"
        }
        (SecretAction::Print, Some(token)) => {
            println!(
                "\n  Token de CI (se muestra una sola vez; guárdalo como secret {SECRET} de {repo}):\n\n  {}\n",
                token.expose()
            );
            steps.done(
                "secret",
                format!("token de CI mostrado una vez: guárdalo como secret {SECRET}"),
            );
            "printed"
        }
        (SecretAction::Verify, _) => match github::has_secret(&gh, &repo) {
            Some(true) => {
                steps.skipped("secret", format!("secret {SECRET} ya existe en {repo}"));
                "present"
            }
            Some(false) => {
                steps.warn(
                    "secret",
                    format!(
                        "falta el secret {SECRET} en {repo}: `keel init --rotate-token` crea un token nuevo y lo guarda."
                    ),
                );
                "missing"
            }
            None => {
                steps.warn(
                    "secret",
                    format!("gh no pudo listar los secrets de {repo}: revisa {SECRET} a mano."),
                );
                "unknown"
            }
        },
        _ => "skipped",
    };
    // Gone from memory as soon as it's stored.
    drop(token);

    // 4. Scopes.
    let mut created_scopes = Vec::new();
    for (arg, body) in pending.iter().zip(bodies) {
        let what = body["dokployId"]
            .as_str()
            .and_then(|id| services.iter().flatten().find(|s| s.id == id))
            .map(|s| format!(" → {} ({})", s.path(), s.kind))
            .or_else(|| body["dokployUrl"].as_str().map(|u| format!(" → {u}")))
            .unwrap_or_default();
        match api.create_scope(&repo, body).await {
            Ok(scope) => {
                steps.done("scope", format!("scope {}{what} agregado", arg.alias));
                aliases.push(arg.alias.clone());
                created_scopes.push(scope.clone());
                scopes.push(scope);
            }
            Err(error) if http_status(&error) == Some(409) => {
                steps.skipped("scope", format!("scope {} ya existe", arg.alias));
            }
            Err(error) => return Err(forbidden(error, NEEDS_MAINTAINER_SCOPES)),
        }
    }
    for arg in args
        .scopes
        .iter()
        .filter(|s| !pending.iter().any(|p| p.alias == s.alias))
    {
        steps.skipped("scope", format!("scope {} ya existe", arg.alias));
    }
    if args.scopes.is_empty() && terminal && !old_server {
        match api.dokploy_services().await {
            Ok(list) => {
                pick_scopes(api, &repo, &list, &mut aliases, &mut scopes, &mut steps).await?;
                services = Some(list);
            }
            Err(error) => steps.warn(
                "scope",
                format!("No se pudieron listar los servicios de Dokploy: {error:#}"),
            ),
        }
    }
    if aliases.is_empty() {
        steps.warn(
            "scope",
            format!(
                "{repo} no tiene scopes: agrega uno con `keel init --scope prod=<id-o-url-de-dokploy>`."
            ),
        );
    }

    // 5. The variable the workflow reads.
    let api_url = target.org.api_url.clone();
    let variable_status = if gh_ready {
        match github::variable(&gh, &repo) {
            Some(value) if value == api_url => {
                steps.skipped("variable", format!("variable {VARIABLE} = {api_url}"));
                "present"
            }
            current => {
                github::set_variable(&gh, &repo, &api_url)?;
                steps.done(
                    "variable",
                    match current {
                        Some(old) => format!("variable {VARIABLE} = {api_url} (antes {old})"),
                        None => format!("variable {VARIABLE} = {api_url}"),
                    },
                );
                "set"
            }
        }
    } else {
        "skipped"
    };

    // 6. The workflow.
    let workflow = write_workflow(ctx, root, args.force, &steps)?;
    let status = workflow["status"].as_str().unwrap_or_default();
    match status {
        "created" => steps.done(
            "workflow",
            format!("{WORKFLOW_PATH} creado: ajusta su paso de tests"),
        ),
        "replaced" => steps.done(
            "workflow",
            format!("{WORKFLOW_PATH} reemplazado por la plantilla"),
        ),
        _ => steps.skipped("workflow", format!("{WORKFLOW_PATH} igual a la plantilla")),
    }
    let mut pr = Value::Null;
    if gh_ready && (args.pr || terminal) {
        pr = workflow_pr(&gh, root, &repo, args.pr, terminal, &mut steps)?;
    }

    // 7. Final checks.
    let reach = reachability(&api_url).await;
    if let Some(warning) = &reach {
        steps.warn("reachability", warning.clone());
    }
    let service_items: Vec<Value> = services
        .iter()
        .flatten()
        .filter(|s| {
            s.linked
                .as_ref()
                .is_some_and(|l| l.repo.eq_ignore_ascii_case(&repo))
        })
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    if !shows_registry(&scopes) && !shows_registry(&service_items) {
        steps.warn("registry", REGISTRY_HINT);
    }
    let org = Ok(target.org.clone());
    let audit = audit(root, &repo, &org, &gh, reach).await;
    let report = json!({
        "ok": audit["ok"], "repo": repo, "steps": steps.items, "warnings": steps.warnings,
        "app": {"status": app_status, "old_server": old_server},
        "scopes": {"aliases": aliases, "created": created_scopes},
        "github": {"gh": gh_state.as_ref().map(GhState::name), "secret": secret_status, "variable": variable_status},
        "workflow": workflow, "pr": pr, "audit": audit,
    });
    if ctx.json {
        return print_json(&report);
    }
    println!("\n{}", ctx.colors().bold("Revisión (keel init --check)"));
    // The warnings were already printed as steps.
    print_audit(&report["audit"], false);
    Ok(())
}

/// At a terminal: picks unlinked Dokploy services one by one until «listo».
async fn pick_scopes(
    api: &KeelApi,
    repo: &str,
    services: &[DokployService],
    aliases: &mut Vec<String>,
    scopes: &mut Vec<Value>,
    steps: &mut Steps,
) -> Result<()> {
    let mut used: Vec<String> = Vec::new();
    loop {
        let free: Vec<&DokployService> = services
            .iter()
            .filter(|s| s.linked.is_none() && !used.contains(&s.id))
            .collect();
        if free.is_empty() {
            if used.is_empty() {
                steps.skipped(
                    "scope",
                    "no hay servicios de Dokploy sin vincular para agregar",
                );
            }
            return Ok(());
        }
        let mut options: Vec<(String, Option<String>)> = free
            .iter()
            .map(|s| (s.path(), Some(s.kind.clone())))
            .collect();
        options.push(("listo".to_owned(), None));
        let prompt = if aliases.is_empty() {
            "Agrega un scope: elige su servicio de Dokploy"
        } else {
            "¿Otro scope? Elige su servicio de Dokploy"
        };
        let index = ui::select(
            prompt,
            &options,
            if aliases.is_empty() { 0 } else { free.len() },
        )?;
        let Some(service) = free.get(index) else {
            return Ok(());
        };
        let alias = ui::ask_default("Alias del scope", suggest_alias(aliases))?;
        if let Err(error) = valid_alias(&alias) {
            ui::warn(&error);
            continue;
        }
        if aliases.contains(&alias) {
            ui::warn(&format!("El scope {alias} ya existe."));
            continue;
        }
        let mut body = json!({"alias": alias, "kind": service.kind, "dokployId": service.id});
        if service.kind == "compose" {
            let variable = ui::ask_default("Variable del tag en el compose", "DOCKER_TAG")?;
            if !ENV_NAME.is_match(&variable) {
                ui::warn(&format!("Nombre de variable inválido: {variable}"));
                continue;
            }
            body["tagVariable"] = json!(variable);
        }
        match api.create_scope(repo, body).await {
            Ok(scope) => {
                steps.done(
                    "scope",
                    format!("scope {alias} → {} ({})", service.path(), service.kind),
                );
                aliases.push(alias);
                scopes.push(scope);
                used.push(service.id.clone());
            }
            Err(error) if http_status(&error) == Some(409) => {
                steps.skipped("scope", format!("scope {alias} ya existe"));
            }
            Err(error) => return Err(forbidden(error, NEEDS_MAINTAINER_SCOPES)),
        }
    }
}

/// Writes the template unless the file is customized (then `--force`).
fn write_workflow(ctx: &Ctx, root: &Path, force: bool, steps: &Steps) -> Result<Value> {
    let path = root.join(WORKFLOW_PATH);
    let mut workflow = json!({"path": WORKFLOW_PATH});
    match workflow_state(root) {
        FileState::Missing => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, WORKFLOW)?;
            workflow["status"] = json!("created");
        }
        FileState::Same => workflow["status"] = json!("up_to_date"),
        FileState::Customized if force => {
            std::fs::write(&path, WORKFLOW)?;
            workflow["status"] = json!("replaced");
        }
        FileState::Customized => {
            let diff = workflow_diff(root)?;
            workflow["status"] = json!("customized");
            workflow["diff"] = json!(diff);
            if !ctx.json {
                println!("{diff}");
            }
            return Err(fail_with(
                Kind::Refused,
                format!(
                    "{WORKFLOW_PATH} ya existe y no es la plantilla (diff arriba). Usa --force para reemplazarlo; un workflow adaptado (p. ej. con tus tests) es normal. Los pasos anteriores ya quedaron hechos."
                ),
                json!({"workflow": workflow, "steps": steps.items}),
            ));
        }
    }
    Ok(workflow)
}

fn workflow_diff(root: &Path) -> Result<String> {
    let current = std::fs::read_to_string(root.join(WORKFLOW_PATH))?;
    Ok(similar::TextDiff::from_lines(current.as_str(), WORKFLOW)
        .unified_diff()
        .header(WORKFLOW_PATH, "plantilla de keel")
        .to_string())
}

/// `--pr` (or «¿Abrir un PR…?» at a terminal): the workflow on a `keel/init` branch.
fn workflow_pr(
    gh: &dyn Gh,
    root: &Path,
    repo: &str,
    asked: bool,
    terminal: bool,
    steps: &mut Steps,
) -> Result<Value> {
    let base = match github::default_branch(root) {
        Ok(base) => base,
        Err(error) if asked => return Err(error),
        Err(_) => return Ok(Value::Null),
    };
    let on_base = match github::fetch_file(root, &base, WORKFLOW_PATH) {
        Ok(content) => content,
        Err(error) if asked => return Err(error),
        Err(_) => return Ok(Value::Null),
    };
    if on_base.as_deref().map(str::trim) == Some(WORKFLOW.trim()) {
        steps.skipped("pr", format!("el workflow ya está en {base}"));
        return Ok(json!({"status": "on_base", "base": base}));
    }
    if !asked && !(terminal && ui::confirm("¿Abrir un PR con el workflow?")?) {
        return Ok(Value::Null);
    }
    match github::open_pr(gh, root, repo, &base, WORKFLOW_PATH, WORKFLOW)? {
        PrOutcome::Opened(url) => {
            steps.done(
                "pr",
                format!("PR abierto desde {}: {url}", github::PR_BRANCH),
            );
            Ok(json!({"status": "opened", "url": url, "branch": github::PR_BRANCH, "base": base}))
        }
        PrOutcome::BranchExists => {
            steps.skipped(
                "pr",
                format!(
                    "la rama {} ya existe en origin (PR abierto o mergeado)",
                    github::PR_BRANCH
                ),
            );
            Ok(json!({"status": "branch_exists", "branch": github::PR_BRANCH, "base": base}))
        }
    }
}

// ------------------------------------------------------------------ the audit

/// `keel init --check`: read-only; exit 2 when something is missing.
async fn check(ctx: &Ctx, root: &Path, repo: &str) -> Result<()> {
    let org = config::active_org(&ctx.home, ctx.org.as_deref());
    let gh = SystemGh::new(root);
    let reach = match &org {
        Ok(org) => reachability(&org.api_url).await,
        Err(_) => None,
    };
    let report = audit(root, repo, &org, &gh, reach).await;
    let problems = report["problems"].as_array().map_or(0, Vec::len);
    if problems > 0 {
        if !ctx.json {
            print_audit(&report, true);
        }
        return Err(fail_with(
            Kind::Config,
            format!("{repo} todavía no está listo para keel ({problems} pendiente(s))."),
            report,
        ));
    }
    if ctx.json {
        return print_json(&report);
    }
    print_audit(&report, true);
    Ok(())
}

async fn audit(
    root: &Path,
    repo: &str,
    org: &Result<config::OrgConfig>,
    gh: &dyn Gh,
    reach: Option<String>,
) -> Value {
    let mut problems: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = reach.into_iter().collect();

    // The workflow.
    let mut workflow = json!({"path": WORKFLOW_PATH});
    match workflow_state(root) {
        FileState::Missing => {
            workflow["status"] = json!("missing");
            problems.push(format!("Falta {WORKFLOW_PATH}: créalo con `keel init`."));
        }
        FileState::Same => workflow["status"] = json!("up_to_date"),
        FileState::Customized => {
            workflow["status"] = json!("customized");
            if let Ok(diff) = workflow_diff(root) {
                workflow["diff"] = json!(diff);
            }
        }
    }

    // The app in keel and its scopes.
    let keel = match org {
        Err(error) => {
            problems.push(format!("{error:#}"));
            json!({"linked": null})
        }
        Ok(org) => match keel_state(org, repo).await {
            Ok(Some(scopes)) => {
                if scopes.is_empty() {
                    problems.push(format!(
                        "La app {repo} no tiene scopes: agrégalos con `keel init --scope prod=<id-o-url-de-dokploy>`."
                    ));
                }
                json!({"linked": true, "api_url": org.api_url, "scopes_count": scopes.len(), "scopes": scopes})
            }
            Ok(None) => {
                problems.push(format!(
                    "{repo} no está vinculado en keel: `keel init` crea la app (rol admin) o créala en {}.",
                    admin_url(&org.api_url)
                ));
                json!({"linked": false, "api_url": org.api_url, "admin": admin_url(&org.api_url)})
            }
            Err(error) => {
                problems.push(format!("No se pudo consultar keel: {error:#}"));
                json!({"linked": null, "api_url": org.api_url, "error": crate::failure::report(&error).0["error"]})
            }
        },
    };

    // The secret and the variable the workflow reads (names and the URL only).
    let github = match github::has_secret(gh, repo) {
        Some(has_token) => {
            if !has_token {
                problems.push(format!(
                    "Falta el secret {SECRET} en {repo}: `keel init --rotate-token` crea un token nuevo y lo guarda."
                ));
            }
            let api = org.as_ref().ok().map(|o| o.api_url.clone());
            let value = github::variable(gh, repo);
            let has_url = value.is_some();
            match (&value, &api) {
                (None, _) => problems.push(format!(
                    "Falta la variable {VARIABLE} en {repo} (si no está a nivel organización): `keel init` la crea."
                )),
                (Some(v), Some(api)) if v != api => warnings.push(format!(
                    "La variable {VARIABLE} de {repo} es {v}, pero la API de la org es {api}: `keel init` la corrige."
                )),
                _ => {}
            }
            json!({"checked": true, SECRET: has_token, VARIABLE: has_url, "KEEL_API_URL_value": value})
        }
        None => json!({"checked": false,
            "note": "gh no está disponible o no tiene acceso: revisa a mano el secret DEPLOY_API_TOKEN y la variable KEEL_API_URL"}),
    };

    json!({
        "ok": problems.is_empty(), "repo": repo, "workflow": workflow,
        "keel": keel, "github": github, "problems": problems, "warnings": warnings,
    })
}

/// The scopes of the linked app, `None` if it isn't linked. Falls back to
/// `/scopes` (and `/services`) on servers before v0.8.0.
async fn keel_state(org: &config::OrgConfig, repo: &str) -> Result<Option<Vec<Value>>> {
    let api = KeelApi::for_org(org)?;
    match api.get_repo(repo).await {
        Ok(linked) => Ok(linked.map(|l| l.scopes)),
        Err(error) if is_unsupported(&error) => match api.list_scopes_raw(repo).await {
            Ok(Value::Array(scopes)) => Ok(Some(scopes)),
            Ok(_) => Ok(Some(Vec::new())),
            Err(error) if http_status(&error) == Some(404) && !is_unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    }
}

fn print_audit(report: &Value, warnings: bool) {
    let c = ui::stdout_colors();
    let line = match report["workflow"]["status"].as_str().unwrap_or("") {
        "up_to_date" => format!("{} {WORKFLOW_PATH} igual a la plantilla", c.green("✔")),
        "customized" => format!(
            "{} {WORKFLOW_PATH} adaptado (distinto de la plantilla)",
            c.green("✔")
        ),
        _ => format!("{} falta {WORKFLOW_PATH}", c.red("✖")),
    };
    println!("{line}");
    match report["keel"]["linked"].as_bool() {
        Some(true) => println!(
            "{} app vinculada en keel ({} scope(s))",
            c.green("✔"),
            report["keel"]["scopes_count"].as_u64().unwrap_or(0)
        ),
        Some(false) => println!("{} app no vinculada en keel", c.red("✖")),
        None => println!("{} keel sin comprobar", c.yellow("▲")),
    }
    if report["github"]["checked"] == true {
        let mark = |ok: &Value| {
            if ok == true {
                c.green("✔")
            } else if ok.is_null() {
                c.yellow("▲")
            } else {
                c.red("✖")
            }
        };
        println!("{} secret {SECRET}", mark(&report["github"][SECRET]));
        println!("{} variable {VARIABLE}", mark(&report["github"][VARIABLE]));
    } else {
        println!(
            "{} {}",
            c.yellow("▲"),
            report["github"]["note"].as_str().unwrap_or("")
        );
    }
    for warning in report["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|_| warnings)
    {
        println!("{} {}", c.yellow("▲"), warning.as_str().unwrap_or_default());
    }
    let problems = report["problems"].as_array().cloned().unwrap_or_default();
    if !problems.is_empty() {
        println!();
        for p in problems {
            println!("  · {}", p.as_str().unwrap_or_default());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn reads_gh_lists_and_admin_urls() {
        assert_eq!(
            gh_names("DEPLOY_API_TOKEN\t2026-11-01T00:00:00Z\nOTHER\tx\n"),
            ["DEPLOY_API_TOKEN", "OTHER"]
        );
        assert_eq!(
            admin_url("https://keel.acme.dev/api"),
            "https://keel.acme.dev/apps"
        );
        assert!(WORKFLOW.contains("ci-result"));
    }

    #[test]
    fn detects_the_workflow_state() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(workflow_state(dir.path()), FileState::Missing);
        std::fs::create_dir_all(dir.path().join(".github/workflows")).unwrap();
        std::fs::write(dir.path().join(WORKFLOW_PATH), WORKFLOW).unwrap();
        assert_eq!(workflow_state(dir.path()), FileState::Same);
        std::fs::write(dir.path().join(WORKFLOW_PATH), "x").unwrap();
        assert_eq!(workflow_state(dir.path()), FileState::Customized);
    }

    #[test]
    fn parses_scope_flags() {
        assert_eq!(
            parse_scope_arg("prod=cmp_123").unwrap(),
            ScopeArg {
                alias: "prod".into(),
                target: ScopeTarget::Id("cmp_123".into())
            }
        );
        assert_eq!(
            parse_scope_arg(
                " stg = https://dokploy.acme.dev/dashboard/project/p1/services/compose/c1/ "
            )
            .unwrap()
            .target,
            ScopeTarget::Url(
                "https://dokploy.acme.dev/dashboard/project/p1/services/compose/c1".into()
            )
        );
        for bad in [
            "prod",
            "=abc",
            "prod=",
            "pr od=abc",
            "prod=a b",
            "-x=abc",
            "a/b=c",
            "prod=x/y",
        ] {
            assert!(parse_scope_arg(bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse_tag_variable("prod=IMAGE_TAG").unwrap(),
            TagVariableArg {
                alias: "prod".into(),
                variable: "IMAGE_TAG".into()
            }
        );
        assert!(parse_tag_variable("prod=1TAG").is_err());
        assert!(parse_tag_variable("prod").is_err());

        let scopes = vec![parse_scope_arg("prod=c1").unwrap()];
        let ok = vec![parse_tag_variable("prod=TAG").unwrap()];
        assert!(check_tag_variables(&scopes, &ok).is_ok());
        let orphan = vec![parse_tag_variable("stg=TAG").unwrap()];
        assert!(check_tag_variables(&scopes, &orphan).is_err());
        let twice = vec![scopes[0].clone(), scopes[0].clone()];
        assert!(check_tag_variables(&twice, &[]).is_err());
    }

    fn service(id: &str, kind: &str, linked: bool) -> DokployService {
        serde_json::from_value(json!({
            "kind": kind, "id": id, "name": "web", "project": "Shop", "environment": "production",
            "dashboardUrl": format!("https://dokploy.acme.dev/x/{id}"),
            "linked": if linked { json!({"repo": "acme/other", "scope": "prod"}) } else { Value::Null },
        }))
        .unwrap()
    }

    #[test]
    fn builds_scope_bodies() {
        let services = [
            service("cmp1", "compose", false),
            service("app1", "application", false),
            service("used", "compose", true),
        ];
        let arg = parse_scope_arg("prod=cmp1").unwrap();
        assert_eq!(
            scope_body(&arg, Some("IMAGE_TAG"), &services).unwrap(),
            json!({"alias": "prod", "kind": "compose", "dokployId": "cmp1", "tagVariable": "IMAGE_TAG"})
        );
        let arg = parse_scope_arg("stg=https://dokploy.acme.dev/x/app1").unwrap();
        assert_eq!(
            scope_body(&arg, None, &services).unwrap(),
            json!({"alias": "stg", "kind": "application", "dokployId": "app1"})
        );
        let unknown_url = parse_scope_arg("stg=https://dokploy.acme.dev/other").unwrap();
        assert_eq!(
            scope_body(&unknown_url, None, &services).unwrap(),
            json!({"alias": "stg", "dokployUrl": "https://dokploy.acme.dev/other"})
        );
        assert!(scope_body(&unknown_url, Some("TAG"), &services).is_err());
        let app = parse_scope_arg("stg=app1").unwrap();
        assert!(scope_body(&app, Some("TAG"), &services).is_err());
        let missing = parse_scope_arg("prod=nope").unwrap();
        let error = scope_body(&missing, None, &services).unwrap_err();
        assert_eq!(
            crate::failure::report(&error).0["error"]["kind"],
            "service_not_found"
        );
        let used = parse_scope_arg("prod=used").unwrap();
        let error = scope_body(&used, None, &services).unwrap_err();
        assert!(error.to_string().contains("acme/other"));
        assert_eq!(suggest_alias(&[]), "prod");
        assert_eq!(suggest_alias(&["prod".into()]), "stg");
        assert_eq!(suggest_alias(&["prod".into(), "stg".into()]), "");
    }

    #[test]
    fn detects_private_hosts() {
        for name in [
            "localhost",
            "api.localhost",
            "keel.konectus.internal",
            "keel.local",
            "KEEL.INTERNAL.",
        ] {
            assert!(private_name(name), "{name}");
            assert!(reachability_warning(name, &[]).is_some(), "{name}");
        }
        assert!(!private_name("keel.acme.dev"));
        assert!(!private_name("internal.acme.dev"));
        let private: [IpAddr; 9] = [
            Ipv4Addr::new(10, 0, 0, 1).into(),
            Ipv4Addr::new(172, 16, 5, 4).into(),
            Ipv4Addr::new(192, 168, 1, 1).into(),
            Ipv4Addr::new(127, 0, 0, 1).into(),
            Ipv4Addr::new(169, 254, 1, 1).into(),
            Ipv4Addr::new(100, 64, 0, 1).into(),
            Ipv6Addr::LOCALHOST.into(),
            "fd00::1".parse().unwrap(),
            "fe80::1".parse().unwrap(),
        ];
        for ip in private {
            assert!(private_ip(ip), "{ip}");
        }
        assert!(private_ip("::ffff:10.0.0.1".parse().unwrap()));
        for ip in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"] {
            assert!(!private_ip(ip.parse().unwrap()), "{ip}");
        }
        let resolved = reachability_warning("keel.acme.dev", &["10.1.2.3".parse().unwrap()]);
        assert!(resolved.unwrap().contains("resuelve a 10.1.2.3"));
        assert!(reachability_warning("127.0.0.1", &["127.0.0.1".parse().unwrap()]).is_some());
        assert!(reachability_warning("keel.acme.dev", &["8.8.8.8".parse().unwrap()]).is_none());
        assert!(reachability_warning("[::1]", &[Ipv6Addr::LOCALHOST.into()]).is_some());
    }

    #[test]
    fn plans_the_app_and_the_token() {
        let plan = |input: PlanInput| plan_token(input);
        let fresh = PlanInput {
            gh_ready: true,
            ..Default::default()
        };
        // A new app: created, its token straight to the secret.
        assert_eq!(
            plan(fresh),
            Ok(TokenPlan {
                app: AppAction::Create,
                secret: SecretAction::Set
            })
        );
        // Without gh nothing is created.
        assert_eq!(
            plan(PlanInput {
                gh_ready: false,
                ..fresh
            }),
            Err(PlanRefusal::NeedGh)
        );
        // --no-github needs --show-token at a terminal.
        let no_github = PlanInput {
            no_github: true,
            gh_ready: false,
            ..fresh
        };
        assert_eq!(plan(no_github), Err(PlanRefusal::NeedShowToken));
        assert_eq!(
            plan(PlanInput {
                show_token: true,
                ..no_github
            }),
            Err(PlanRefusal::NeedShowToken)
        );
        assert_eq!(
            plan(PlanInput {
                show_token: true,
                terminal: true,
                ..no_github
            })
            .unwrap()
            .secret,
            SecretAction::Print
        );
        // An existing app: kept and verified, or rotated with --rotate-token.
        let linked = PlanInput {
            app_exists: true,
            ..fresh
        };
        assert_eq!(
            plan(linked),
            Ok(TokenPlan {
                app: AppAction::Keep,
                secret: SecretAction::Verify
            })
        );
        assert_eq!(
            plan(PlanInput {
                gh_ready: false,
                ..linked
            })
            .unwrap()
            .secret,
            SecretAction::Skip
        );
        assert_eq!(
            plan(PlanInput {
                rotate: true,
                ..linked
            }),
            Ok(TokenPlan {
                app: AppAction::Rotate,
                secret: SecretAction::Set
            })
        );
        assert_eq!(
            plan(PlanInput {
                rotate: true,
                gh_ready: false,
                ..linked
            }),
            Err(PlanRefusal::NeedGh)
        );
    }

    #[test]
    fn finds_registry_hints() {
        assert!(!shows_registry(&[
            json!({"alias": "prod", "registryId": null})
        ]));
        assert!(shows_registry(&[
            json!({"alias": "prod", "registryId": "r1"})
        ]));
    }
}
