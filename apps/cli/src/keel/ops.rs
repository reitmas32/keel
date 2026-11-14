//! Commands added on top of the TypeScript CLI's: `lock`/`unlock`, `promote`
//! and `changes`.

use crate::dokploy::print_json;
use crate::failure::{Kind, fail};
use crate::keel::api::{CreateDeploy, ScopeSummary};
use crate::keel::commands::{Ctx, Repo, need_terminal, resolve_repo, short, status_name, watch};
use crate::keel::{git, semver, views};
use crate::ui;
use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use serde_json::json;
use std::sync::LazyLock;

// ---------------------------------------------------------------- lock/unlock

async fn scope_summaries(repo: &Repo) -> Result<Vec<ScopeSummary>> {
    repo.api.list_scope_summaries(&repo.repo).await
}

/// The scope named with -s, or one picked at the terminal.
async fn pick_scope(repo: &Repo, scope: Option<String>, prompt: &str) -> Result<String> {
    let aliases = repo.api.list_scopes(&repo.repo).await?;
    let scope = match scope {
        Some(s) => s,
        None if ui::interactive() && !aliases.is_empty() => {
            let options: Vec<(String, Option<String>)> =
                aliases.iter().map(|s| (s.clone(), None)).collect();
            aliases[ui::select(prompt, &options, 0)?].clone()
        }
        None => return Err(need_terminal("el scope con -s")),
    };
    if !aliases.contains(&scope) {
        return Err(fail(
            Kind::ServiceNotFound,
            format!(
                "El scope {scope} no existe en {}. Disponibles: {}.",
                repo.repo,
                if aliases.is_empty() {
                    "ninguno".to_owned()
                } else {
                    aliases.join(", ")
                }
            ),
        ));
    }
    Ok(scope)
}

pub async fn lock(ctx: &Ctx, scope: Option<String>, reason: Option<String>) -> Result<()> {
    let repo = resolve_repo(ctx, "bloquear scopes")?;
    let scope = pick_scope(&repo, scope, "Scope a bloquear").await?;
    let reason = match reason {
        Some(r) => r,
        None if ui::interactive() && !ctx.json => {
            ui::ask("Motivo del bloqueo", "incidente en producción")?
        }
        None => return Err(need_terminal("el motivo con -m")),
    };
    let reason = reason.trim();
    if reason.is_empty() || reason.chars().count() > 500 {
        return Err(fail(
            Kind::Error,
            "El motivo debe tener entre 1 y 500 caracteres.",
        ));
    }
    let lock = repo.api.lock(&repo.repo, &scope, reason).await?;
    if ctx.json {
        return print_json(&json!({"ok": true, "scope": scope, "lock": lock}));
    }
    ui::success(&format!(
        "{scope} bloqueado: keel rechaza sus deploys hasta `keel unlock -s {scope}`."
    ));
    Ok(())
}

pub async fn unlock(ctx: &Ctx, scope: Option<String>) -> Result<()> {
    let repo = resolve_repo(ctx, "desbloquear scopes")?;
    let scope = pick_scope(&repo, scope, "Scope a desbloquear").await?;
    let was_locked = repo.api.unlock(&repo.repo, &scope).await?;
    if ctx.json {
        return print_json(&json!({"ok": true, "scope": scope, "wasLocked": was_locked}));
    }
    if was_locked {
        ui::success(&format!("{scope} desbloqueado: ya acepta deploys."));
    } else {
        ui::info(&format!("{scope} no estaba bloqueado."));
    }
    Ok(())
}

// ------------------------------------------------------------ approve/reject

