//! The git operations keel needs, run with the `git` binary.

use crate::failure::{Kind, fail};
use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| fail(Kind::GitState, format!("no se pudo ejecutar git: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(fail(
            Kind::GitState,
            format!(
                "git {} falló{}",
                args.join(" "),
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {stderr}")
                }
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn git_ok(cwd: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepo {
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl GithubRepo {
    /// `owner/name`
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// Parses `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/o/r.git`.
pub fn parse_github_remote(url: &str) -> Option<GithubRepo> {
    let url = url.trim();
    let strip = |name: &str| {
        let name = name.trim_end_matches('/');
        name.strip_suffix(".git").unwrap_or(name).to_owned()
    };
    let (host, path) = if let Some(rest) = url.split_once("://").map(|(_, r)| r) {
        let rest = rest.split_once('@').map_or(rest, |(_, r)| r);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next()?.to_owned(), path.to_owned())
    } else {
        let (user_host, path) = url.split_once(':')?;
        let (_, host) = user_host.split_once('@')?;
        (host.to_owned(), path.to_owned())
    };
    let (owner, name) = path.split_once('/')?;
    let name = strip(name);
    if host.is_empty() || owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(GithubRepo {
        host: host.to_lowercase(),
        owner: owner.to_owned(),
        name,
    })
}

/// Raw `remote.origin.url`, without `insteadOf` rewriting.
pub fn origin(cwd: &Path) -> Result<GithubRepo> {
    let url = git_ok(cwd, &["config", "--get", "remote.origin.url"]).ok_or_else(|| {
        fail(
            Kind::GitState,
            "Este repositorio no tiene un remote `origin`.",
        )
    })?;
    parse_github_remote(&url).ok_or_else(|| {
        fail(
            Kind::GitState,
            format!("No se reconoce el remote origin como un repo de GitHub: {url}"),
        )
    })
}

pub fn current_branch(cwd: &Path) -> Result<String> {
    let branch = git(cwd, &["branch", "--show-current"])?;
    if branch.is_empty() {
        return Err(fail(
            Kind::GitState,
            "Estás en detached HEAD. Cámbiate a una rama antes de crear una versión.",
        ));
    }
    Ok(branch)
}

/// Commits only in local (`ahead`) and only in `origin/<branch>` (`behind`), after fetching.
pub fn compare_with_remote(cwd: &Path, branch: &str) -> Result<(u32, u32)> {
    let head = format!("refs/heads/{branch}");
    if git(cwd, &["ls-remote", "--heads", "origin", &head])?.is_empty() {
        return Err(fail(
            Kind::GitState,
            format!(
                "La rama {branch} no existe en origin. Súbela con `git push -u origin {branch}`."
            ),
        ));
    }
    git(
        cwd,
        &[
            "fetch",
            "--quiet",
            "origin",
            &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
        ],
    )?;
    let counts = git(
        cwd,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...refs/remotes/origin/{branch}"),
        ],
    )?;
    let mut numbers = counts.split_whitespace().map(|n| n.parse().unwrap_or(0));
    Ok((numbers.next().unwrap_or(0), numbers.next().unwrap_or(0)))
}

pub fn remote_tag_exists(cwd: &Path, tag: &str) -> Result<bool> {
    Ok(!git(
        cwd,
        &["ls-remote", "--tags", "origin", &format!("refs/tags/{tag}")],
    )?
    .is_empty())
}

/// Tags on origin mapped to the commit they point at (annotated tags are peeled).
pub fn remote_tags(cwd: &Path) -> Result<HashMap<String, String>> {
    Ok(parse_ls_remote_tags(&git(
        cwd,
        &["ls-remote", "--tags", "origin"],
    )?))
}

pub fn parse_ls_remote_tags(output: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for line in output.lines().filter(|l| !l.is_empty()) {
        let Some((sha, reference)) = line.split_once('\t') else {
            continue;
        };
        let peeled = reference.ends_with("^{}");
        let name = reference
            .trim_start_matches("refs/tags/")
            .trim_end_matches("^{}")
            .to_owned();
        if peeled || !tags.contains_key(&name) {
            tags.insert(name, sha.to_owned());
        }
    }
    tags
}

pub fn local_tag_exists(cwd: &Path, tag: &str) -> bool {
    git_ok(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/tags/{tag}"),
        ],
    )
    .is_some()
}

/// `user.name` and `user.email` from git, to record who created a version.
pub fn identity(cwd: &Path) -> (Option<String>, Option<String>) {
    let read = |key| git_ok(cwd, &["config", "--get", key]).filter(|v| !v.is_empty());
    (read("user.name"), read("user.email"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remotes() {
        let expected = GithubRepo {
            host: "github.com".into(),
            owner: "konectus-io".into(),
            name: "app".into(),
        };
        for url in [
            "git@github.com:konectus-io/app.git",
            "git@GitHub.com:konectus-io/app",
            "ssh://git@github.com/konectus-io/app",
            "ssh://git@github.com:22/konectus-io/app.git",
            "https://github.com/konectus-io/app.git",
            "https://token@github.com/konectus-io/app/",
        ] {
            assert_eq!(parse_github_remote(url), Some(expected.clone()), "{url}");
        }
        assert_eq!(parse_github_remote("/srv/git/app.git"), None);
    }

    #[test]
    fn peels_annotated_tags() {
        let tags = parse_ls_remote_tags(
            "aaa\trefs/tags/v1.0.0\nbbb\trefs/tags/v1.0.0^{}\nccc\trefs/tags/v1.1.0\n",
        );
        assert_eq!(tags["v1.0.0"], "bbb");
        assert_eq!(tags["v1.1.0"], "ccc");
    }
}
