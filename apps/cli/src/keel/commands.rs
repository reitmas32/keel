//! keel's own commands: versions and deploys through the keel server, plus
//! `status`, `logs` and `deploys --log`, which also read Dokploy.

use crate::dokploy::client::DokployClient;
use crate::dokploy::commands::{ServiceRef, fetch_deploy_log, fetch_logs};
use crate::dokploy::extra::{FollowOutput, follow_logs};
use crate::dokploy::paths::{Target, keel_home, load_config};
use crate::dokploy::{config::Config, print_json};
use crate::failure::{Kind, fail, fail_with};
use crate::keel::api::{
    CreateDeploy, Deploy, DeployStatus, KeelApi, RegisterVersion, ScopeSummary, Version, WhoAmI,
    is_unsupported,
};
use crate::keel::config::{self, OrgConfig};
use crate::keel::views::{self, Header, StatusRow, ViewOptions};
use crate::keel::{git, semver};
use crate::ui::{self, Colors};
use anyhow::Result;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How many recent versions the interactive picker shows.
const VERSION_CHOICES: usize = 15;
/// How many versions are asked for to describe the one being deployed.
const VERSION_LOOKUP: u32 = 200;
/// How far back in a scope's history a rollback looks.
const HISTORY: u32 = 200;

/// Options every keel command shares.
pub struct Ctx {
    pub json: bool,
    /// `--org`: use this org instead of the active one.
    pub org: Option<String>,
    pub cwd: PathBuf,
    pub home: PathBuf,
}

impl Ctx {
    pub fn new(json: bool, org: Option<String>) -> Result<Self> {
        Ok(Self {
            json,
            org,
            cwd: std::env::current_dir()?,
            home: keel_home()?,
        })
    }

    pub(crate) fn colors(&self) -> Colors {
        if self.json {
            Colors::plain()
        } else {
            ui::stdout_colors()
        }
    }

    pub(crate) fn view(&self) -> ViewOptions {
        ViewOptions::now(self.colors())
    }
}

/// The active org and the current repo, failing if the repo's origin
/// belongs to another org.
pub struct Repo {
    pub org: OrgConfig,
    /// `owner/name`
    pub repo: String,
    pub api: KeelApi,
}

impl Repo {
    pub(crate) fn header(&self) -> Header<'_> {
        Header {
            repo: &self.repo,
            org: &self.org.org,
            api_url: &self.org.api_url,
        }
    }
}

pub fn resolve_repo(ctx: &Ctx, action: &str) -> Result<Repo> {
    let org = config::active_org(&ctx.home, ctx.org.as_deref())?;
    let origin = git::origin(&ctx.cwd)?;
    if origin.host != "github.com" || !origin.owner.eq_ignore_ascii_case(org.owner()) {
        return Err(fail(
            Kind::GitState,
            format!(
                "La configuración actual de keel ({}) no puede {action} en esta organización ({}:{}). Usa `keel use`.",
                org.org, origin.host, origin.owner
            ),
        ));
    }
    let api = KeelApi::for_org(&org)?;
    Ok(Repo {
        repo: origin.slug(),
        org,
        api,
    })
}

fn validate_limit(limit: Option<u32>) -> Result<()> {
    if limit.is_some_and(|l| !(1..=200).contains(&l)) {
        return Err(fail(Kind::Error, "-n debe ser un entero entre 1 y 200."));
    }
    Ok(())
}

pub fn need_terminal(what: &str) -> anyhow::Error {
    fail(
        Kind::MissingInput,
        format!("Sin terminal interactiva hay que indicar {what}."),
    )
}

// ------------------------------------------------------------------ login/use

pub async fn login(
    ctx: &Ctx,
    org: Option<String>,
    api_url: Option<String>,
    token: Option<String>,
    ci_api_url: Option<String>,
) -> Result<()> {
    let org = match org {
        Some(org) => org,
        None if ui::interactive() => {
            ui::ask("Organización (github.com:<org>)", "github.com:konectus-io")?
        }
        None => return Err(need_terminal("--org")),
    };
    if let Some(error) = config::validate_org(&org) {
        return Err(fail(Kind::Config, error));
    }
    let api_url = match api_url {
        Some(url) => url,
        None if ui::interactive() => {
            ui::ask("URL de la API de keel", "keel.konectus.internal/api")?
        }
        None => return Err(need_terminal("--api-url")),
    };
    let api_url = config::normalize_api_url(&api_url)?;
    let saved_before = config::read_org(&ctx.home, &org)?;
    let previous = saved_before.as_ref().and_then(|o| o.token.clone());
    // `--ci-api-url ""` forgets it; without the flag the saved one stays.
    let ci_api_url = match ci_api_url {
        Some(url) if url.trim().is_empty() => None,
        Some(url) => Some(config::normalize_api_url(&url)?),
        None => saved_before.and_then(|o| o.ci_api_url),
    };
    // `--token ""` forgets it; without --token a terminal asks, and a script keeps the saved one.
    let token = match token {
        Some(token) => Some(token),
        None if ui::interactive() && !ctx.json => Some(ui::secret_optional(
            "Token personal de keel (Tokens de API en el admin; Enter para omitir)",
        )?),
        None => None,
    };
    let token = match token {
        Some(t) => Some(t.trim().to_owned()).filter(|t| !t.is_empty()),
        None => previous,
    };
    // A token is checked before it is saved; an unreachable server only warns.
    let mut user = None;
    let mut warning = None;
    if let Some(token) = &token {
        match KeelApi::with_token(&api_url, Some(token.clone()))?
            .whoami()
            .await
        {
            Ok(Some(who)) => user = who.name,
            Ok(None) => {
                warning = Some("Tu servidor de keel no conoce los tokens personales: se guardó, pero no se usa todavía.".to_owned());
            }
            Err(error) if crate::failure::report(&error).0["error"]["kind"] == "unauthorized" => {
                return Err(error);
            }
            Err(error) => {
                warning = Some(format!(
                    "No se pudo comprobar el token ({error:#}); se guardó igual."
                ));
            }
        }
    }
    let saved = OrgConfig {
        org: org.clone(),
        api_url: api_url.clone(),
        token: token.clone(),
        ci_api_url: ci_api_url.clone(),
    };
    config::save_org(&ctx.home, &saved)?;
    config::set_active_org(&ctx.home, &org)?;
    if ctx.json {
        return print_json(&json!({
            "ok": true, "org": org, "apiUrl": api_url, "active": true,
            "token": token.is_some(), "user": user, "warning": warning,
            "ciApiUrl": ci_api_url,
        }));
    }
    ui::success(&format!(
        "{org} guardada ({api_url}) y seleccionada como organización activa."
    ));
    if let Some(ci) = &ci_api_url {
        ui::info(&format!(
            "Los runners de GitHub usan {ci} (KEEL_API_URL de los repos que prepara keel init)."
        ));
    }
    match (&token, &user) {
        (Some(_), Some(user)) => ui::success(&format!("Token verificado: eres {user}.")),
        (Some(_), None) => {}
        (None, _) => {
            ui::info("Sin token personal. Si el servidor lo exige: keel login --token <token>.")
        }
    }
    if let Some(warning) = warning {
        ui::warn(&warning);
    }
    Ok(())
}