/// Approves (or rejects, with a reason) someone else's deploy waiting for approval.
pub async fn decide(ctx: &Ctx, id: String, approve: bool, reason: Option<String>) -> Result<()> {
    let repo = resolve_repo(
        ctx,
        if approve {
            "aprobar deploys"
        } else {
            "rechazar deploys"
        },
    )?;
    let reason = match reason {
        Some(r) => Some(r),
        None if !approve && ui::interactive() && !ctx.json => {
            Some(ui::ask("Motivo del rechazo", "falta revisar la migración")?)
        }
        None if !approve => return Err(need_terminal("el motivo con -m")),
        None => None,
    };
    let reason = reason.as_deref().map(str::trim).filter(|r| !r.is_empty());
    if reason.is_some_and(|r| r.chars().count() > 500) {
        return Err(fail(
            Kind::Error,
            "El motivo puede tener hasta 500 caracteres.",
        ));
    }
    if !approve && reason.is_none() {
        return Err(fail(Kind::Error, "Escribe el motivo del rechazo con -m."));
    }
    let deploy = repo
        .api
        .decide_deploy(&repo.repo, &id, approve, reason)
        .await?;
    if ctx.json {
        return print_json(&json!({"ok": true, "deploy": deploy}));
    }
    if approve {
        ui::success(&format!(
            "Deploy {} aprobado: {} → {} sale en cuanto su CI pase.",
            short(&deploy.id),
            deploy.tag,
            deploy.scope
        ));
    } else {
        ui::success(&format!(
            "Deploy {} rechazado: {} → {} no se despliega.",
            short(&deploy.id),
            deploy.tag,
            deploy.scope
        ));
    }
    Ok(())
}

// --------------------------------------------------------------------- whoami

pub async fn whoami(ctx: &Ctx) -> Result<()> {
    let org = crate::keel::config::active_org(&ctx.home, ctx.org.as_deref())?;
    let api = crate::keel::api::KeelApi::for_org(&org)?;
    let Some(who) = api.whoami().await? else {
        return Err(fail(
            Kind::KeelUnreachable,
            "Este servidor de keel no tiene /whoami: actualízalo para usar tokens y roles.",
        ));
    };
    if ctx.json {
        return print_json(
            &json!({"ok": true, "org": org.org, "apiUrl": org.api_url, "token": api.has_token(), "whoami": who}),
        );
    }
    let c = ctx.colors();
    match who.label() {
        Some(label) => println!("{} {label}", c.bold("Eres")),
        None => println!(
            "{} sin token{}",
            c.bold("Eres anónimo:"),
            who.anonymous_role
                .as_deref()
                .map(|r| format!(", con rol {r}"))
                .unwrap_or_default()
        ),
    }
    if let Some(email) = &who.email {
        println!("  {}", c.dim(email));
    }
    println!("  {} · {}", org.org, org.api_url);
    if let Some(max) = &who.token_max_role {
        println!("  este token está limitado a {max}");
    }
    if !who.grants.is_empty() {
        println!("\n  {}", c.bold("Permisos por app / scope"));
        for g in &who.grants {
            println!("  {}  {} / {}", ui::pad_end(&g.role, 11), g.repo, g.scope);
        }
    }
    let auth = if who.auth == "required" {
        "esta instancia exige token"
    } else {
        "esta instancia acepta peticiones sin token"
    };
    println!("\n  {}", c.dim(auth));
    Ok(())
}

// -------------------------------------------------------------------- promote

pub struct PromoteArgs {
    pub from: String,
    pub to: String,
    pub wait: bool,
    pub rollback_on_failure: bool,
    pub yes: bool,
    pub force: bool,
}

