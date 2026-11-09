//! `keel skills`: installs the agent skills published in this repo
//! (`plugins/*/skills/<skill>`) into a repo or the user's home, for Claude
//! Code (`.claude/skills`) and Codex/Copilot (`.agents/skills`).

use crate::dokploy::print_json;
use crate::failure::{Kind, fail};
use crate::keel::commands::Ctx;
use crate::keel::{git, semver};
use crate::ui;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const REPO: &str = "reitmas32/keel";
pub const MARKER: &str = ".keel-skill.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Agent {
    Claude,
    Codex,
    Copilot,
}

impl Agent {
    pub fn parse(name: &str) -> Result<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "copilot" => Ok(Self::Copilot),
            other => Err(fail(
                Kind::Error,
                format!("Agente desconocido: {other}. Usa claude, codex o copilot."),
            )),
        }
    }

    /// Where its skills live, relative to the repo or the home.
    pub fn dir(self) -> &'static str {
        match self {
            Self::Claude => ".claude/skills",
            Self::Codex | Self::Copilot => ".agents/skills",
        }
    }
}

/// The skill folders to write, one per distinct agent directory.
pub fn destinations(base: &Path, agents: &[Agent]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = agents.iter().map(|a| base.join(a.dir())).collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub source: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub skill: String,
    pub installed_at: String,
}

pub fn read_marker(dir: &Path) -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(MARKER)).ok()?).ok()
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

/// Splits `plugins/<plugin>/skills/<skill>/<rest>` into `(skill, rest)`.
pub fn skill_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("plugins/")?;
    let (_, rest) = rest.split_once('/')?;
    let rest = rest.strip_prefix("skills/")?;
    let (skill, file) = rest.split_once('/')?;
    let safe = valid_name(skill)
        && !file.is_empty()
        && file
            .split('/')
            .all(|p| !p.is_empty() && p != ".." && p != ".");
    safe.then_some((skill, file))
}

pub struct SkillFile {
    pub path: String,
    pub bytes: Vec<u8>,
    pub executable: bool,
}

enum Source {
    Local(PathBuf),
    Remote {
        reference: String,
        token: Option<String>,
        /// path → executable
        tree: Vec<(String, bool)>,
    },
}

impl Source {
    fn label(&self) -> String {
        match self {
            Self::Local(path) => path.display().to_string(),
            Self::Remote { .. } => format!("github.com/{REPO}"),
        }
    }

    fn reference(&self) -> String {
        match self {
            Self::Local(_) => "local".to_owned(),
            Self::Remote { reference, .. } => reference.clone(),
        }
    }

    async fn open(from: Option<PathBuf>, reference: Option<String>) -> Result<Self> {
        if let Some(path) = from {
            if !path.join("plugins").is_dir() {
                return Err(fail(
                    Kind::Config,
                    format!("{} no tiene una carpeta plugins/.", path.display()),
                ));
            }
            return Ok(Self::Local(path));
        }
        let reference = reference.unwrap_or_else(|| {
            if semver::is_semver_tag(crate::VERSION) {
                crate::VERSION.to_owned()
            } else {
                "main".to_owned()
            }
        });
        let token = github_token();
        let mut request = http()?.get(format!(
            "https://api.github.com/repos/{REPO}/git/trees/{reference}?recursive=1"
        ));
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|e| fail(Kind::Network, format!("No se pudo consultar GitHub: {e}")))?;
        if !response.status().is_success() {
            return Err(fail(
                Kind::Network,
                format!(
                    "GitHub respondió {} al listar los skills de {REPO}@{reference}.",
                    response.status().as_u16()
                ),
            ));
        }
        let body: serde_json::Value = response.json().await?;
        let tree = body["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["type"] == "blob")
            .filter_map(|e| {
                Some((
                    e["path"].as_str()?.to_owned(),
                    e["mode"].as_str() == Some("100755"),
                ))
            })
            .collect();
        Ok(Self::Remote {
            reference,
            token,
            tree,
        })
    }

