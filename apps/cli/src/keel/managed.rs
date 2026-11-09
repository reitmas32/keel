//! Whether a Dokploy service is a keel scope, so the Dokploy commands do not
//! deploy it behind keel's back (no CI gate, stale `scopes` and `rollback`).

use crate::dokploy::paths::keel_home;
use crate::keel::api::{KeelApi, ServiceSummary};
use crate::keel::{config, git};
use anyhow::Result;
use std::path::Path;

/// What keel says about a Dokploy service.
#[derive(Debug)]
pub enum Managed {
    /// The service is this scope of `repo`.
    Scope {
        repo: String,
        scope: Box<ServiceSummary>,
    },
    /// The working directory is a keel repo and none of its scopes is this service.
    NotManaged { repo: String },
    /// keel could not be asked: no active org, not a GitHub repo, or another org.
    Unknown(String),
}

impl Managed {
    /// A line for a plan summary.
    pub fn note(&self) -> String {
        match self {
            Self::Scope { repo, scope } => {
                format!("scope {} de {repo} en keel", scope.alias)
            }
            Self::NotManaged { repo } => format!("no es un scope de {repo} en keel"),
            Self::Unknown(reason) => format!("no verificado con keel: {reason}"),
        }
    }
}

/// The keel repo of a directory, when there is one: active org, a GitHub
/// origin of that org.
pub fn repo_of(cwd: &Path) -> std::result::Result<(config::OrgConfig, String), String> {
    let home = keel_home().map_err(|e| e.to_string())?;
    let org = config::active_org(&home, None)
        .map_err(|_| "no hay organización activa de keel".to_owned())?;
    let origin =
        git::origin(cwd).map_err(|_| "la carpeta actual no es un repo de GitHub".to_owned())?;
    if origin.host != "github.com" || !origin.owner.eq_ignore_ascii_case(org.owner()) {
        return Err(format!(
            "el repo ({}:{}) no es de la organización activa ({})",
            origin.host, origin.owner, org.org
        ));
    }
    Ok((org, origin.slug()))
}

/// Asks keel whether `dokploy_id` is one of the current repo's scopes.
/// Errors only when keel should have answered and did not.
pub async fn lookup(cwd: &Path, dokploy_id: &str) -> Result<Managed> {
    let (org, repo) = match repo_of(cwd) {
        Ok(found) => found,
        Err(reason) => return Ok(Managed::Unknown(reason)),
    };
    let api = KeelApi::new(&org.api_url)?;
    let scopes = api.list_service_summaries(&repo).await?;
    if scopes.iter().all(|s| s.dokploy_id.is_none()) && !scopes.is_empty() {
        return Ok(Managed::Unknown(
            "el servidor de keel es anterior a v0.5.0 y no dice qué servicio de Dokploy es cada scope".into(),
        ));
    }
    Ok(
        match scopes
            .into_iter()
            .find(|s| s.dokploy_id.as_deref() == Some(dokploy_id))
        {
            Some(scope) => Managed::Scope {
                repo,
                scope: Box::new(scope),
            },
            None => Managed::NotManaged { repo },
        },
    )
}