pub async fn promote(ctx: &Ctx, args: PromoteArgs) -> Result<()> {
    if args.from == args.to {
        return Err(fail(
            Kind::Error,
            "--from y --to deben ser scopes distintos.",
        ));
    }
    let repo = resolve_repo(ctx, "promover versiones")?;
    let scopes = scope_summaries(&repo).await?;
    let find = |alias: &str| {
        scopes.iter().find(|s| s.alias == alias).ok_or_else(|| {
            fail(
                Kind::ServiceNotFound,
                format!(
                    "El scope {alias} no existe en {}. Disponibles: {}.",
                    repo.repo,
                    scopes
                        .iter()
                        .map(|s| s.alias.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )
        })
    };
    let source = find(&args.from)?;
    let target = find(&args.to)?;
    // Servers before v0.5.0 don't send `current`: read it from the history.
    let source_current = match &source.current {
        Some(d) => Some(d.clone()),
        None => crate::keel::commands::running(&repo, &args.from).await?,
    };
    let Some(version) = source_current else {
        return Err(fail(
            Kind::Refused,
            format!(
                "{} no tiene ninguna versión desplegada con keel: no hay nada que promover.",
                args.from
            ),
        ));
    };
    let target_current = match &target.current {
        Some(d) => Some(d.clone()),
        None => crate::keel::commands::running(&repo, &args.to).await?,
    };
    if let Some(current) = &target_current
        && current.tag == version.tag
        && current.sha == version.sha
        && !args.force
    {
        return Err(fail(
            Kind::Refused,
            format!(
                "{} ya corre {}. Usa --force para desplegarla otra vez.",
                args.to, version.tag
            ),
        ));
    }
    if let Some(lock) = &target.lock {
        return Err(fail(
            Kind::Locked,
            format!(
                "{} está {}. Desbloquéalo con `keel unlock -s {}`.",
                args.to,
                views::lock_text(lock, &ctx.view()),
                args.to
            ),
        ));
    }
    let message = format!(
        "Promover {} (commit {}) de {} a {} (ahora corre {})",
        version.tag,
        &version.sha[..7.min(version.sha.len())],
        args.from,
        args.to,
        target_current.as_ref().map_or("nada", |d| d.tag.as_str())
    );
    if !args.yes {
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
            tag: &version.tag,
            sha: &version.sha,
            scope: &args.to,
        })
        .await?;
    let waits = args.wait || args.rollback_on_failure;
    if ctx.json && !waits {
        print_json(
            &json!({"from": args.from, "to": args.to, "version": version.tag, "deploy": created}),
        )?;
    } else if !ctx.json {
        ui::success(&format!(
            "Deploy {} encolado: {} → {} ({})",
            short(&created.id),
            created.tag,
            created.scope,
            status_name(created.status)
        ));
    }
    if waits {
        watch(
            ctx,
            &repo,
            created,
            target_current,
            args.rollback_on_failure,
        )
        .await?;
    }
    Ok(())
}

// -------------------------------------------------------------------- changes

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub pr: Option<u64>,
}

static MERGE_PR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Merge pull request #(\d+)").unwrap());
static SQUASH_PR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(#(\d+)\)\s*$").unwrap());

/// The PR a commit subject names: GitHub's merge commits or squash `(#N)`.
pub fn pr_number(subject: &str) -> Option<u64> {
    MERGE_PR
        .captures(subject)
        .or_else(|| SQUASH_PR.captures(subject))
        .and_then(|c| c[1].parse().ok())
}

/// Parses `git log --format=%H%x1f%an%x1f%aI%x1f%s`.
pub fn parse_log(output: &str) -> Vec<Change> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\u{1f}');
            let sha = parts.next()?.to_owned();
            let author = parts.next()?.to_owned();
            let date = parts.next()?.to_owned();
            let subject = parts.next().unwrap_or_default().to_owned();
            Some(Change {
                pr: pr_number(&subject),
                sha,
                author,
                date,
                subject,
            })
        })
        .collect()
}