    /// Paths (relative to the repo) of every file in every skill.
    fn paths(&self) -> Result<Vec<(String, bool)>> {
        match self {
            Self::Remote { tree, .. } => Ok(tree.clone()),
            Self::Local(root) => {
                let mut out = Vec::new();
                walk(root, &root.join("plugins"), &mut out)?;
                Ok(out)
            }
        }
    }

    /// Skill name → plugin path prefix.
    fn available(&self) -> Result<BTreeMap<String, usize>> {
        let mut skills = BTreeMap::new();
        for (path, _) in self.paths()? {
            if let Some((skill, _)) = skill_path(&path) {
                *skills.entry(skill.to_owned()).or_insert(0) += 1;
            }
        }
        Ok(skills)
    }

    async fn files(&self, skill: &str) -> Result<Vec<SkillFile>> {
        let mut files = Vec::new();
        for (path, executable) in self.paths()? {
            let Some((name, rest)) = skill_path(&path) else {
                continue;
            };
            if name != skill {
                continue;
            }
            let bytes = match self {
                Self::Local(root) => std::fs::read(root.join(&path))
                    .with_context(|| format!("no se pudo leer {path}"))?,
                Self::Remote {
                    reference, token, ..
                } => {
                    let mut request = http()?.get(format!(
                        "https://raw.githubusercontent.com/{REPO}/{reference}/{path}"
                    ));
                    if let Some(token) = token {
                        request = request.bearer_auth(token);
                    }
                    let response = request.send().await.map_err(|e| {
                        fail(Kind::Network, format!("No se pudo descargar {path}: {e}"))
                    })?;
                    if !response.status().is_success() {
                        return Err(fail(
                            Kind::Network,
                            format!(
                                "GitHub respondió {} al descargar {path}.",
                                response.status().as_u16()
                            ),
                        ));
                    }
                    response.bytes().await?.to_vec()
                }
            };
            files.push(SkillFile {
                path: rest.to_owned(),
                bytes,
                executable,
            });
        }
        Ok(files)
    }
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, bool)>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            walk(root, &path, out)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, is_executable(&entry.metadata()?)));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    false
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("keel-cli/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

fn github_token() -> Option<String> {
    ["KEEL_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        .or_else(|| {
            std::process::Command::new("gh")
                .args(["auth", "token"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .filter(|t| !t.is_empty())
        })
}

/// Writes a skill into `root/<skill>`, replacing only a copy keel made.
pub fn install(root: &Path, skill: &str, files: &[SkillFile], marker: &Marker) -> Result<()> {
    let dir = root.join(skill);
    if dir.exists() {
        if read_marker(&dir).is_none() {
            return Err(fail(
                Kind::Refused,
                format!(
                    "{} existe y no lo instaló keel (no tiene {MARKER}): no se toca.",
                    dir.display()
                ),
            ));
        }
        std::fs::remove_dir_all(&dir)?;
    }
    for file in files {
        let path = dir.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &file.bytes)?;
        #[cfg(unix)]
        if file.executable {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    std::fs::write(
        dir.join(MARKER),
        format!("{}\n", serde_json::to_string_pretty(marker)?),
    )?;
    Ok(())
}

/// Removes `root/<skill>` if keel installed it. Returns whether it existed.
pub fn uninstall(root: &Path, skill: &str) -> Result<bool> {
    let dir = root.join(skill);
    if !dir.exists() {
        return Ok(false);
    }
    if read_marker(&dir).is_none() {
        return Err(fail(
            Kind::Refused,
            format!(
                "{} no lo instaló keel (no tiene {MARKER}): bórralo a mano si quieres.",
                dir.display()
            ),
        ));
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(true)
}

/// Skills keel installed under each root.
pub fn installed(roots: &[PathBuf]) -> Vec<(PathBuf, Marker)> {
    let mut out = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            if let Some(marker) = read_marker(&entry.path()) {
                out.push((entry.path(), marker));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub struct Scope {
    pub global: bool,
    pub agents: Option<String>,
}

fn roots(ctx: &Ctx, scope: &Scope) -> Result<Vec<PathBuf>> {
    let base = if scope.global {
        match std::env::var_os("KEEL_SKILLS_HOME") {
            Some(home) => PathBuf::from(home),
            None => directories::BaseDirs::new()
                .map(|d| d.home_dir().to_path_buf())
                .ok_or_else(|| fail(Kind::Config, "No se encontró tu carpeta personal."))?,
        }
    } else {
        git::git_ok(&ctx.cwd, &["rev-parse", "--show-toplevel"])
            .map(PathBuf::from)
            .unwrap_or_else(|| ctx.cwd.clone())
    };
    let agents = match &scope.agents {
        Some(list) => list
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(Agent::parse)
            .collect::<Result<Vec<_>>>()?,
        None => vec![Agent::Claude, Agent::Codex, Agent::Copilot],
    };
    Ok(destinations(&base, &agents))
}

pub enum SkillsAction {
    List,
    Add(Vec<String>),
    Remove(Vec<String>),
    Update,
}

pub async fn skills(
    ctx: &Ctx,
    action: SkillsAction,
    scope: Scope,
    from: Option<PathBuf>,
    reference: Option<String>,
) -> Result<()> {
    let roots = roots(ctx, &scope)?;
    match action {
        SkillsAction::List => {
            let installed = installed(&roots);
            let available = match Source::open(from, reference).await {
                Ok(source) => Ok((source.label(), source.reference(), source.available()?)),
                Err(error) => Err(error),
            };
            if ctx.json {
                return print_json(&json!({
                    "available": available.as_ref().ok().map(|(_, _, a)| a.keys().collect::<Vec<_>>()),
                    "source": available.as_ref().ok().map(|(l, r, _)| json!({"source": l, "ref": r})),
                    "error": available.as_ref().err().map(|e| crate::failure::report(e).0["error"].clone()),
                    "installed": installed.iter().map(|(p, m)| json!({"path": p, "marker": m})).collect::<Vec<_>>(),
                }));
            }
            let c = ui::stdout_colors();
            match &available {
                Ok((label, reference, skills)) => {
                    println!("{} Skills en {label}@{reference}:", c.cyan("◇"));
                    for skill in skills.keys() {
                        println!("    {skill}");
                    }
                }
                Err(error) => ui::warn(&format!("No se pudieron listar los skills: {error:#}")),
            }
            println!();
            if installed.is_empty() {
                println!("  Ninguno instalado aquí. Instala uno con `keel skills add <skill>`.");
            }
            for (path, marker) in &installed {
                println!(
                    "  {} {}  {}",
                    c.green("✔"),
                    path.display(),
                    c.dim(&format!("({})", marker.reference))
                );
            }
            Ok(())
        }
        SkillsAction::Add(names) | SkillsAction::Remove(names) if names.is_empty() => {
            Err(fail(Kind::MissingInput, "Indica al menos un skill."))
        }
        SkillsAction::Add(names) => {
            let source = Source::open(from, reference).await?;
            let available = source.available()?;
            let mut written = Vec::new();
            for name in &names {
                if !available.contains_key(name) {
                    return Err(fail(
                        Kind::ServiceNotFound,
                        format!(
                            "No hay un skill {name} en {}. Disponibles: {}.",
                            source.label(),
                            available.keys().cloned().collect::<Vec<_>>().join(", ")
                        ),
                    ));
                }
                let files = source.files(name).await?;
                let marker = Marker {
                    source: source.label(),
                    reference: source.reference(),
                    skill: name.clone(),
                    installed_at: chrono::Utc::now().to_rfc3339(),
                };
                for root in &roots {
                    install(root, name, &files, &marker)?;
                    written.push(root.join(name));
                }
            }
            report(ctx, "installed", &written)
        }
        SkillsAction::Remove(names) => {
            let mut removed = Vec::new();
            for name in &names {
                for root in &roots {
                    if uninstall(root, name)? {
                        removed.push(root.join(name));
                    }
                }
            }
            if removed.is_empty() {
                return Err(fail(
                    Kind::ServiceNotFound,
                    format!("{} no está instalado aquí.", names.join(", ")),
                ));
            }
            report(ctx, "removed", &removed)
        }
        SkillsAction::Update => {
            let installed = installed(&roots);
            if installed.is_empty() {
                return report(ctx, "updated", &[]);
            }
            let source = Source::open(from, reference).await?;
            let available = source.available()?;
            let mut written = Vec::new();
            for (path, marker) in installed {
                if !available.contains_key(&marker.skill) {
                    ui::warn(&format!(
                        "{} ya no se publica; se deja como está.",
                        marker.skill
                    ));
                    continue;
                }
                let files = source.files(&marker.skill).await?;
                let root = path.parent().unwrap_or(Path::new("."));
                let fresh = Marker {
                    source: source.label(),
                    reference: source.reference(),
                    skill: marker.skill.clone(),
                    installed_at: chrono::Utc::now().to_rfc3339(),
                };
                install(root, &marker.skill, &files, &fresh)?;
                written.push(path);
            }
            report(ctx, "updated", &written)
        }
    }
}

fn report(ctx: &Ctx, action: &str, paths: &[PathBuf]) -> Result<()> {
    if ctx.json {
        return print_json(&json!({"ok": true, action: paths}));
    }
    let verb = match action {
        "installed" => "Instalado",
        "removed" => "Quitado",
        _ => "Actualizado",
    };
    if paths.is_empty() {
        ui::info("Nada que hacer.");
    }
    for path in paths {
        ui::success(&format!("{verb}: {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_skill_files_and_rejects_unsafe_paths() {
        assert_eq!(
            skill_path("plugins/keel-cli/skills/keel-cli/SKILL.md"),
            Some(("keel-cli", "SKILL.md"))
        );
        assert_eq!(
            skill_path("plugins/x/skills/keel-cli/references/errors.md"),
            Some(("keel-cli", "references/errors.md"))
        );
        assert_eq!(skill_path("plugins/x/plugin.json"), None);
        assert_eq!(skill_path("plugins/x/skills/a/../b"), None);
        assert_eq!(skill_path("plugins/x/skills/Bad/SKILL.md"), None);
    }

    #[test]
    fn destinations_dedupe_codex_and_copilot() {
        let base = Path::new("/repo");
        let dirs = destinations(base, &[Agent::Claude, Agent::Codex, Agent::Copilot]);
        assert_eq!(
            dirs,
            [base.join(".agents/skills"), base.join(".claude/skills")]
        );
        assert!(Agent::parse("cursor").is_err());
    }

    #[test]
    fn never_touches_a_skill_without_marker() {
        let root = tempfile::tempdir().unwrap();
        let marker = Marker {
            source: "test".into(),
            reference: "main".into(),
            skill: "s".into(),
            installed_at: "now".into(),
        };
        let files = [SkillFile {
            path: "SKILL.md".into(),
            bytes: b"hi".to_vec(),
            executable: false,
        }];
        std::fs::create_dir_all(root.path().join("mine")).unwrap();
        assert!(install(root.path(), "mine", &files, &marker).is_err());
        assert!(uninstall(root.path(), "mine").is_err());
        install(root.path(), "s", &files, &marker).unwrap();
        install(root.path(), "s", &files, &marker).unwrap();
        assert_eq!(read_marker(&root.path().join("s")), Some(marker));
        assert_eq!(installed(&[root.path().to_path_buf()]).len(), 1);
        assert!(uninstall(root.path(), "s").unwrap());
        assert!(!uninstall(root.path(), "s").unwrap());
    }
}
