//! Organizations keel knows of, in `~/.keel/<org>/config.json`, and the
//! active one in `~/.keel/current`. Same layout as the TypeScript CLI, so
//! existing logins keep working.

use crate::failure::{Kind, fail};
use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

static ORG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^github\.com:[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap());

const CONFIG_FILE: &str = "config.json";
const CURRENT_FILE: &str = "current";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgConfig {
    /// `github.com:<owner>`, e.g. `github.com:konectus-io`.
    pub org: String,
    #[serde(rename = "apiUrl")]
    pub api_url: String,
}

impl OrgConfig {
    /// Owner part of the org, e.g. `konectus-io`.
    pub fn owner(&self) -> &str {
        org_owner(&self.org)
    }
}

pub fn org_owner(org: &str) -> &str {
    org.split_once(':').map_or(org, |(_, owner)| owner)
}

pub fn validate_org(org: &str) -> Option<&'static str> {
    if ORG_PATTERN.is_match(org) {
        None
    } else {
        Some("Usa el formato github.com:<org>, p.ej. github.com:konectus-io")
    }
}

/// Accepts `keel.konectus.internal/api` and defaults the scheme to https.
pub fn normalize_api_url(input: &str) -> Result<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let without_scheme = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    if without_scheme.is_empty() || trimmed.ends_with(':') {
        return Err(fail(Kind::Config, format!("URL de API inválida: {input}")));
    }
    let lower = trimmed.to_ascii_lowercase();
    let with_scheme = if lower.starts_with("http://") || lower.starts_with("https://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme)
        .map_err(|_| fail(Kind::Config, format!("URL de API inválida: {input}")))?;
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(fail(Kind::Config, format!("URL de API inválida: {input}")));
    }
    Ok(with_scheme)
}

/// The org's directory. Windows does not allow `:` in a file name.
fn org_dir(home: &Path, org: &str) -> PathBuf {
    if cfg!(windows) {
        home.join(org.replace(':', "_"))
    } else {
        home.join(org)
    }
}

pub fn save_org(home: &Path, config: &OrgConfig) -> Result<()> {
    if let Some(error) = validate_org(&config.org) {
        return Err(fail(Kind::Config, error));
    }
    let dir = org_dir(home, &config.org);
    fs::create_dir_all(&dir).with_context(|| format!("no se pudo crear {}", dir.display()))?;
    fs::write(
        dir.join(CONFIG_FILE),
        format!("{}\n", serde_json::to_string_pretty(config)?),
    )?;
    Ok(())
}

pub fn read_org(home: &Path, org: &str) -> Result<Option<OrgConfig>> {
    let path = org_dir(home, org).join(CONFIG_FILE);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let config: OrgConfig = serde_json::from_str(&raw)
                .with_context(|| format!("{} no es una configuración válida", path.display()))?;
            Ok(Some(config))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Configured orgs, sorted. Directories without a valid config are skipped.
pub fn list_orgs(home: &Path) -> Result<Vec<String>> {
    let entries = match fs::read_dir(home) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut orgs = Vec::new();
    for entry in entries.flatten() {
        let Ok(raw) = fs::read_to_string(entry.path().join(CONFIG_FILE)) else {
            continue;
        };
        if let Ok(config) = serde_json::from_str::<OrgConfig>(&raw)
            && validate_org(&config.org).is_none()
        {
            orgs.push(config.org);
        }
    }
    orgs.sort();
    Ok(orgs)
}

pub fn set_active_org(home: &Path, org: &str) -> Result<()> {
    if read_org(home, org)?.is_none() {
        return Err(fail(
            Kind::Config,
            format!("La organización {org} no está configurada. Ejecuta `keel login`."),
        ));
    }
    fs::create_dir_all(home)?;
    fs::write(home.join(CURRENT_FILE), format!("{org}\n"))?;
    Ok(())
}

/// The active org, or the one passed with `--org`.
pub fn active_org(home: &Path, explicit: Option<&str>) -> Result<OrgConfig> {
    let org = match explicit {
        Some(org) => org.to_owned(),
        None => match fs::read_to_string(home.join(CURRENT_FILE)) {
            Ok(raw) => raw.trim().to_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(fail(
                    Kind::Config,
                    "No hay organización activa. Ejecuta `keel login` o `keel use`.",
                ));
            }
            Err(error) => return Err(error.into()),
        },
    };
    read_org(home, &org)?.ok_or_else(|| {
        fail(
            Kind::Config,
            match explicit {
                Some(_) => format!(
                    "La organización {org} no está configurada. Ejecuta `keel login --org {org}`."
                ),
                None => format!(
                    "La organización activa {org} ya no está configurada. Ejecuta `keel use`."
                ),
            },
        )
    })
}

/// Name of the active org, if any, without failing.
pub fn active_org_name(home: &Path) -> Option<String> {
    fs::read_to_string(home.join(CURRENT_FILE))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_lists_and_activates_orgs() {
        let home = tempfile::tempdir().unwrap();
        let config = OrgConfig {
            org: "github.com:konectus-io".into(),
            api_url: "https://keel.example.com/api".into(),
        };
        save_org(home.path(), &config).unwrap();
        save_org(
            home.path(),
            &OrgConfig {
                org: "github.com:acme".into(),
                api_url: "https://keel.acme.dev/api".into(),
            },
        )
        .unwrap();
        assert_eq!(
            list_orgs(home.path()).unwrap(),
            ["github.com:acme", "github.com:konectus-io"]
        );
        assert!(active_org(home.path(), None).is_err());
        set_active_org(home.path(), "github.com:konectus-io").unwrap();
        assert_eq!(active_org(home.path(), None).unwrap(), config);
        assert!(set_active_org(home.path(), "github.com:nope").is_err());
        // Same JSON shape as the TypeScript CLI.
        let raw = fs::read_to_string(org_dir(home.path(), &config.org).join(CONFIG_FILE)).unwrap();
        assert!(raw.contains("\"apiUrl\""));
    }

    #[test]
    fn normalizes_api_urls() {
        assert_eq!(
            normalize_api_url("keel.konectus.internal/api/").unwrap(),
            "https://keel.konectus.internal/api"
        );
        assert_eq!(
            normalize_api_url("http://10.0.0.2:3000/api").unwrap(),
            "http://10.0.0.2:3000/api"
        );
        assert!(normalize_api_url("https://").is_err());
        assert!(validate_org("konectus-io").is_some());
        assert!(validate_org("github.com:konectus-io").is_none());
    }
}
