//! Commands added on top of dokploy-agent: partial env changes, env backups,
//! Compose diffs, mounts, backup destinations, plan pruning, live logs and
//! the rule that keeps keel scopes deployed through keel.

use crate::dokploy::client::{DokployClient, ServiceKind};
use crate::dokploy::commands::{ServiceRef, fetch_logs};
use crate::dokploy::config::Config;
use crate::dokploy::inventory::Service;
use crate::dokploy::{plan, redact};
use crate::failure::{Kind, fail};
use crate::keel::managed::{self, Managed};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

// ------------------------------------------------------------- keel guard

/// What a Dokploy plan is about to do to a service, for the keel rule.
pub enum Intent<'a> {
    /// deploy or redeploy: changes what runs, so it must go through keel.
    Deploy,
    /// A new env block: may not change the tag variable of a keel scope.
    Env { current: &'a str, next: &'a str },
    /// A new Compose file: a keel scope must keep taking its tag from a variable.
    ComposeFile { next: &'a str },
    /// start, stop, mounts: allowed, only noted.
    Other,
}

/// The outcome of the keel rule: a note for the plan summary and warnings.
pub struct Guard {
    pub note: String,
    pub warnings: Vec<String>,
}

/// Applies the keel rule to a plan on `service`. `force` (`--not-keel-managed`)
/// lets a plan through when keel cannot be asked.
pub async fn keel_guard(service: &Service, intent: Intent<'_>, force: bool) -> Result<Guard> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let managed = match managed::lookup(&cwd, &service.id).await {
        Ok(managed) => managed,
        Err(error) if force => Managed::Unknown(format!(
            "keel no respondió ({error:#}); forzado con --not-keel-managed"
        )),
        Err(error) => {
            return Err(fail(
                Kind::KeelUnreachable,
                format!(
                    "no se pudo comprobar con keel si {} es un scope ({error:#}). Si sabes que no lo es, repite el plan con --not-keel-managed",
                    service.label()
                ),
            ));
        }
    };
    let mut warnings = Vec::new();
    if let Managed::Scope { repo, scope } = &managed {
        let tag_variable = scope.tag_variable();
        match intent {
            Intent::Deploy => {
                return Err(crate::failure::fail_with(
                    Kind::KeelManaged,
                    format!(
                        "{} es el scope {} de {repo} en keel: despliégalo con `keel deploy -s {} -v <versión>` (o `keel rollback -s {}`), así espera al CI y queda en el historial",
                        service.label(),
                        scope.alias,
                        scope.alias,
                        scope.alias
                    ),
                    json!({"repo": repo, "scope": scope.alias}),
                ));
            }
            Intent::Env { current, next } if service.kind == ServiceKind::Compose => {
                let before = env_value(current, tag_variable);
                let after = env_value(next, tag_variable);
                if before != after {
                    return Err(crate::failure::fail_with(
                        Kind::KeelManaged,
                        format!(
                            "{} es el scope {} de {repo}: keel controla {tag_variable}, así que este plan no puede cambiarla ni quitarla. Cambia la versión con `keel deploy -s {}`",
                            service.label(),
                            scope.alias,
                            scope.alias
                        ),
                        json!({"repo": repo, "scope": scope.alias, "tag_variable": tag_variable}),
                    ));
                }
            }
            Intent::ComposeFile { next } if !next.contains(&format!("${{{tag_variable}")) => {
                warnings.push(format!(
                    "{} es el scope {} de {repo} y el nuevo Compose no usa ${{{tag_variable}}}: keel no podrá desplegar versiones en él",
                    service.label(),
                    scope.alias
                ));
            }
            _ => {}
        }
    }
    Ok(Guard {
        note: managed.note(),
        warnings,
    })
}

// ---------------------------------------------------------------- env patch

/// The value of `key` in a dotenv block, quotes included, if present.
pub fn env_value<'a>(env: &'a str, key: &str) -> Option<&'a str> {
    redact::env_pairs(env)
        .filter(|(k, _)| *k == key)
        .last()
        .map(|(_, v)| v)
}

