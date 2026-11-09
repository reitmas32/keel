//! `keel update`: replaces this binary with the latest GitHub Release, after
//! checking it against the release's SHA256SUMS.

use crate::failure::{Kind, fail};
use crate::keel::semver::{compare_desc, is_semver_tag};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

/// GitHub repo whose Releases carry the binaries.
pub const RELEASE_REPO: &str = "reitmas32/keel";

/// The release asset for this OS and architecture, e.g. `keel-aarch64-apple-darwin`.
pub fn asset_name() -> Result<String> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn asset_for(os: &str, arch: &str) -> Result<String> {
    let triple = match (os, arch) {
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        _ => {
            return Err(fail(
                Kind::Refused,
                format!(
                    "No hay binario publicado para {os}/{arch}; compílalo con `cargo install --path apps/cli`."
                ),
            ));
        }
    };
    Ok(if os == "windows" {
        format!("keel-{triple}.exe")
    } else {
        format!("keel-{triple}")
    })
}

fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("keel-cli/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

pub async fn latest_release_tag() -> Result<String> {
    let response = http()?
        .get(format!(
            "https://api.github.com/repos/{RELEASE_REPO}/releases/latest"
        ))
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| fail(Kind::Network, format!("No se pudo consultar GitHub: {e}")))?;
    if !response.status().is_success() {
        return Err(fail(
            Kind::Network,
            format!(
                "GitHub respondió {} al buscar la última versión de keel.",
                response.status().as_u16()
            ),
        ));
    }
    let body: serde_json::Value = response.json().await?;
    let tag = body
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_owned();
    if !is_semver_tag(&tag) {
        return Err(fail(
            Kind::Error,
            format!("La última release de keel no tiene un tag válido: {tag}"),
        ));
    }
    Ok(tag)
}

pub enum UpdateStatus {
    UpToDate,
    Available,
    Updated,
}

/// Whether `latest` is newer than the running version.
pub fn is_newer(latest: &str, current: &str) -> bool {
    !is_semver_tag(current) || compare_desc(latest, current) == Ordering::Less
}

/// The sha256 for `asset` in a `sha256sum`-style file.
pub fn expected_sha256<'a>(sums: &'a str, asset: &str) -> Option<&'a str> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == asset).then_some(hash)
    })
}

pub async fn update(current: &str, check: bool) -> Result<(UpdateStatus, String, String)> {
    let current = format!("v{}", current.trim_start_matches('v'));
    let latest = latest_release_tag().await?;
    if !is_newer(&latest, &current) {
        return Ok((UpdateStatus::UpToDate, current, latest));
    }
    if check {
        return Ok((UpdateStatus::Available, current, latest));
    }
    let asset = asset_name()?;
    let base = format!("https://github.com/{RELEASE_REPO}/releases/download/{latest}");
    let client = http()?;
    let download = |url: String| {
        let client = client.clone();
        async move {
            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|e| fail(Kind::Network, format!("No se pudo descargar {url}: {e}")))?;
            if !response.status().is_success() {
                return Err(fail(
                    Kind::Network,
                    format!(
                        "GitHub respondió {} al descargar {url}",
                        response.status().as_u16()
                    ),
                ));
            }
            Ok::<_, anyhow::Error>(response.bytes().await?)
        }
    };
    let sums = download(format!("{base}/SHA256SUMS")).await?;
    let sums = String::from_utf8_lossy(&sums);
    let expected = expected_sha256(&sums, &asset).ok_or_else(|| {
        fail(
            Kind::Error,
            format!("La release {latest} no trae la suma de {asset}; no se instala."),
        )
    })?;
    let binary = download(format!("{base}/{asset}")).await?;
    let actual = format!("{:x}", Sha256::digest(&binary));
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(fail(
            Kind::Refused,
            format!("La suma de {asset} no coincide con SHA256SUMS; no se instala."),
        ));
    }
    let directory = tempfile_dir()?;
    let path = directory.join(&asset);
    std::fs::write(&path, &binary)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    self_replace::self_replace(&path).with_context(|| {
        format!(
            "no se pudo reemplazar el binario actual ({}); ¿permisos? Descárgalo de {base}/{asset}",
            std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        )
    })?;
    let _ = std::fs::remove_file(&path);
    Ok((UpdateStatus::Updated, current, latest))
}

fn tempfile_dir() -> Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("keel-update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_asset_for_each_platform() {
        assert_eq!(
            asset_for("macos", "aarch64").unwrap(),
            "keel-aarch64-apple-darwin"
        );
        assert_eq!(
            asset_for("linux", "x86_64").unwrap(),
            "keel-x86_64-unknown-linux-musl"
        );
        assert_eq!(
            asset_for("windows", "x86_64").unwrap(),
            "keel-x86_64-pc-windows-msvc.exe"
        );
        assert!(asset_for("freebsd", "x86_64").is_err());
    }

    #[test]
    fn reads_checksums_and_compares_versions() {
        let sums = "abc123  keel-x86_64-apple-darwin\ndef456 *keel-x86_64-pc-windows-msvc.exe\n";
        assert_eq!(
            expected_sha256(sums, "keel-x86_64-apple-darwin"),
            Some("abc123")
        );
        assert_eq!(
            expected_sha256(sums, "keel-x86_64-pc-windows-msvc.exe"),
            Some("def456")
        );
        assert_eq!(expected_sha256(sums, "keel-aarch64-apple-darwin"), None);
        assert!(is_newer("v1.2.0", "v1.1.9"));
        assert!(!is_newer("v1.2.0", "v1.2.0"));
        assert!(!is_newer("v1.2.0-rc.1", "v1.2.0"));
        assert!(is_newer("v0.1.0", "v0.0.0-dev"));
    }
}