pub fn use_org(ctx: &Ctx, org: Option<String>) -> Result<()> {
    let orgs = config::list_orgs(&ctx.home)?;
    if orgs.is_empty() {
        return Err(fail(
            Kind::Config,
            "No hay organizaciones configuradas. Ejecuta `keel login`.",
        ));
    }
    let selected = match org {
        Some(org) => org,
        None if ui::interactive() => {
            let current = config::active_org_name(&ctx.home);
            let options: Vec<(String, Option<String>)> = orgs
                .iter()
                .map(|o| {
                    (
                        o.clone(),
                        (Some(o) == current.as_ref()).then(|| "actual".to_owned()),
                    )
                })
                .collect();
            let initial = orgs
                .iter()
                .position(|o| Some(o) == current.as_ref())
                .unwrap_or(0);
            orgs[ui::select("Organización activa", &options, initial)?].clone()
        }
        None => {
            return Err(fail(
                Kind::MissingInput,
                format!(
                    "Sin terminal interactiva indica la organización: {}",
                    orgs.join(", ")
                ),
            ));
        }
    };
    config::set_active_org(&ctx.home, &selected)?;
    if ctx.json {
        return print_json(&json!({"ok": true, "org": selected}));
    }
    ui::success(&format!("Organización activa: {selected}"));
    Ok(())
}

// -------------------------------------------------------------- create-version