/// A value as a dotenv line can hold it: multi-line values and values with
/// surrounding spaces or `#` go in double quotes with `\n` escapes.
pub fn quote_env_value(value: &str) -> String {
    let needs_quotes = value.contains('\n')
        || value.contains('#')
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value.contains('"');
    if !needs_quotes {
        return value.to_owned();
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

pub fn validate_env_key(key: &str) -> Result<()> {
    let valid = !key.is_empty()
        && key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        bail!(
            "{key:?} is not a valid variable name (letters, digits and _; not starting with a digit)"
        );
    }
    Ok(())
}

/// Applies `set` (key → raw value) and `unset` to an env block, keeping
/// every other line (comments included) as it was. Returns the new block and
/// the key changes with value lengths only.
pub fn patch_env(
    current: &str,
    set: &[(String, String)],
    unset: &[String],
) -> Result<(String, Value)> {
    for key in unset {
        if env_value(current, key).is_none() {
            return Err(fail(
                Kind::Refused,
                format!("--unset {key}: the env has no {key}"),
            ));
        }
        if set.iter().any(|(k, _)| k == key) {
            bail!("{key} is both --set and --unset");
        }
    }
    let mut pending: BTreeMap<&str, &str> =
        set.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let mut changed = Vec::new();
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut lines = Vec::new();
    for line in current.lines() {
        let trimmed = line.trim();
        let pair = (!trimmed.is_empty() && !trimmed.starts_with('#'))
            .then(|| trimmed.strip_prefix("export ").unwrap_or(trimmed))
            .and_then(|l| l.split_once('='))
            .map(|(k, v)| (k.trim(), v));
        match pair {
            Some((key, old)) if unset.iter().any(|k| k == key) => {
                if !removed.iter().any(|r: &Value| r["key"] == key) {
                    removed.push(json!({"key": key, "old_length": old.chars().count()}));
                }
            }
            Some((key, old)) if pending.contains_key(key) => {
                let value = pending.remove(key).unwrap_or_default();
                let quoted = quote_env_value(value);
                if quoted != old {
                    changed.push(json!({"key": key, "old_length": old.chars().count(), "new_length": quoted.chars().count()}));
                }
                lines.push(format!("{key}={quoted}"));
            }
            Some((key, new)) if set.iter().any(|(k, _)| k == key) => {
                // A duplicate of a key already set above: drop it so the new value wins.
                let _ = new;
            }
            _ => lines.push(line.to_owned()),
        }
    }
    for (key, value) in pending {
        let quoted = quote_env_value(value);
        added.push(json!({"key": key, "new_length": quoted.chars().count()}));
        lines.push(format!("{key}={quoted}"));
    }
    let mut env = lines.join("\n");
    if !env.is_empty() {
        env.push('\n');
    }
    Ok((
        env,
        json!({"added": added, "changed": changed, "removed": removed}),
    ))
}

/// Key changes between two whole env blocks (for env-restore), lengths only.
pub fn diff_env_keys(current: &str, next: &str) -> Value {
    let old: BTreeMap<&str, &str> = redact::env_pairs(current).collect();
    let new: BTreeMap<&str, &str> = redact::env_pairs(next).collect();
    let added: Vec<Value> = new
        .iter()
        .filter(|(k, _)| !old.contains_key(*k))
        .map(|(k, v)| json!({"key": k, "new_length": v.chars().count()}))
        .collect();
    let changed: Vec<Value> = new
        .iter()
        .filter_map(|(k, v)| {
            old.get(k)
                .filter(|o| *o != v)
                .map(|o| json!({"key": k, "old_length": o.chars().count(), "new_length": v.chars().count()}))
        })
        .collect();
    let removed: Vec<Value> = old
        .iter()
        .filter(|(k, _)| !new.contains_key(*k))
        .map(|(k, v)| json!({"key": k, "old_length": v.chars().count()}))
        .collect();
    json!({"added": added, "changed": changed, "removed": removed})
}

/// The value of `--set KEY` and where it came from: `$KEEL_SET_<KEY>` (an
/// explicit prefix, so an inherited `$KEY` is never picked up by accident),
/// else typed without echo at a terminal, else all of stdin when it is the
/// only `--set`. An empty value is refused: use --unset to remove a key.
pub fn read_set_value(key: &str, only_one: bool) -> Result<(String, &'static str)> {
    use std::io::{IsTerminal, Read};
    let variable = format!("KEEL_SET_{key}");
    let (value, source) = if let Ok(value) = std::env::var(&variable) {
        (value, "env")
    } else if std::io::stdin().is_terminal() {
        (crate::ui::secret(&format!("Valor de {key}"))?, "prompt")
    } else if only_one {
        let mut value = String::new();
        std::io::stdin().read_to_string(&mut value)?;
        let trimmed = value.strip_suffix('\n').unwrap_or(&value);
        let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
        (trimmed.to_owned(), "stdin")
    } else {
        return Err(fail(
            Kind::Refused,
            format!(
                "no value for {key}: export {variable} before running the plan (stdin only carries the value of a single --set)"
            ),
        ));
    };
    if value.is_empty() {
        return Err(fail(
            Kind::Refused,
            format!("the value for {key} ({source}) is empty; to remove the key use --unset {key}"),
        ));
    }
    Ok((value, source))
}

/// `KEY=/abs/path` → the file's content.
pub fn read_set_from_file(spec: &str) -> Result<(String, String)> {
    let (key, path) = spec
        .split_once('=')
        .context("--set-from-file takes KEY=/absolute/path")?;
    validate_env_key(key)?;
    let path = Path::new(path);
    if !path.is_absolute() {
        bail!("--set-from-file {key}: the path must be absolute");
    }
    let content =
        fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?;
    Ok((key.to_owned(), content.trim_end_matches('\n').to_owned()))
}

// ------------------------------------------------------------- env backups

/// The file-name stem `backup_env` uses for a service label.
pub fn backup_stem(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub struct EnvBackup {
    pub path: PathBuf,
    pub stem: String,
    /// `20261107T172146.220Z`
    pub timestamp: String,
}

/// Env backups under the state dir, newest first, optionally of one service.
pub fn env_backups(state: &Path, label: Option<&str>) -> Result<Vec<EnvBackup>> {
    let directory = state.join("backups");
    let Ok(entries) = fs::read_dir(&directory) else {
        return Ok(Vec::new());
    };
    let wanted = label.map(backup_stem);
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(base) = name.strip_suffix(".env") else {
            continue;
        };
        let Some((stem, timestamp)) = base.rsplit_once('-') else {
            continue;
        };
        if !timestamp.ends_with('Z') || !timestamp.contains('T') {
            continue;
        }
        if wanted.as_deref().is_some_and(|w| w != stem) {
            continue;
        }
        found.push(EnvBackup {
            path: entry.path(),
            stem: stem.to_owned(),
            timestamp: timestamp.to_owned(),
        });
    }
    found.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(found)
}

pub fn env_backups_view(state: &Path, label: Option<&str>) -> Result<Value> {
    let rows: Vec<Value> = env_backups(state, label)?
        .into_iter()
        .map(|b| {
            let content = fs::read_to_string(&b.path).unwrap_or_default();
            json!({
                "service": b.stem, "backup": b.timestamp,
                "keys": redact::env_pairs(&content).count(),
                "sha256": plan::content_sha256(&content),
            })
        })
        .collect();
    Ok(
        json!({"backups_dir": state.join("backups"), "backups": rows,
        "next_step": "restore one with `keel plan env-restore <service> --backup <backup>`"}),
    )
}

/// The content of one backup of `label`, by its timestamp (or a unique prefix).
pub fn read_env_backup(state: &Path, label: &str, timestamp: &str) -> Result<(String, String)> {
    let matches: Vec<EnvBackup> = env_backups(state, Some(label))?
        .into_iter()
        .filter(|b| b.timestamp.starts_with(timestamp))
        .collect();
    match matches.as_slice() {
        [one] => Ok((one.timestamp.clone(), fs::read_to_string(&one.path)?)),
        [] => Err(fail(
            Kind::ServiceNotFound,
            format!("{label} has no env backup {timestamp}; see `keel get env-backups {label}`"),
        )),
        many => Err(crate::failure::fail_with(
            Kind::ServiceAmbiguous,
            format!("{timestamp} matches {} backups of {label}", many.len()),
            json!({"candidates": many.iter().map(|b| &b.timestamp).collect::<Vec<_>>()}),
        )),
    }
}

// --------------------------------------------------------------- compose diff

/// A Compose file with secrets taken out, as YAML text a person can diff:
/// environment values, credential labels and secret-looking keys become
/// `[REDACTED]`; the structure (images, ports, volumes, labels) stays.
pub fn sanitize_compose(content: &str) -> String {
    let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(content) else {
        return "[REDACTED: Compose could not be safely parsed]\n".into();
    };
    let Ok(mut json) = serde_json::to_value(&yaml) else {
        return "[REDACTED: Compose could not be safely parsed]\n".into();
    };
    if let Some(services) = json.get_mut("services").and_then(Value::as_object_mut) {
        for service in services.values_mut() {
            let Some(mapping) = service.as_object_mut() else {
                continue;
            };
            for (key, value) in mapping.iter_mut() {
                *value = match key.as_str() {
                    "environment" => redact_environment(value.take()),
                    "labels" => redact::redact_labels(value.take()),
                    _ => redact::redact(value.take()),
                };
            }
        }
    }
    for (key, value) in json.as_object_mut().into_iter().flatten() {
        if key != "services" {
            *value = redact::redact(value.take());
        }
    }
    serde_yaml::to_string(&json).unwrap_or_default()
}

fn redact_environment(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, _)| (k, Value::String(redact::REDACTED.into())))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| match item.as_str().and_then(|s| s.split_once('=')) {
                    Some((key, _)) => Value::String(format!("{key}={}", redact::REDACTED)),
                    None => item,
                })
                .collect(),
        ),
        _ => Value::String(redact::REDACTED.into()),
    }
}

