//! What `keel init` does on GitHub through `gh` (or `KEEL_GH`): check the
//! session, write the CI token secret and the API variable, and open the PR
//! with the workflow. The CI token only ever reaches `gh` through stdin.

use crate::failure::{Kind, fail};
use crate::keel::api::CiToken;
use crate::keel::git;
use anyhow::Result;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const SECRET: &str = "DEPLOY_API_TOKEN";
pub const VARIABLE: &str = "KEEL_API_URL";
pub const PR_BRANCH: &str = "keel/init";

/// What a `gh` run printed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GhOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `gh`. Tests fake it to check what goes in argv and what in stdin.
pub trait Gh {
    /// `None` when the program can't be started (not installed).
    fn run(&self, args: &[&str], stdin: Option<&str>) -> Option<GhOutput>;

    /// Stdout of a successful run.
    fn ok(&self, args: &[&str]) -> Option<String> {
        self.run(args, None).filter(|o| o.ok).map(|o| o.stdout)
    }
}

/// The real `gh`, or the program in `KEEL_GH`, run in the repo.
pub struct SystemGh {
    program: String,
    cwd: PathBuf,
}

impl SystemGh {
    pub fn new(cwd: &Path) -> Self {
        Self {
            program: std::env::var("KEEL_GH").unwrap_or_else(|_| "gh".to_owned()),
            cwd: cwd.to_path_buf(),
        }
    }
}