pub async fn create_version(
    ctx: &Ctx,
    version: &str,
    deploy: Option<&str>,
    wait: bool,
) -> Result<()> {
    if !semver::is_semver_tag(version) {
        return Err(fail(
            Kind::Error,
            format!("Versión inválida: {version}. Usa semver con prefijo v, p.ej. v1.0.0."),
        ));
    }
    let repo = resolve_repo(ctx, "crear versiones")?;

    // Checked before creating the tag: a typo in the scope must not burn a version number.
    if let Some(scope) = deploy {
        let scopes = repo.api.list_scopes(&repo.repo).await?;
        if !scopes.iter().any(|s| s == scope) {
            return Err(fail(
                Kind::Error,
                format!(
                    "El scope {scope} no existe en {}. Disponibles: {}. No se creó la versión.",
                    repo.repo,
                    if scopes.is_empty() {
                        "ninguno".into()
                    } else {
                        scopes.join(", ")
                    }
                ),
            ));
        }
    }

    let branch = git::current_branch(&ctx.cwd)?;
    let (ahead, behind) = git::compare_with_remote(&ctx.cwd, &branch)?;
    if ahead > 0 && behind > 0 {
        return Err(fail(
            Kind::GitState,
            format!(
                "La rama local {branch} y la remota de {} divergen ({ahead} commit(s) locales, {behind} remotos). Sincronízalas antes de crear la versión.",
                repo.repo
            ),
        ));
    }
    if ahead > 0 {
        return Err(fail(
            Kind::GitState,
            format!("Sube los cambios a {} en la rama {branch}.", repo.repo),
        ));
    }
    if behind > 0 {
        return Err(fail(
            Kind::GitState,
            format!(
                "Tu rama local está atrasada: baja los cambios de {} en la rama {branch}.",
                repo.repo
            ),
        ));
    }
    if git::remote_tag_exists(&ctx.cwd, version)? {
        return Err(fail(
            Kind::GitState,
            format!("El tag {version} ya existe en {}.", repo.repo),
        ));
    }
    if git::local_tag_exists(&ctx.cwd, version) {
        return Err(fail(
            Kind::GitState,
            format!(
                "El tag {version} ya existe localmente. Bórralo con `git tag -d {version}` si no es válido."
            ),
        ));
    }

    let sha = git::git(&ctx.cwd, &["rev-parse", "HEAD"])?;
    git::git(&ctx.cwd, &["tag", "-a", version, "-m", version])?;
    git::git(
        &ctx.cwd,
        &["push", "origin", &format!("refs/tags/{version}")],
    )?;

    // Best effort: if keel is down or older than v0.4.0 the version still
    // exists, and keel learns of it when its CI reports.
    let (name, email) = git::identity(&ctx.cwd);
    let register_warning = match repo
        .api
        .register_version(&RegisterVersion {
            repo: &repo.repo,
            tag: version,
            sha: &sha,
            branch: &branch,
            created_by_name: name.as_deref(),
            created_by_email: email.as_deref(),
        })
        .await
    {
        Ok(_) => None,
        Err(error) if is_unsupported(&error) => Some("Tu servidor de keel es anterior a v0.4.0 y no registra versiones; la verá cuando llegue el resultado del CI.".to_owned()),
        Err(error) => Some(format!(
            "No se pudo registrar {version} en keel ({error:#}); la verá cuando llegue el resultado del CI."
        )),
    };

    // The tag is public now: a failed deploy request is reported, not thrown.
    let (deployed, deploy_error) = match deploy {
        Some(scope) => match repo
            .api
            .create_deploy(&CreateDeploy {
                repo: &repo.repo,
                tag: version,
                sha: &sha,
                scope,
                force_reason: None,
            })
            .await
        {
            Ok(d) => (Some(d), None),
            Err(error) => (
                None,
                Some(format!(
                    "No se pudo pedir el deploy a {scope}: {error:#} Pídelo con `keel deploy -s {scope} -v {version}`."
                )),
            ),
        },
        None => (None, None),
    };

    if ctx.json {
        print_json(&json!({
            "ok": deploy_error.is_none(), "tag": version, "repo": repo.repo, "branch": branch, "sha": sha,
            "registerWarning": register_warning, "deploy": deployed, "deployError": deploy_error,
        }))?;
    } else {
        ui::success(&format!(
            "{version} publicado en {} ({branch} @ {})",
            repo.repo,
            &sha[..7.min(sha.len())]
        ));
        if let Some(warning) = &register_warning {
            ui::warn(warning);
        }
        match (&deployed, &deploy_error) {
            (Some(d), _) => ui::success(&format!(
                "Deploy {} encolado: {} → {} ({})",
                d.id,
                d.tag,
                d.scope,
                status_name(d.status)
            )),
            (None, Some(_)) => {}
            (None, None) => ui::info(&format!(
                "Para desplegarla: keel deploy -s <scope> -v {version}"
            )),
        }
    }
    if let Some(error) = deploy_error {
        return Err(fail(Kind::Error, error));
    }
    if let (Some(d), true) = (deployed, wait) {
        wait_for(ctx, &repo, d).await?;
    }
    Ok(())
}

pub(crate) fn status_name(status: DeployStatus) -> &'static str {
    match status {
        DeployStatus::WaitingCi => "waiting_ci",
        DeployStatus::CiPassed => "ci_passed",
        DeployStatus::Deploying => "deploying",
        DeployStatus::Deployed => "deployed",
        DeployStatus::CiFailed => "ci_failed",
        DeployStatus::DeployFailed => "deploy_failed",
        DeployStatus::Expired => "expired",
    }
}

// --------------------------------------------------------------------- deploy

pub struct DeployArgs {
    pub scope: Option<String>,
    pub version: Option<String>,
    pub latest: bool,
    pub latest_ready: bool,
    pub wait: bool,
    pub rollback_on_failure: bool,
    /// Deploy even inside a freeze window, with this reason.
    pub force_freeze: Option<String>,
}

/// Which tag `deploy` picks, given the remote tags and what keel knows.
pub fn pick_tag<'a>(
    semver_tags: &'a [String],
    known: Option<&'a [Version]>,
    remote: &HashMap<String, String>,
    latest: bool,
    latest_ready: bool,
) -> Result<Option<&'a str>> {
    if latest_ready {
        let Some(known) = known else {
            return Err(fail(
                Kind::KeelUnreachable,
                "Tu servidor de keel es anterior a v0.4.0 y no sabe qué versiones pasaron su CI. Usa -v <versión>.",
            ));
        };
        // Only versions still on the remote: a deleted tag can't be deployed.
        let present: Vec<Version> = known
            .iter()
            .filter(|v| remote.contains_key(&v.tag))
            .cloned()
            .collect();
        return Ok(views::latest_ready(&present).and_then(|v| {
            known
                .iter()
                .find(|k| k.tag == v.tag)
                .map(|k| k.tag.as_str())
        }));
    }
    if latest {
        return Ok(semver_tags.first().map(String::as_str));
    }
    Ok(None)
}