/// Unified diff of two sanitized Compose files; empty when they are equal.
pub fn compose_diff(remote: &str, local: &str) -> String {
    let (a, b) = (sanitize_compose(remote), sanitize_compose(local));
    if a == b {
        return String::new();
    }
    similar::TextDiff::from_lines(&a, &b)
        .unified_diff()
        .context_radius(3)
        .header("remoto", "local")
        .to_string()
}

// ------------------------------------------------- mounts, backups, databases

pub fn mounts_view(service: &Service, detail: &Value) -> Value {
    let mounts: Vec<Value> = detail
        .get("mounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|m| {
            json!({
                "mount_id": m.get("mountId"), "type": m.get("type"),
                "mount_path": m.get("mountPath"), "volume_name": m.get("volumeName"),
                "host_path": m.get("hostPath"), "file_path": m.get("filePath"),
                "content": m.get("content").and_then(Value::as_str).map(|c| format!("[omitted: {} characters]", c.chars().count())),
            })
        })
        .collect();
    json!({"service": service.label(), "kind": service.kind, "mounts": mounts})
}

pub fn destinations_view(destinations: &Value) -> Value {
    let rows: Vec<Value> = destinations
        .as_array()
        .into_iter()
        .flatten()
        .map(|d| {
            json!({
                "destination_id": d.get("destinationId"), "name": d.get("name"),
                "provider": d.get("provider"), "bucket": d.get("bucket"),
                "region": d.get("region"), "endpoint": d.get("endpoint"),
            })
        })
        .collect();
    json!({"destinations": rows})
}