pub async fn changes(ctx: &Ctx, scope: Option<String>, version: Option<String>) -> Result<()> {
    let repo = resolve_repo(ctx, "comparar versiones")?;
    let scope = pick_scope(&repo, scope, "Scope").await?;
    let Some(current) = crate::keel::commands::running(&repo, &scope).await? else {
        return Err(fail(
            Kind::Refused,
            format!(
                "{scope} no tiene ninguna versión desplegada con keel: no hay desde dónde comparar."
            ),
        ));
    };
    // Best effort: offline still works with the tags already here.
    let _ = git::git_ok(&ctx.cwd, &["fetch", "--tags", "--quiet", "origin"]);
    let tag = match version {
        Some(v) => v,
        None => {
            let tags = git::git(&ctx.cwd, &["tag", "--list", "v*"])?;
            let mut tags: Vec<&str> = tags.lines().filter(|t| semver::is_semver_tag(t)).collect();
            tags.sort_by(|a, b| semver::compare_desc(a, b));
            tags.first()
                .map(|t| (*t).to_owned())
                .ok_or_else(|| fail(Kind::GitState, "El repo no tiene tags de versión (vX.Y.Z)."))?
        }
    };
    let to_sha =
        git::git(&ctx.cwd, &["rev-parse", &format!("{tag}^{{commit}}")]).map_err(|_| {
            fail(
                Kind::GitState,
                format!("La versión {tag} no existe en este repo (¿git fetch --tags?)."),
            )
        })?;
    if git::git_ok(
        &ctx.cwd,
        &["cat-file", "-e", &format!("{}^{{commit}}", current.sha)],
    )
    .is_none()
    {
        return Err(fail(
            Kind::GitState,
            format!(
                "El commit {} que corre {scope} no está en este clon; haz `git fetch` primero.",
                &current.sha[..7.min(current.sha.len())]
            ),
        ));
    }
    let format = "--format=%H%x1f%an%x1f%aI%x1f%s";
    let forward = parse_log(&git::git(
        &ctx.cwd,
        &["log", format, &format!("{}..{to_sha}", current.sha)],
    )?);
    // Going back (a rollback): what would leave the scope.
    let backward = parse_log(&git::git(
        &ctx.cwd,
        &["log", format, &format!("{to_sha}..{}", current.sha)],
    )?);
    let mut prs: Vec<u64> = forward.iter().filter_map(|c| c.pr).collect();
    prs.sort_unstable();
    prs.dedup();
    if ctx.json {
        return print_json(&json!({
            "scope": scope,
            "from": {"tag": current.tag, "sha": current.sha},
            "to": {"tag": tag, "sha": to_sha},
            "commits": forward, "removed": backward, "prs": prs,
        }));
    }
    let c = ctx.colors();
    println!(
        "{}  {scope}: {} → {}",
        c.cyan("◇"),
        c.bold(&current.tag),
        c.bold(&tag)
    );
    println!();
    if forward.is_empty() && backward.is_empty() {
        println!("  Sin cambios: {scope} ya corre ese código.");
    }
    for change in &forward {
        println!(
            "  {} {}  {}",
            c.green("+"),
            c.dim(&change.sha[..7.min(change.sha.len())]),
            change.subject
        );
    }
    for change in &backward {
        println!(
            "  {} {}  {}",
            c.red("-"),
            c.dim(&change.sha[..7.min(change.sha.len())]),
            change.subject
        );
    }
    println!();
    let mut summary = format!("{} commit(s) nuevos", forward.len());
    if !backward.is_empty() {
        summary.push_str(&format!(" · {} se irían (rollback)", backward.len()));
    }
    if !prs.is_empty() {
        summary.push_str(&format!(
            " · PRs: {}",
            prs.iter()
                .map(|n| format!("#{n}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    println!("  {summary}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_pr_numbers() {
        assert_eq!(pr_number("Merge pull request #42 from acme/feat"), Some(42));
        assert_eq!(pr_number("feat: add login (#17)"), Some(17));
        assert_eq!(pr_number("fix: typo #3 in docs"), None);
        assert_eq!(pr_number("chore: bump"), None);
    }

    #[test]
    fn parses_git_log() {
        let out = "abc\u{1f}Ana\u{1f}2026-11-01T10:00:00Z\u{1f}feat: x (#5)\ndef\u{1f}Leo\u{1f}2026-11-02T10:00:00Z\u{1f}fix: y | z";
        let changes = parse_log(out);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].pr, Some(5));
        assert_eq!(changes[1].subject, "fix: y | z");
        assert_eq!(changes[1].author, "Leo");
    }
}