pub async fn deploy(ctx: &Ctx, args: DeployArgs) -> Result<()> {
    if [args.latest, args.latest_ready, args.version.is_some()]
        .iter()
        .filter(|x| **x)
        .count()
        > 1
    {
        return Err(fail(
            Kind::Error,
            "Usa solo una de --latest, --latest-ready o --version.",
        ));
    }
    let repo = resolve_repo(ctx, "desplegar")?;
    let scopes = repo.api.list_scopes(&repo.repo).await?;
    if scopes.is_empty() {
        return Err(fail(
            Kind::Error,
            format!(
                "La app {} no tiene scopes. Agrégalos en el admin de keel.",
                repo.repo
            ),
        ));
    }
    let target = match args.scope {
        Some(s) => s,
        None if ui::interactive() => {
            let options: Vec<(String, Option<String>)> =
                scopes.iter().map(|s| (s.clone(), None)).collect();
            scopes[ui::select("Scope", &options, 0)?].clone()
        }
        None => return Err(need_terminal("el scope con -s")),
    };
    if !scopes.contains(&target) {
        return Err(fail(
            Kind::Error,
            format!(
                "El scope {target} no existe en {}. Disponibles: {}.",
                repo.repo,
                scopes.join(", ")
            ),
        ));
    }

    let tags = git::remote_tags(&ctx.cwd)?;
    let mut semver_tags: Vec<String> = tags
        .keys()
        .filter(|t| semver::is_semver_tag(t))
        .cloned()
        .collect();
    semver_tags.sort_by(|a, b| semver::compare_desc(a, b));
    if semver_tags.is_empty() {
        return Err(fail(
            Kind::Error,
            format!(
                "{} no tiene versiones. Crea una con `keel create-version`.",
                repo.repo
            ),
        ));
    }
    let known = repo
        .api
        .list_versions(&repo.repo, Some(VERSION_LOOKUP))
        .await?;
    let by_tag: HashMap<&str, &Version> = known
        .iter()
        .flatten()
        .map(|v| (v.tag.as_str(), v))
        .collect();

    let tag = match pick_tag(
        &semver_tags,
        known.as_deref(),
        &tags,
        args.latest,
        args.latest_ready,
    )? {
        Some(tag) => tag.to_owned(),
        None if args.latest_ready => {
            return Err(fail(
                Kind::Error,
                format!("{} no tiene ninguna versión con el CI en verde.", repo.repo),
            ));
        }
        None => match args.version {
            Some(v) => v,
            None if ui::interactive() => {
                let choices: Vec<(String, Option<String>)> = semver_tags
                    .iter()
                    .take(VERSION_CHOICES)
                    .map(|t| {
                        (
                            t.clone(),
                            by_tag
                                .get(t.as_str())
                                .map(|v| views::ci_hint(v.ci_status).to_owned()),
                        )
                    })
                    .collect();
                semver_tags[ui::select("Versión", &choices, 0)?].clone()
            }
            None => return Err(need_terminal("la versión con -v, -l o -r")),
        },
    };
    let Some(sha) = tags.get(&tag) else {
        return Err(fail(
            Kind::Error,
            format!("La versión {tag} no existe en {}.", repo.repo),
        ));
    };

    let info = by_tag.get(tag.as_str()).copied();
    let mut created_by_other = false;
    if let (true, Some(info)) = (args.latest, info)
        && let Some(author_email) = &info.created_by_email
    {
        let (_, me) = git::identity(&ctx.cwd);
        created_by_other = me
            .as_ref()
            .is_some_and(|m| !m.eq_ignore_ascii_case(author_email));
        if created_by_other && ui::interactive() && !ctx.json {
            let who = info.author().unwrap_or(author_email);
            if !ui::confirm(&format!(
                "{tag} es la última versión, pero la creó {who}. ¿Desplegarla en {target}?"
            ))? {
                return Err(fail(
                    Kind::Cancelled,
                    "Cancelado. Para desplegar una versión concreta usa -v <versión>.",
                ));
            }
        }
    }

    let previous = if args.rollback_on_failure {
        running(&repo, &target).await?
    } else {
        None
    };
    let created = repo
        .api
        .create_deploy(&CreateDeploy {
            repo: &repo.repo,
            tag: &tag,
            sha,
            scope: &target,
            force_reason: args
                .force_freeze
                .as_deref()
                .map(str::trim)
                .filter(|r| !r.is_empty()),
        })
        .await?;
    let waits = args.wait || args.rollback_on_failure;
    if ctx.json {
        // With --wait only the final state is printed, so stdout is one JSON document.
        if !waits {
            print_json(
                &json!({"deploy": created, "version": info, "createdByOther": created_by_other}),
            )?;
        }
    } else {
        if let Some(info) = info {
            ui::info(&views::describe_version(info, &ctx.view()));
        }
        if created_by_other && !ui::interactive() {
            ui::warn("La creó otra persona. Si querías la tuya, despliégala con -v <versión>.");
        }
        ui::success(&format!(
            "Deploy {} encolado: {} → {} ({})",
            created.id,
            created.tag,
            created.scope,
            status_name(created.status)
        ));
        if let (Some(by), Some(reason)) = (&created.forced_by, &created.forced_reason) {
            ui::warn(&format!(
                "Forzado dentro de una ventana de congelamiento por {by}: {reason}. Queda en la auditoría."
            ));
        }
        if created.awaiting_approval() {
            ui::info(&format!(
                "Este scope pide aprobación: otro maintainer debe correr `keel approve {}` (o aprobarlo en el admin).",
                short(&created.id)
            ));
        }
        if created.status == DeployStatus::CiFailed {
            ui::warn(
                created
                    .error
                    .as_deref()
                    .unwrap_or("El CI de esta versión falló."),
            );
        }
    }
    if waits {
        watch(ctx, &repo, created, previous, args.rollback_on_failure).await?;
    }
    Ok(())
}

/// Follows a deploy until it ends; a failed end is a `ci_failed` error.
pub(crate) async fn wait_for(ctx: &Ctx, repo: &Repo, deploy: Deploy) -> Result<()> {
    let deploy = wait_until_done(ctx, repo, deploy).await?;
    // A failure prints its own JSON error, with the deploy in its details.
    if ctx.json && !deploy.status.is_failure() {
        print_json(&json!({"deploy": deploy}))?;
    }
    finish(ctx, deploy)
}