pub fn backups_view(service: &Service, detail: &Value) -> Value {
    let backups: Vec<Value> = detail
        .get("backups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|b| {
            json!({
                "backup_id": b.get("backupId"), "database": b.get("database"),
                "schedule": b.get("schedule"), "prefix": b.get("prefix"),
                "keep_latest_count": b.get("keepLatestCount"), "enabled": b.get("enabled"),
                "destination": b.get("destination").and_then(|d| d.get("name")).or_else(|| b.get("destinationId")),
                "last_run": b.get("deployments").and_then(Value::as_array).and_then(|d| d.first()).map(|d| json!({"status": d.get("status"), "created_at": d.get("createdAt")})),
            })
        })
        .collect();
    json!({"service": service.label(), "kind": service.kind, "backups": backups})
}

/// Connection details of a database, password redacted.
pub fn database_view(service: &Service, detail: &Value) -> Option<Value> {
    let default_port = match service.kind {
        ServiceKind::Postgres => 5432,
        ServiceKind::Mysql | ServiceKind::Mariadb => 3306,
        ServiceKind::Mongo => 27017,
        ServiceKind::Redis => 6379,
        ServiceKind::Libsql => 8080,
        _ => return None,
    };
    let field = |key: &str| detail.get(key).cloned().unwrap_or(Value::Null);
    let password = detail
        .get("databasePassword")
        .and_then(Value::as_str)
        .map(|p| format!("{} ({} characters)", redact::REDACTED, p.chars().count()));
    Some(json!({
        "internal_host": field("appName"), "internal_port": default_port,
        "database": field("databaseName"), "user": field("databaseUser"),
        "password": password, "image": field("dockerImage"),
        "external_port": field("externalPort"),
        "memory_limit": field("memoryLimit"), "memory_reservation": field("memoryReservation"),
        "cpu_limit": field("cpuLimit"), "status": field("applicationStatus"),
    }))
}

