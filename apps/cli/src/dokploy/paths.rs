//! Where the Dokploy side keeps its configuration and state, and how a
//! command picks the Dokploy instance it talks to.

use crate::dokploy::config::{Config, InstanceConfig, Selection};
use crate::failure::{Kind, fail};
use anyhow::{Context, Result, bail};
use clap::Args;
use directories::{BaseDirs, ProjectDirs};
use std::path::{Path, PathBuf};

// The Dokploy instance a command talks to. Without `--target` it comes from
// KEEL_TARGET, then from the working directory (the instance whose `paths`
// contain it), then from `default = true`, then from a lone instance.
// (A `//` comment: a doc comment here would become the description of every
// command that flattens this struct.)
#[derive(Args, Clone, Default, Debug)]
pub struct Target {
    /// Dokploy instance as `organization/instance` (`organization` alone means
    /// organization/production). Default: $KEEL_TARGET, then the instance whose
    /// paths contain this directory, then the default one.
    #[arg(long, value_name = "ORG/INSTANCIA")]
    pub target: Option<String>,
}

impl Target {
    pub fn selection<'a>(&self, config: &'a Config) -> Result<Selection<'a>> {
        let env_target = std::env::var("KEEL_TARGET").ok();
        let cwd = std::env::current_dir().ok();
        let (organization, name) = match self.target.as_deref().map(str::trim) {
            None | Some("") => (None, None),
            Some(target) => match target.split_once('/') {
                Some((org, instance)) if !org.is_empty() && !instance.is_empty() => {
                    (Some(org), Some(instance))
                }
                Some(_) => bail!("--target takes organization/instance"),
                None => (Some(target), Some("production")),
            },
        };
        config.select(organization, name, env_target.as_deref(), cwd.as_deref())
    }

    pub fn resolve<'a>(&self, config: &'a Config) -> Result<&'a InstanceConfig> {
        Ok(self.selection(config)?.instance)
    }
}

/// `$KEEL_HOME`, or `~/.keel`.
pub fn keel_home() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("KEEL_HOME").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    Ok(BaseDirs::new()
        .context("cannot determine the home directory; set KEEL_HOME")?
        .home_dir()
        .join(".keel"))
}

/// `~/.keel/dokploy`: `config.toml` and the `instances/` directory.
pub fn dokploy_home() -> Result<PathBuf> {
    Ok(keel_home()?.join("dokploy"))
}

/// Where dokploy-agent kept its configuration, read until `keel config migrate`.
pub fn legacy_config_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => BaseDirs::new()?.home_dir().join(".config"),
    };
    Some(base.join("dokploy-agent"))
}

/// Where dokploy-agent kept plans, backups and its audit log.
pub fn legacy_state_dir() -> Option<PathBuf> {
    let directories = ProjectDirs::from("dev", "dokploy", "dokploy-agent")?;
    Some(
        directories
            .state_dir()
            .unwrap_or(directories.data_local_dir())
            .to_path_buf(),
    )
}

/// The configuration file in use and whether it is dokploy-agent's old one.
pub struct ConfigLocation {
    pub path: PathBuf,
    pub legacy: bool,
}

/// `--config`/KEEL_CONFIG, then `~/.keel/dokploy/config.toml`; while that
/// directory does not exist yet, dokploy-agent's `~/.config/dokploy-agent`.
pub fn config_location(argument: Option<PathBuf>) -> Result<ConfigLocation> {
    if let Some(path) = argument {
        return Ok(ConfigLocation {
            path,
            legacy: false,
        });
    }
    let home = dokploy_home()?;
    if !home.exists()
        && let Some(legacy) = legacy_config_dir().filter(|dir| dir.exists())
    {
        return Ok(ConfigLocation {
            path: legacy.join("config.toml"),
            legacy: true,
        });
    }
    Ok(ConfigLocation {
        path: home.join("config.toml"),
        legacy: false,
    })
}

/// Loads the Dokploy configuration, as a `config` failure when it is missing
/// or invalid, with a hint for a person that only uses keel's own commands.
pub fn load_config(argument: Option<PathBuf>) -> Result<Config> {
    let location = config_location(argument)?;
    Config::load(&location.path).map_err(|error| {
        match error.downcast_ref::<crate::failure::Failure>() {
            Some(_) => error,
            None => fail(
                Kind::Config,
                format!(
                    "{error:#}. Los comandos de Dokploy (get, plan, apply, backup, api) necesitan una instancia en {}/instances/<org>.env; los de keel (deploy, versions, scopes…) funcionan sin ella",
                    location
                        .path
                        .parent()
                        .unwrap_or(Path::new("."))
                        .display()
                ),
            ),
        }
    })
}

/// `--state-dir`, or the platform state directory for keel; dokploy-agent's
/// while keel's does not exist yet and the old one does.
pub fn state_dir(argument: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = argument {
        if !path.is_absolute() {
            bail!("--state-dir must be absolute");
        }
        return Ok(path);
    }
    let current = keel_state_dir()?;
    if !current.exists()
        && let Some(legacy) = legacy_state_dir().filter(|dir| dir.exists())
    {
        return Ok(legacy);
    }
    Ok(current)
}

pub fn keel_state_dir() -> Result<PathBuf> {
    let directories = ProjectDirs::from("dev", "keel", "keel")
        .context("cannot determine platform state directory")?;
    directories
        .state_dir()
        .or_else(|| Some(directories.data_local_dir()))
        .map(Path::to_path_buf)
        .context("platform has no writable state directory; provide --state-dir")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_without_instance_means_production() {
        let target = Target {
            target: Some("acme".into()),
        };
        // No config needed to check the parsing: an empty config fails with
        // target_unknown naming the pair it looked for.
        let config: Config = toml::from_str("").unwrap();
        let error = target.selection(&config).err().unwrap();
        assert!(
            format!("{error:#}").contains("acme/production"),
            "{error:#}"
        );
    }
}