/// Polls a deploy until it reaches a final state, printing each change.
pub(crate) async fn wait_until_done(ctx: &Ctx, repo: &Repo, mut deploy: Deploy) -> Result<Deploy> {
    let mut last = deploy.status;
    if !ctx.json {
        ui::info(&format!(
            "Esperando a que {} termine (Ctrl-C deja de esperar; el deploy sigue)…",
            short(&deploy.id)
        ));
    }
    while !deploy.status.is_terminal() {
        tokio::select! {
            _ = tokio::time::sleep(poll_interval()) => {}
            _ = tokio::signal::ctrl_c() => {
                return Err(fail(Kind::Cancelled, format!("Dejé de esperar; revisa el deploy con `keel deploys {}`.", short(&deploy.id))));
            }
        }
        deploy = repo.api.get_deploy(&deploy.id).await?;
        if deploy.status != last && !ctx.json {
            let style = views::deploy_style(deploy.status);
            println!(
                "{} {}",
                style.paint.apply(&ctx.colors(), style.icon),
                style.label
            );
        }
        last = deploy.status;
    }
    Ok(deploy)
}

/// How often `--wait` asks keel; `KEEL_POLL_MS` shortens it in tests.
fn poll_interval() -> Duration {
    std::env::var("KEEL_POLL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(Duration::from_secs(5), Duration::from_millis)
}

pub(crate) fn short(id: &str) -> &str {
    &id[..8.min(id.len())]
}

fn deploy_failure(deploy: &Deploy) -> String {
    format!(
        "El deploy {} terminó en {}{}. Detalle: keel deploys {} --log",
        short(&deploy.id),
        status_name(deploy.status),
        deploy
            .error
            .as_deref()
            .map(|e| format!(": {e}"))
            .unwrap_or_default(),
        short(&deploy.id)
    )
}

/// A finished deploy: an error if it failed, a success line otherwise.
fn finish(ctx: &Ctx, deploy: Deploy) -> Result<()> {
    if deploy.status.is_failure() {
        return Err(fail_with(
            Kind::CiFailed,
            deploy_failure(&deploy),
            json!({"deploy": deploy}),
        ));
    }
    if !ctx.json {
        ui::success(&format!("{} desplegado en {}", deploy.tag, deploy.scope));
    }
    Ok(())
}

/// The version a scope runs now, as keel knows it: its newest `deployed`.
pub(crate) async fn running(repo: &Repo, scope: &str) -> Result<Option<Deploy>> {
    Ok(repo
        .api
        .list_deploys(&repo.repo, Some(scope), Some(50))
        .await?
        .into_iter()
        .find(|d| d.status == DeployStatus::Deployed))
}

/// Waits for a deploy and, if it ends `deploy_failed`, deploys `previous`
/// again and waits for that too. Fails with the deploy's failure either way.
pub(crate) async fn watch(
    ctx: &Ctx,
    repo: &Repo,
    created: Deploy,
    previous: Option<Deploy>,
    rollback_on_failure: bool,
) -> Result<()> {
    if !rollback_on_failure {
        return wait_for(ctx, repo, created).await;
    }
    let done = wait_until_done(ctx, repo, created).await?;
    // ci_failed and expired never reached Dokploy: nothing to undo.
    let previous = previous.filter(|p| p.tag != done.tag || p.sha != done.sha);
    let (DeployStatus::DeployFailed, Some(previous)) = (done.status, previous) else {
        if done.status == DeployStatus::DeployFailed && !ctx.json {
            ui::warn("No hay una versión anterior desplegada con keel: no se hace rollback.");
        }
        if ctx.json && !done.status.is_failure() {
            print_json(&json!({"deploy": done, "rollback": null}))?;
        }
        return finish(ctx, done);
    };
    if !ctx.json {
        ui::warn(&format!(
            "{} falló en {}; volviendo a {}…",
            done.tag, done.scope, previous.tag
        ));
    }
    let rollback = repo
        .api
        .create_deploy(&CreateDeploy {
            repo: &repo.repo,
            tag: &previous.tag,
            sha: &previous.sha,
            scope: &done.scope,
            force_reason: None,
        })
        .await?;
    let rollback = wait_until_done(ctx, repo, rollback).await?;
    let outcome = if rollback.status == DeployStatus::Deployed {
        format!("rollback a {} desplegado", previous.tag)
    } else {
        format!(
            "el rollback a {} también falló ({}): revisa {} a mano",
            previous.tag,
            status_name(rollback.status),
            done.scope
        )
    };
    Err(fail_with(
        Kind::CiFailed,
        format!("{} · {outcome}.", deploy_failure(&done)),
        json!({"deploy": done, "rollback": rollback}),
    ))
}

// ------------------------------------------------------------------- rollback

/// The deploy a rollback goes back to: the previous version the scope
/// reached `deployed` with, or `to`.
pub fn rollback_target<'a>(
    history: &'a [Deploy],
    scope: &str,
    to: Option<&str>,
) -> Result<(&'a Deploy, &'a Deploy)> {
    if let Some(in_flight) = history.iter().find(|d| !d.status.is_terminal()) {
        let short = &in_flight.id[..8.min(in_flight.id.len())];
        return Err(fail(
            Kind::Refused,
            format!(
                "Hay un deploy en curso en {scope} ({}, {short}). Espera a que termine o revísalo con `keel deploys {short}`.",
                in_flight.tag
            ),
        ));
    }
    let deployed: Vec<&Deploy> = history
        .iter()
        .filter(|d| d.status == DeployStatus::Deployed)
        .collect();
    let Some(current) = deployed.first().copied() else {
        return Err(fail(
            Kind::Refused,
            format!(
                "{scope} todavía no tiene ningún deploy exitoso con keel: no hay a qué volver."
            ),
        ));
    };
    let previous = match to {
        Some(to) => {
            if to == current.tag {
                return Err(fail(Kind::Refused, format!("{scope} ya está en {to}.")));
            }
            deployed.iter().copied().find(|d| d.tag == to).ok_or_else(|| {
                let mut tags: Vec<&str> = Vec::new();
                for d in &deployed {
                    if !tags.contains(&d.tag.as_str()) {
                        tags.push(&d.tag);
                    }
                }
                fail(
                    Kind::Refused,
                    format!(
                        "{to} nunca se desplegó en {scope}, así que no se puede volver a ella. Versiones que sí: {}.",
                        tags.join(", ")
                    ),
                )
            })?
        }
        None => deployed
            .iter()
            .copied()
            .find(|d| d.tag != current.tag)
            .ok_or_else(|| {
                fail(
                    Kind::Refused,
                    format!(
                        "{scope} solo ha tenido {}: no hay una versión anterior a la que volver.",
                        current.tag
                    ),
                )
            })?,
    };
    Ok((current, previous))
}

