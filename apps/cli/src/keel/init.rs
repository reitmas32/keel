//! `keel init`: prepares a repo for keel releases (the workflow that reports
//! CI to keel) and audits what is still missing. Never writes secrets.

use crate::dokploy::print_json;
use crate::failure::{Kind, fail, fail_with};
use crate::keel::api::{KeelApi, is_unsupported};
use crate::keel::commands::Ctx;
use crate::keel::{config, git};
use crate::ui;
use anyhow::Result;
use serde_json::{Value, json};
use std::path::Path;
use std::process::Command;

/// The workflow every repo deployed with keel runs on its version tags.
pub const WORKFLOW: &str = include_str!("../../../../templates/github/keel-release.yml");
pub const WORKFLOW_PATH: &str = ".github/workflows/keel-release.yml";

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

/// The names in the first column of `gh secret list` / `gh variable list`.
pub fn gh_names(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_owned)
        .collect()
}

/// `gh` (or `KEEL_GH`), if it runs.
fn gh(args: &[&str], cwd: &Path) -> Option<String> {
    let program = std::env::var("KEEL_GH").unwrap_or_else(|_| "gh".to_owned());
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The admin URL for an API URL: same origin, `/scopes`.
pub fn admin_url(api_url: &str) -> String {
    url::Url::parse(api_url)
        .map(|u| format!("{}/scopes", u.origin().ascii_serialization()))
        .unwrap_or_else(|_| api_url.to_owned())
}

pub async fn init(ctx: &Ctx, check: bool, force: bool) -> Result<()> {
    let root = git::git(&ctx.cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| {
        fail(
            Kind::GitState,
            "keel init se ejecuta dentro de un repo de git.",
        )
    })?;
    let root = Path::new(&root);
    let origin = git::origin(root)?;
    let repo = origin.slug();
    let mut problems: Vec<String> = Vec::new();

    // 1. The workflow.
    let state = workflow_state(root);
    let mut workflow = json!({"path": WORKFLOW_PATH});
    match state {
        FileState::Missing if check => {
            workflow["status"] = json!("missing");
            problems.push(format!("Falta {WORKFLOW_PATH}: créalo con `keel init`."));
        }
        FileState::Missing => {
            let path = root.join(WORKFLOW_PATH);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, WORKFLOW)?;
            workflow["status"] = json!("created");
        }
        FileState::Same => workflow["status"] = json!("up_to_date"),
        FileState::Customized if force && !check => {
            std::fs::write(root.join(WORKFLOW_PATH), WORKFLOW)?;
            workflow["status"] = json!("replaced");
        }
        FileState::Customized => {
            let current = std::fs::read_to_string(root.join(WORKFLOW_PATH))?;
            let diff = similar::TextDiff::from_lines(current.as_str(), WORKFLOW)
                .unified_diff()
                .header(WORKFLOW_PATH, "plantilla de keel")
                .to_string();
            workflow["status"] = json!("customized");
            workflow["diff"] = json!(diff);
            if !check {
                if !ctx.json {
                    println!("{diff}");
                }
                return Err(fail_with(
                    Kind::Refused,
                    format!(
                        "{WORKFLOW_PATH} ya existe y no es la plantilla (diff arriba). Usa --force para reemplazarlo; un workflow adaptado (p. ej. con tus tests) es normal."
                    ),
                    json!({"workflow": workflow}),
                ));
            }
        }
    }

    // 2. The repo is a scope in keel.
    let org = config::active_org(&ctx.home, ctx.org.as_deref());
    let keel = match &org {
        Err(error) => {
            problems.push(format!("{error:#}"));
            json!({"linked": null})
        }
        Ok(org) => match KeelApi::for_org(org)?.list_services(&repo).await {
            Ok(services) => {
                if services.is_empty() {
                    problems.push(format!(
                        "{repo} no tiene servicios de Dokploy vinculados: agrégalos en {}.",
                        admin_url(&org.api_url)
                    ));
                }
                json!({"linked": true, "api_url": org.api_url, "scopes": services})
            }
            Err(error)
                if !is_unsupported(&error)
                    && crate::failure::report(&error).0["error"]["details"]["http_status"]
                        == 404 =>
            {
                problems.push(format!(
                    "{repo} no está vinculado en keel: crea su scope en {} y guarda el token de CI que te muestra.",
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

    // 3. The secret and the variable the workflow reads (names only).
    let github = match (
        gh(&["secret", "list", "--repo", &repo], root),
        gh(&["variable", "list", "--repo", &repo], root),
    ) {
        (Some(secrets), variables) => {
            let secrets = gh_names(&secrets);
            let has_token = secrets.iter().any(|s| s == "DEPLOY_API_TOKEN");
            if !has_token {
                problems.push(format!(
                    "Falta el secret DEPLOY_API_TOKEN en {repo}: `gh secret set DEPLOY_API_TOKEN --repo {repo}` con el token de CI del scope."
                ));
            }
            let has_url = variables
                .as_deref()
                .map(gh_names)
                .map(|v| v.iter().any(|n| n == "KEEL_API_URL"));
            if has_url == Some(false) {
                let api = org
                    .as_ref()
                    .map_or("<url de la API>", |o| o.api_url.as_str());
                problems.push(format!(
                    "Falta la variable KEEL_API_URL en {repo} (si no está a nivel organización): `gh variable set KEEL_API_URL --repo {repo} --body {api}`."
                ));
            }
            json!({"checked": true, "DEPLOY_API_TOKEN": has_token, "KEEL_API_URL": has_url})
        }
        (None, _) => json!({"checked": false,
            "note": "gh no está disponible o no tiene acceso: revisa a mano el secret DEPLOY_API_TOKEN y la variable KEEL_API_URL"}),
    };

    let report = json!({
        "ok": problems.is_empty(), "repo": repo, "workflow": workflow,
        "keel": keel, "github": github, "problems": problems,
    });
    if check && !problems.is_empty() {
        if !ctx.json {
            print_report(&report);
        }
        return Err(fail_with(
            Kind::Config,
            format!(
                "{repo} todavía no está listo para keel ({} pendiente(s)).",
                problems.len()
            ),
            report,
        ));
    }
    if ctx.json {
        return print_json(&report);
    }
    print_report(&report);
    Ok(())
}

fn print_report(report: &Value) {
    let c = ui::stdout_colors();
    let status = report["workflow"]["status"].as_str().unwrap_or("");
    let line = match status {
        "created" => format!(
            "{} {WORKFLOW_PATH} creado: ajusta su paso de tests y haz commit.",
            c.green("✔")
        ),
        "replaced" => format!(
            "{} {WORKFLOW_PATH} reemplazado por la plantilla.",
            c.green("✔")
        ),
        "up_to_date" => format!("{} {WORKFLOW_PATH} igual a la plantilla.", c.green("✔")),
        "customized" => format!(
            "{} {WORKFLOW_PATH} adaptado (distinto de la plantilla).",
            c.green("✔")
        ),
        _ => format!("{} falta {WORKFLOW_PATH}", c.red("✖")),
    };
    println!("{line}");
    match report["keel"]["linked"].as_bool() {
        Some(true) => println!(
            "{} vinculado en keel ({} scope(s))",
            c.green("✔"),
            report["keel"]["scopes"].as_array().map_or(0, Vec::len)
        ),
        Some(false) => println!("{} no vinculado en keel", c.red("✖")),
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
        println!(
            "{} secret DEPLOY_API_TOKEN",
            mark(&report["github"]["DEPLOY_API_TOKEN"])
        );
        println!(
            "{} variable KEEL_API_URL",
            mark(&report["github"]["KEEL_API_URL"])
        );
    } else {
        println!(
            "{} {}",
            c.yellow("▲"),
            report["github"]["note"].as_str().unwrap_or("")
        );
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

    #[test]
    fn reads_gh_lists_and_admin_urls() {
        assert_eq!(
            gh_names("DEPLOY_API_TOKEN\t2026-11-01T00:00:00Z\nOTHER\tx\n"),
            ["DEPLOY_API_TOKEN", "OTHER"]
        );
        assert_eq!(
            admin_url("https://keel.acme.dev/api"),
            "https://keel.acme.dev/scopes"
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
}
