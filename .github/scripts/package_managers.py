#!/usr/bin/env python3
"""Write the Homebrew formula and the Scoop manifest for a keel release.

Usage: package_managers.py <tag> <SHA256SUMS> <out-dir> [--repo owner/name]

Both point at the binaries attached to the GitHub Release, with the sums the
release job just computed, so neither needs to download anything.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

DESCRIPTION = "Versiones, deploys y operación de Dokploy desde la terminal"
LICENSE = "MIT OR Apache-2.0"

BREW_TARGETS = {
    ("macos", "arm"): "aarch64-apple-darwin",
    ("macos", "intel"): "x86_64-apple-darwin",
    ("linux", "arm"): "aarch64-unknown-linux-musl",
    ("linux", "intel"): "x86_64-unknown-linux-musl",
}
SCOOP_TARGETS = {
    "64bit": "x86_64-pc-windows-msvc",
    "arm64": "aarch64-pc-windows-msvc",
}


def read_sums(path: Path) -> dict[str, str]:
    sums: dict[str, str] = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 2:
            sums[parts[1].lstrip("*")] = parts[0]
    return sums


def asset(target: str) -> str:
    return f"keel-{target}.exe" if "windows" in target else f"keel-{target}"


def need(sums: dict[str, str], name: str) -> str:
    if name not in sums:
        sys.exit(f"SHA256SUMS no trae {name}")
    return sums[name]


def formula(tag: str, repo: str, sums: dict[str, str]) -> str:
    base = f"https://github.com/{repo}/releases/download/{tag}"
    blocks = []
    for os_name in ("macos", "linux"):
        arches = []
        for arch in ("arm", "intel"):
            name = asset(BREW_TARGETS[(os_name, arch)])
            arches.append(
                f"    on_{arch} do\n"
                f'      url "{base}/{name}"\n'
                f'      sha256 "{need(sums, name)}"\n'
                f"    end"
            )
        blocks.append(f"  on_{os_name} do\n" + "\n".join(arches) + "\n  end")
    version = tag.removeprefix("v")
    return (
        "# Generado por .github/scripts/package_managers.py en cada release; no lo edites a mano.\n"
        "class Keel < Formula\n"
        f'  desc "{DESCRIPTION}"\n'
        f'  homepage "https://github.com/{repo}"\n'
        f'  version "{version}"\n'
        f'  license any_of: ["MIT", "Apache-2.0"]\n\n'
        + "\n\n".join(blocks)
        + "\n\n"
        "  def install\n"
        '    bin.install Dir["keel-*"].first => "keel"\n'
        '    generate_completions_from_executable(bin/"keel", "completions")\n'
        "  end\n\n"
        "  test do\n"
        '    assert_match version.to_s, shell_output("#{bin}/keel --version")\n'
        "  end\n"
        "end\n"
    )


def scoop(tag: str, repo: str, sums: dict[str, str]) -> str:
    base = f"https://github.com/{repo}/releases/download/{tag}"
    auto = f"https://github.com/{repo}/releases/download/v$version"
    manifest = {
        "version": tag.removeprefix("v"),
        "description": DESCRIPTION,
        "homepage": f"https://github.com/{repo}",
        "license": LICENSE,
        "architecture": {
            arch: {
                "url": f"{base}/{asset(target)}#/keel.exe",
                "hash": need(sums, asset(target)),
            }
            for arch, target in SCOOP_TARGETS.items()
        },
        "bin": "keel.exe",
        "checkver": "github",
        "autoupdate": {
            "architecture": {
                arch: {"url": f"{auto}/{asset(target)}#/keel.exe"}
                for arch, target in SCOOP_TARGETS.items()
            },
            "hash": {"url": f"{auto}/SHA256SUMS", "regex": "$sha256\\s+\\*?$basename"},
        },
    }
    return json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag")
    parser.add_argument("sums", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--repo", default="reitmas32/keel")
    args = parser.parse_args()
    if not re.fullmatch(r"v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", args.tag):
        sys.exit(f"tag inválido: {args.tag}")
    sums = read_sums(args.sums)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "keel.rb").write_text(formula(args.tag, args.repo, sums))
    (args.out / "keel.json").write_text(scoop(args.tag, args.repo, sums))
    print(f"keel.rb y keel.json para {args.tag} en {args.out}")


if __name__ == "__main__":
    main()