pub async fn rollback(
    ctx: &Ctx,
    scope: Option<String>,
    to: Option<String>,
    yes: bool,
    wait: bool,
) -> Result<()> {
    let repo = resolve_repo(ctx, "hacer rollback")?;
    let scopes = repo.api.list_scopes(&repo.repo).await?;
    if scopes.is_empty() {
        return Err(fail(
            Kind::Error,
            format!(
                "La app {} no tiene scopes. Agrégalos en el admin de keel.",
                repo.repo
            ),
        ));
    }
    let target = match scope {
        Some(s) => s,
        None if ui::interactive() => {
            let options: Vec<(String, Option<String>)> =
                scopes.iter().map(|s| (s.clone(), None)).collect();
            scopes[ui::select("Scope", &options, 0)?].clone()
        }
        None => return Err(need_terminal("el scope con -s")),
    };
    if !scopes.contains(&target) {
        return Err(fail(
            Kind::Error,
            format!(
                "El scope {target} no existe en {}. Disponibles: {}.",
                repo.repo,
                scopes.join(", ")
            ),
        ));
    }
    let history = repo
        .api
        .list_deploys(&repo.repo, Some(&target), Some(HISTORY))
        .await?;
    let (current, previous) = rollback_target(&history, &target, to.as_deref())?;
    let deployed_at = views::format_when(
        previous.finished().unwrap_or(&previous.updated_at),
        &ViewOptions::now(Colors::plain()),
        false,
    );
    let message = format!(
        "Rollback de {target}: {} → {} (desplegada {deployed_at})",
        current.tag, previous.tag
    );
    if !yes {
        if !ui::interactive() || ctx.json {
            return Err(fail(
                Kind::MissingInput,
                format!("Sin terminal interactiva hay que confirmar con -y. {message}"),
            ));
        }
        if !ui::confirm(&format!("{message}. ¿Continuar?"))? {
            return Err(fail(Kind::Cancelled, "Cancelado."));
        }
    }
    let created = repo
        .api
        .create_deploy(&CreateDeploy {
            repo: &repo.repo,
            tag: &previous.tag,
            sha: &previous.sha,
            scope: &target,
            force_reason: None,
        })
        .await?;
    if ctx.json {
        if !wait {
            print_json(
                &json!({"scope": target, "service": target, "from": current, "to": previous, "deploy": created}),
            )?;
        }
    } else {
        ui::success(&format!(
            "Rollback encolado: {target} {} → {} (deploy {}, {})",
            current.tag,
            previous.tag,
            &created.id[..8.min(created.id.len())],
            status_name(created.status)
        ));
    }
    if wait {
        wait_for(ctx, &repo, created).await?;
    }
    Ok(())
}

// ---------------------------------------------------- scopes/versions/deploys

pub async fn scopes(ctx: &Ctx) -> Result<()> {
    let repo = resolve_repo(ctx, "consultar scopes")?;
    if ctx.json {
        return print_json(&repo.api.list_scopes_raw(&repo.repo).await?);
    }
    let scopes = repo.api.list_scope_summaries(&repo.repo).await?;
    println!(
        "{}",
        views::render_scopes(&repo.header(), &scopes, &ctx.view())
    );
    Ok(())
}

pub async fn versions(ctx: &Ctx, limit: Option<u32>) -> Result<()> {
    validate_limit(limit)?;
    let repo = resolve_repo(ctx, "consultar versiones")?;
    let Some(list) = repo.api.list_versions(&repo.repo, limit).await? else {
        return Err(fail(
            Kind::KeelUnreachable,
            format!(
                "El servidor de keel en {} es anterior a v0.4.0 y no registra versiones.",
                repo.org.api_url
            ),
        ));
    };
    if ctx.json {
        return print_json(&list);
    }
    println!(
        "{}",
        views::render_version_list(&repo.header(), &list, &ctx.view())
    );
    Ok(())
}

pub async fn deploys(
    ctx: &Ctx,
    id: Option<String>,
    scope: Option<String>,
    limit: Option<u32>,
    log: bool,
    config_path: Option<PathBuf>,
    target: &Target,
) -> Result<()> {
    validate_limit(limit)?;
    if log && id.is_none() {
        return Err(fail(
            Kind::Error,
            "--log necesita el id de un deploy: keel deploys <id> --log",
        ));
    }
    let repo = resolve_repo(ctx, "consultar deploys")?;
    if let Some(id) = id {
        let detail = repo.api.get_repo_deploy(&repo.repo, &id).await?;
        let log_data = if log {
            Some(deploy_log_for(&repo, &detail.deploy, config_path, target).await?)
        } else {
            None
        };
        if ctx.json {
            let mut out = serde_json::to_value(&detail)?;
            if let Some(data) = log_data {
                out["log"] = data;
            }
            return print_json(&out);
        }
        println!("{}", views::render_deploy_detail(&detail, &ctx.view()));
        if let Some(data) = log_data {
            println!();
            print_log_lines(ctx, &data);
        }
        return Ok(());
    }
    let list = repo
        .api
        .list_deploys(&repo.repo, scope.as_deref(), limit)
        .await?;
    if ctx.json {
        return print_json(&list);
    }
    println!(
        "{}",
        views::render_deploy_list(&repo.header(), &list, scope.as_deref(), &ctx.view())
    );
    Ok(())
}