// ------------------------------------------------------------------ prune

/// Removes expired plans (and, with `all`, pending ones) from the state dir.
pub fn prune_plans(state: &Path, all: bool) -> Result<Value> {
    let directory = state.join("plans");
    let mut removed = Vec::new();
    let mut kept = 0;
    for entry in fs::read_dir(&directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let expired = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<plan::Plan>(&bytes).ok())
            .is_none_or(|p| p.expires_at <= chrono::Utc::now());
        if expired || all {
            fs::remove_file(&path)?;
            removed.push(path.file_stem().map(|s| s.to_string_lossy().into_owned()));
        } else {
            kept += 1;
        }
    }
    Ok(json!({"ok": true, "removed": removed, "pending_kept": kept,
        "note": "backups and audit.jsonl are never touched"}))
}

// ------------------------------------------------------------- follow logs

pub enum FollowOutput {
    /// One JSON object per line (`{"ts","line"}`), for scripts and agents.
    Json,
    /// `ts  line`, for a person.
    Text,
}

/// Prints new log lines of a service every few seconds until Ctrl-C.
pub async fn follow_logs(
    config: &Config,
    client: &DokployClient,
    service: &ServiceRef,
    container: Option<&str>,
    search: Option<&str>,
    output: FollowOutput,
) -> Result<()> {
    let mut seen: VecDeque<String> = VecDeque::new();
    let mut since = "1m".to_owned();
    loop {
        let data = fetch_logs(config, client, service, container, 200, &since, search).await?;
        for line in data["lines"].as_array().into_iter().flatten() {
            let key = format!(
                "{}|{}",
                line["ts"].as_str().unwrap_or(""),
                line["line"].as_str().unwrap_or("")
            );
            if seen.contains(&key) {
                continue;
            }
            seen.push_back(key);
            if seen.len() > 2000 {
                seen.pop_front();
            }
            match output {
                FollowOutput::Json => println!("{}", serde_json::to_string(line)?),
                FollowOutput::Text => println!(
                    "{}  {}",
                    crate::ui::stdout_colors().dim(line["ts"].as_str().unwrap_or("")),
                    line["line"].as_str().unwrap_or("")
                ),
            }
        }
        since = "30s".into();
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_keeps_other_lines_and_reports_lengths_only() {
        let current = "# app\nDOMAIN=docs.example.com\nTOKEN=old-secret\nOLD_FLAG=1\n";
        let (env, changes) = patch_env(
            current,
            &[
                ("TOKEN".into(), "new-secret-value".into()),
                ("SENTRY_DSN".into(), "https://k@sentry/1".into()),
            ],
            &["OLD_FLAG".into()],
        )
        .unwrap();
        assert_eq!(
            env,
            "# app\nDOMAIN=docs.example.com\nTOKEN=new-secret-value\nSENTRY_DSN=https://k@sentry/1\n"
        );
        let shown = changes.to_string();
        assert!(!shown.contains("new-secret-value") && !shown.contains("old-secret"));
        assert_eq!(changes["changed"][0]["key"], "TOKEN");
        assert_eq!(changes["changed"][0]["new_length"], 16);
        assert_eq!(changes["added"][0]["key"], "SENTRY_DSN");
        assert_eq!(changes["removed"][0]["key"], "OLD_FLAG");
    }

    #[test]
    fn patch_refuses_unknown_unset_and_quotes_multiline() {
        assert!(patch_env("A=1\n", &[], &["B".into()]).is_err());
        let (env, _) = patch_env("", &[("PEM".into(), "line1\nline2".into())], &[]).unwrap();
        assert_eq!(env, "PEM=\"line1\\nline2\"\n");
    }

    #[test]
    fn env_key_diff_compares_whole_blocks() {
        let changes = diff_env_keys("A=1\nB=2\n", "B=22\nC=3\n");
        assert_eq!(changes["added"][0]["key"], "C");
        assert_eq!(changes["changed"][0]["key"], "B");
        assert_eq!(changes["removed"][0]["key"], "A");
    }

    #[test]
    fn compose_diff_hides_secrets() {
        let remote = "services:\n  web:\n    image: app:${DOCKER_TAG}\n    environment:\n      TOKEN: old-secret\n";
        let local = "services:\n  web:\n    image: app:${DOCKER_TAG}\n    ports: ['80:80']\n    environment:\n      TOKEN: new-secret\n";
        let diff = compose_diff(remote, local);
        assert!(
            diff.contains("+    - 80:80") || diff.contains("+  - 80:80") || diff.contains("80:80"),
            "{diff}"
        );
        assert!(
            !diff.contains("old-secret") && !diff.contains("new-secret"),
            "{diff}"
        );
        assert!(compose_diff(remote, remote).is_empty());
    }

    #[test]
    fn backups_are_listed_newest_first_per_service() {
        let state = tempfile::tempdir().unwrap();
        let dir = state.path().join("backups");
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "Platform_production__API__Core-20261105T104811.090Z.env",
            "Platform_production__API__Core-20261107T172146.220Z.env",
            "Dev_production-v2_webhooks-api-20261031T051345.821Z.env",
        ] {
            fs::write(dir.join(name), "A=1\n").unwrap();
        }
        let core = env_backups(state.path(), Some("Platform/production/ API  Core")).unwrap();
        assert_eq!(core.len(), 2);
        assert_eq!(core[0].timestamp, "20261107T172146.220Z");
        let webhooks = env_backups(state.path(), Some("Dev/production-v2/webhooks-api")).unwrap();
        assert_eq!(webhooks.len(), 1);
        assert!(
            read_env_backup(state.path(), "Platform/production/ API  Core", "2026110").is_err()
        );
        assert_eq!(
            read_env_backup(state.path(), "Platform/production/ API  Core", "20261105")
                .unwrap()
                .0,
            "20261105T104811.090Z"
        );
    }
}