impl Gh for SystemGh {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> Option<GhOutput> {
        let mut child = Command::new(&self.program)
            .args(args)
            .current_dir(&self.cwd)
            // Never a prompt: keel decides what to ask.
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok()?;
        if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
            // A broken pipe shows up as gh's own failure below.
            let _ = pipe.write_all(input.as_bytes());
        }
        let output = child.wait_with_output().ok()?;
        Some(GhOutput {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Whether `gh` can act on the repo's host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhState {
    Ready,
    Missing,
    /// Installed but without a session for the host; the text says why.
    Unauthenticated(String),
}

impl GhState {
    pub fn is_ready(&self) -> bool {
        *self == Self::Ready
    }

    /// What to do to get `gh` ready.
    pub fn instructions(&self, host: &str) -> String {
        match self {
            Self::Ready => String::new(),
            Self::Missing => "No se encontró `gh` (GitHub CLI). Instálalo (https://cli.github.com) y ejecuta `gh auth login`; keel guarda el token de CI con él porque solo se muestra una vez.".to_owned(),
            Self::Unauthenticated(_) => format!(
                "`gh` no tiene sesión en {host}. Ejecuta `gh auth login --hostname {host}` y vuelve a correr `keel init`; keel guarda el token de CI con él porque solo se muestra una vez."
            ),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Unauthenticated(_) => "unauthenticated",
        }
    }
}

pub fn gh_state(gh: &dyn Gh, host: &str) -> GhState {
    if gh.run(&["--version"], None).is_none_or(|o| !o.ok) {
        return GhState::Missing;
    }
    match gh.run(&["auth", "status", "--hostname", host], None) {
        Some(o) if o.ok => GhState::Ready,
        Some(o) => GhState::Unauthenticated(o.stderr.trim().to_owned()),
        None => GhState::Missing,
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

/// gh's error text without the token, in case anything ever echoed it.
fn redacted(text: &str, token: &CiToken) -> String {
    let text = text.trim();
    if token.expose().is_empty() {
        text.to_owned()
    } else {
        text.replace(token.expose(), "***")
    }
}

/// `gh secret set <name> --repo <repo>` (`DEPLOY_API_TOKEN` by default) with
/// the token on stdin: never in argv (visible in `ps`), logs, output or errors.
pub fn set_secret(gh: &dyn Gh, repo: &str, name: &str, token: &CiToken) -> Result<()> {
    let args = ["secret", "set", name, "--repo", repo];
    match gh.run(&args, Some(token.expose())) {
        Some(o) if o.ok => Ok(()),
        Some(o) => Err(fail(
            Kind::Error,
            format!(
                "`gh secret set {name} --repo {repo}` falló: {}. El token nuevo no quedó guardado: vuelve a correr `keel init --rotate-token` cuando gh funcione.",
                redacted(&o.stderr, token)
            ),
        )),
        None => Err(fail(
            Kind::Error,
            format!(
                "No se pudo ejecutar gh para guardar {name}. Vuelve a correr `keel init --rotate-token` cuando gh funcione."
            ),
        )),
    }
}

/// Whether the repo has the secret; `None` when gh can't list them.
pub fn has_secret(gh: &dyn Gh, repo: &str, name: &str) -> Option<bool> {
    gh.ok(&["secret", "list", "--repo", repo])
        .map(|out| gh_names(&out).iter().any(|n| n == name))
}

/// The repo's `KEEL_API_URL`, `None` when it doesn't have it.
pub fn variable(gh: &dyn Gh, repo: &str) -> Option<String> {
    gh.ok(&["variable", "get", VARIABLE, "--repo", repo])
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

pub fn set_variable(gh: &dyn Gh, repo: &str, value: &str) -> Result<()> {
    match gh.run(
        &["variable", "set", VARIABLE, "--body", value, "--repo", repo],
        None,
    ) {
        Some(o) if o.ok => Ok(()),
        Some(o) => Err(fail(
            Kind::Error,
            format!(
                "`gh variable set {VARIABLE} --repo {repo}` falló: {}",
                o.stderr.trim()
            ),
        )),
        None => Err(fail(Kind::Error, "No se pudo ejecutar gh.")),
    }
}

// ------------------------------------------------------------------------ PR

/// The branch `origin/HEAD` points to (`main`), from the remote itself.
pub fn default_branch(root: &Path) -> Result<String> {
    let out = git::git(root, &["ls-remote", "--symref", "origin", "HEAD"])?;
    out.lines()
        .find_map(|l| l.strip_prefix("ref: refs/heads/"))
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_owned)
        .ok_or_else(|| {
            fail(
                Kind::GitState,
                "No se pudo saber la rama por defecto de origin.",
            )
        })
}

/// What the workflow looks like on `origin/<branch>` (after fetching it).
pub fn fetch_file(root: &Path, branch: &str, path: &str) -> Result<Option<String>> {
    git::git(
        root,
        &[
            "fetch",
            "--quiet",
            "origin",
            &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
        ],
    )?;
    Ok(git::git_ok(
        root,
        &["show", &format!("refs/remotes/origin/{branch}:{path}")],
    ))
}

pub enum PrOutcome {
    Opened(String),
    /// The branch was already on origin: a PR is open or was merged.
    BranchExists,
}

pub const PR_TITLE: &str = "ci: workflow de release de keel";
pub const PR_BODY: &str = "Agrega `.github/workflows/keel-release.yml`: en cada tag de versión construye la imagen, la publica en GHCR y le reporta el resultado del CI a keel, que despliega cuando pasa.\n\nAntes de mergear, cambia el paso «Test» por los tests del proyecto.\n\nCreado con `keel init`.";

/// Commits only the workflow on a new `keel/init` branch cut from
/// `origin/<base>`, in a temporary worktree (the person's checkout is not
/// touched), pushes that branch and opens the PR. Uses plain `git commit`, so
/// hooks and signing config apply.
pub fn open_pr(
    gh: &dyn Gh,
    root: &Path,
    repo: &str,
    base: &str,
    path: &str,
    content: &str,
) -> Result<PrOutcome> {
    let current = git::git_ok(root, &["branch", "--show-current"]).unwrap_or_default();
    if current == PR_BRANCH || base == PR_BRANCH {
        return Err(fail(
            Kind::GitState,
            format!(
                "keel abre el PR desde la rama {PR_BRANCH}, y es tu rama actual o la rama por defecto; cámbiate de rama."
            ),
        ));
    }
    let remote = git::git(
        root,
        &[
            "ls-remote",
            "--heads",
            "origin",
            &format!("refs/heads/{PR_BRANCH}"),
        ],
    )?;
    if !remote.is_empty() {
        return Ok(PrOutcome::BranchExists);
    }
    if git::git_ok(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{PR_BRANCH}"),
        ],
    )
    .is_some()
    {
        return Err(fail(
            Kind::GitState,
            format!(
                "Ya existe la rama local {PR_BRANCH} pero no está en origin. Bórrala (`git branch -D {PR_BRANCH}`) o súbela tú."
            ),
        ));
    }
    let dir = std::env::temp_dir().join(format!("keel-init-{}", uuid::Uuid::new_v4().simple()));
    let dir_arg = dir.to_string_lossy().replace('\\', "/");
    git::git(
        root,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            PR_BRANCH,
            &dir_arg,
            &format!("refs/remotes/origin/{base}"),
        ],
    )?;
    let result = (|| -> Result<String> {
        let file = dir.join(path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&file, content)?;
        git::git(&dir, &["add", "--", path])?;
        git::git(&dir, &["commit", "--quiet", "-m", PR_TITLE, "--", path])?;
        // Only ever this branch, by full refspec: never the current or default one.
        git::git(
            &dir,
            &[
                "push",
                "--quiet",
                "origin",
                &format!("refs/heads/{PR_BRANCH}:refs/heads/{PR_BRANCH}"),
            ],
        )?;
        let out = gh.run(
            &[
                "pr", "create", "--repo", repo, "--base", base, "--head", PR_BRANCH, "--title",
                PR_TITLE, "--body", PR_BODY,
            ],
            None,
        );
        match out {
            Some(o) if o.ok => Ok(o
                .stdout
                .lines()
                .rev()
                .find(|l| l.trim().starts_with("http"))
                .unwrap_or_default()
                .trim()
                .to_owned()),
            Some(o) => Err(fail(
                Kind::Error,
                format!(
                    "La rama {PR_BRANCH} se subió, pero `gh pr create` falló: {}. Ábrelo a mano.",
                    o.stderr.trim()
                ),
            )),
            None => Err(fail(
                Kind::Error,
                format!(
                    "La rama {PR_BRANCH} se subió, pero no se pudo ejecutar gh. Abre el PR a mano."
                ),
            )),
        }
    })();
    let _ = git::git(root, &["worktree", "remove", "--force", &dir_arg]);
    let _ = std::fs::remove_dir_all(&dir);
    result.map(PrOutcome::Opened)
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::cell::RefCell;

    type Answer = Box<dyn Fn(&[&str]) -> Option<GhOutput>>;

    /// A `gh` that records every call (args, stdin) and answers from a script.
    pub struct FakeGh {
        pub calls: RefCell<Vec<(Vec<String>, Option<String>)>>,
        pub answer: Answer,
    }

    impl FakeGh {
        pub fn ok() -> Self {
            Self::with(|_| {
                Some(GhOutput {
                    ok: true,
                    ..Default::default()
                })
            })
        }

        pub fn with(answer: impl Fn(&[&str]) -> Option<GhOutput> + 'static) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                answer: Box::new(answer),
            }
        }
    }

    impl Gh for FakeGh {
        fn run(&self, args: &[&str], stdin: Option<&str>) -> Option<GhOutput> {
            self.calls.borrow_mut().push((
                args.iter().map(|a| (*a).to_owned()).collect(),
                stdin.map(str::to_owned),
            ));
            (self.answer)(args)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeGh;
    use super::*;

    #[test]
    fn the_token_only_goes_through_stdin() {
        let token = CiToken::new("keel_ci_s3cr3t");
        let gh = FakeGh::ok();
        set_secret(&gh, "acme/app", SECRET, &token).unwrap();
        let calls = gh.calls.borrow();
        assert_eq!(calls.len(), 1);
        let (args, stdin) = &calls[0];
        assert_eq!(
            args,
            &["secret", "set", "DEPLOY_API_TOKEN", "--repo", "acme/app"]
        );
        assert!(args.iter().all(|a| !a.contains("s3cr3t")));
        assert_eq!(stdin.as_deref(), Some("keel_ci_s3cr3t"));
        assert_eq!(format!("{token:?}"), "CiToken(***)");
    }

    #[test]
    fn a_failing_gh_never_echoes_the_token() {
        let token = CiToken::new("keel_ci_s3cr3t");
        let gh = FakeGh::with(|_| {
            Some(GhOutput {
                ok: false,
                stdout: String::new(),
                stderr: "bad value keel_ci_s3cr3t".into(),
            })
        });
        let error = set_secret(&gh, "acme/app", "KEEL_CI_TOKEN", &token).unwrap_err();
        assert!(error.to_string().contains("gh secret set KEEL_CI_TOKEN"));
        let (report, _) = crate::failure::report(&error);
        assert!(!report.to_string().contains("s3cr3t"), "{report}");
        assert!(error.to_string().contains("***"));
    }

    #[test]
    fn reads_the_gh_session() {
        assert_eq!(
            gh_state(&FakeGh::with(|_| None), "github.com"),
            GhState::Missing
        );
        let unauth = FakeGh::with(|args| {
            Some(GhOutput {
                ok: args[0] == "--version",
                stdout: String::new(),
                stderr: "not logged in".into(),
            })
        });
        assert!(matches!(
            gh_state(&unauth, "github.com"),
            GhState::Unauthenticated(_)
        ));
        let ready = FakeGh::ok();
        assert_eq!(gh_state(&ready, "github.com"), GhState::Ready);
        assert_eq!(
            ready.calls.borrow()[1].0,
            ["auth", "status", "--hostname", "github.com"]
        );
        assert_eq!(
            gh_names("DEPLOY_API_TOKEN\t2026-11-01T00:00:00Z\nOTHER\tx\n"),
            ["DEPLOY_API_TOKEN", "OTHER"]
        );
    }
}