/// The scope's Dokploy service, by the id keel stores for it.
pub(crate) async fn scope_service(repo: &Repo, alias: &str) -> Result<ScopeSummary> {
    let scopes = repo.api.list_scope_summaries(&repo.repo).await?;
    let scope = scopes
        .into_iter()
        .find(|s| s.alias == alias)
        .ok_or_else(|| {
            fail(
                Kind::ServiceNotFound,
                format!("El scope {alias} no existe en {}.", repo.repo),
            )
        })?;
    if scope.dokploy_id.is_none() {
        return Err(fail(
            Kind::KeelUnreachable,
            "Tu servidor de keel es anterior a v0.5.0 y no dice qué servicio de Dokploy es cada scope.",
        ));
    }
    Ok(scope)
}

/// The Dokploy client for keel's Dokploy, from the local Dokploy config.
pub(crate) fn dokploy_client(config: &Config, target: &Target) -> Result<DokployClient> {
    let instance = target.resolve(config)?;
    DokployClient::new(instance)
}

async fn deploy_log_for(
    repo: &Repo,
    deploy: &Deploy,
    config_path: Option<PathBuf>,
    target: &Target,
) -> Result<Value> {
    let config = load_config(config_path)?;
    let client = dokploy_client(&config, target)?;
    let scope = scope_service(repo, &deploy.scope).await?;
    let id = scope.dokploy_id.clone().unwrap_or_default();
    let after = deploy
        .deploy_started_at
        .clone()
        .unwrap_or_else(|| deploy.created_at.clone());
    if deploy.deploy_started_at.is_none() {
        return Ok(
            json!({"note": "keel nunca envió este deploy a Dokploy (no pasó del CI): no hay log de Dokploy", "lines": []}),
        );
    }
    fetch_deploy_log(
        &config,
        &client,
        &ServiceRef::Id(id),
        None,
        Some(&after),
        200,
        None,
    )
    .await
}

fn print_log_lines(ctx: &Ctx, data: &Value) {
    let c = ctx.colors();
    if let Some(note) = data.get("note").and_then(Value::as_str) {
        println!("{}", c.dim(note));
    }
    for line in data["lines"].as_array().into_iter().flatten() {
        println!(
            "{}  {}",
            c.dim(line["ts"].as_str().unwrap_or("")),
            line["line"].as_str().unwrap_or("")
        );
    }
}

// ----------------------------------------------------------------- logs -s

pub struct LogsArgs {
    pub scope: Option<String>,
    pub container: Option<String>,
    pub follow: bool,
    pub tail: u32,
    pub since: String,
    pub search: Option<String>,
}

pub async fn logs(
    ctx: &Ctx,
    args: LogsArgs,
    config_path: Option<PathBuf>,
    target: &Target,
) -> Result<()> {
    let repo = resolve_repo(ctx, "leer logs")?;
    let scopes = repo.api.list_scopes(&repo.repo).await?;
    let alias = match args.scope {
        Some(s) => s,
        None if ui::interactive() && !scopes.is_empty() => {
            let options: Vec<(String, Option<String>)> =
                scopes.iter().map(|s| (s.clone(), None)).collect();
            scopes[ui::select("Scope", &options, 0)?].clone()
        }
        None => return Err(need_terminal("el scope con -s")),
    };
    let scope = scope_service(&repo, &alias).await?;
    let config = load_config(config_path)?;
    let client = dokploy_client(&config, target)?;
    let service = ServiceRef::Id(scope.dokploy_id.unwrap_or_default());
    if args.follow {
        return follow_logs(
            &config,
            &client,
            &service,
            args.container.as_deref(),
            args.search.as_deref(),
            if ctx.json {
                FollowOutput::Json
            } else {
                FollowOutput::Text
            },
        )
        .await;
    }
    let data = fetch_logs(
        &config,
        &client,
        &service,
        args.container.as_deref(),
        args.tail,
        &args.since,
        args.search.as_deref(),
    )
    .await?;
    if ctx.json {
        return print_json(&data);
    }
    print_log_lines(ctx, &data);
    Ok(())
}

// --------------------------------------------------------------------- status

pub async fn status(ctx: &Ctx, config_path: Option<PathBuf>, target: &Target) -> Result<()> {
    let repo = resolve_repo(ctx, "consultar el estado")?;
    let (scopes, versions, recent, who) = tokio::try_join!(
        repo.api.list_scope_summaries(&repo.repo),
        repo.api.list_versions(&repo.repo, Some(20)),
        repo.api.list_deploys(&repo.repo, None, Some(50)),
        repo.api.whoami(),
    )?;
    let user = who.as_ref().and_then(WhoAmI::label);
    let in_flight: Vec<&Deploy> = recent.iter().filter(|d| !d.status.is_terminal()).collect();

    // What Dokploy says about each scope, when there is a Dokploy key here.
    let mut dokploy: HashMap<String, String> = HashMap::new();
    let note = match load_config(config_path).and_then(|config| {
        let client = dokploy_client(&config, target)?;
        Ok((config, client))
    }) {
        Ok((_, client)) => {
            for scope in &scopes {
                if let (Some(id), Some(kind)) = (&scope.dokploy_id, &scope.kind) {
                    let (procedure, param, field) = match kind.as_str() {
                        "compose" => ("compose.one", "composeId", "composeStatus"),
                        _ => ("application.one", "applicationId", "applicationStatus"),
                    };
                    if let Ok(detail) = client
                        .get_procedure(procedure, &[(param, id.as_str())])
                        .await
                        && let Some(state) = detail.get(field).and_then(Value::as_str)
                    {
                        dokploy.insert(scope.alias.clone(), state.to_owned());
                    }
                }
            }
            None
        }
        Err(_) => {
            Some("sin key de Dokploy en esta máquina: la columna DOKPLOY queda vacía".to_owned())
        }
    };

    if ctx.json {
        return print_json(&json!({
            "repo": repo.repo, "org": repo.org.org,
            "scopes": scopes.iter().map(|s| json!({
                "scope": s.alias, "current": s.current.as_ref().map(|d| &d.tag),
                "last": s.last, "dokploy_status": dokploy.get(&s.alias),
                "dokploy_name": s.dokploy_name,
            })).collect::<Vec<_>>(),
            "latest_version": versions.as_ref().and_then(|v| v.first()),
            "latest_ready": versions.as_deref().and_then(views::latest_ready).map(|v| &v.tag),
            "in_flight": in_flight,
            "note": note,
            "user": user,
            "locks": scopes.iter().filter_map(|s| s.lock.as_ref().map(|l| json!({"scope": s.alias, "lock": l}))).collect::<Vec<_>>(),
        }));
    }
    let rows: Vec<StatusRow> = scopes
        .iter()
        .map(|s| StatusRow {
            scope: s,
            dokploy_status: dokploy.get(&s.alias).cloned(),
        })
        .collect();
    println!(
        "{}",
        views::render_status(
            &repo.header(),
            &rows,
            versions.as_deref(),
            &in_flight,
            note.as_deref(),
            &ctx.view(),
        )
    );
    for scope in &scopes {
        if let Some(lock) = &scope.lock {
            ui::warn(&format!(
                "{} {}",
                scope.alias,
                views::lock_text(lock, &ctx.view())
            ));
        }
    }
    if let Some(user) = user {
        println!("  {}", ctx.colors().dim(&format!("sesión: {user}")));
    }
    Ok(())
}

/// The keel half of `keel context`: org, repo and server for this directory.
pub fn context_info(cwd: &Path, home: &Path) -> Value {
    let org = config::active_org(home, None).ok();
    let origin = git::origin(cwd).ok();
    let linked = match (&org, &origin) {
        (Some(org), Some(origin)) => {
            origin.host == "github.com" && origin.owner.eq_ignore_ascii_case(org.owner())
        }
        _ => false,
    };
    json!({
        "org": org.as_ref().map(|o| &o.org),
        "api_url": org.as_ref().map(|o| &o.api_url),
        "repo": origin.as_ref().map(|o| o.slug()),
        "origin_host": origin.as_ref().map(|o| &o.host),
        "repo_in_org": linked,
        "configured_orgs": config::list_orgs(home).unwrap_or_default(),
        "hint": match (&org, &origin, linked) {
            (None, _, _) => Some("sin organización activa: `keel login` o `keel use`"),
            (_, None, _) => Some("la carpeta no es un repo de GitHub: los comandos de versiones y deploys no aplican aquí"),
            (_, _, false) => Some("el repo es de otra organización: `keel use`"),
            _ => None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deploy(tag: &str, status: DeployStatus) -> Deploy {
        Deploy {
            id: format!("id-{tag}-xxxxxxxx"),
            repo: "acme/app".into(),
            tag: tag.into(),
            sha: format!("sha{tag}"),
            scope: "prod".into(),
            service: "prod".into(),
            status,
            error: None,
            created_at: "2026-10-25T21:27:00Z".into(),
            updated_at: "2026-10-25T21:27:09Z".into(),
            ci_passed_at: None,
            deploy_started_at: None,
            finished_at: None,
            requested_by: None,
            forced_by: None,
            forced_reason: None,
            approval: None,
        }
    }

    #[test]
    fn rollback_skips_failures_and_the_current_version() {
        let history = [
            deploy("v1.3.0", DeployStatus::Deployed),
            deploy("v1.3.0", DeployStatus::Deployed),
            deploy("v1.2.1", DeployStatus::DeployFailed),
            deploy("v1.2.0", DeployStatus::Deployed),
        ];
        let (current, previous) = rollback_target(&history, "prod", None).unwrap();
        assert_eq!(
            (current.tag.as_str(), previous.tag.as_str()),
            ("v1.3.0", "v1.2.0")
        );
        assert!(rollback_target(&history, "prod", Some("v1.2.1")).is_err());
        assert!(rollback_target(&history, "prod", Some("v1.3.0")).is_err());
        assert_eq!(
            rollback_target(&history, "prod", Some("v1.2.0"))
                .unwrap()
                .1
                .tag,
            "v1.2.0"
        );
    }

    #[test]
    fn rollback_waits_for_deploys_in_flight() {
        let history = [
            deploy("v1.4.0", DeployStatus::Deploying),
            deploy("v1.3.0", DeployStatus::Deployed),
        ];
        assert!(rollback_target(&history, "prod", None).is_err());
    }
}
