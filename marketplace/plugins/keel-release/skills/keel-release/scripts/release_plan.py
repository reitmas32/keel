#!/usr/bin/env python3
"""Plan a release: everything to decide before `keel create-version`, read-only.

It gathers what a release decision rests on, so nothing is guessed:

- the last release, read the way `keel last-version` reads it (the highest
  vMAJOR.MINOR.PATCH tag);
- the commits since then, parsed as Conventional Commits;
- a proposed version, from those commits (breaking → major, feat → minor,
  anything else → patch; before 1.0.0 everything moves one place down);
- the version files `.keel` lists, and whether they agree;
- the state of the branch: clean, on the release branch, in sync;
- what a tag will set off: a release workflow, a Go module version.

It changes nothing — except, with --fetch, the remote-tracking refs, the way
`git fetch` always does. The proposal is only that: a person decides.

    python3 release_plan.py [--repo DIR] [--fetch] [--json]

Exit status: 0 planned (problems are listed, not fatal), 2 not a repository.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
CONVENTIONAL = re.compile(r"^(?P<type>[a-zA-Z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<text>.+)$")
BREAKING_FOOTER = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)
FIXES = {"fix", "perf"}
WORKFLOWS = (".github/workflows/release.yml", ".github/workflows/release.yaml")


def git(root: Path, *args: str) -> tuple[int, str]:
    run = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    return run.returncode, run.stdout.strip()


def parse_version(text: str) -> tuple[int, int, int] | None:
    match = VERSION.match(text.strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def show(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version)


def count(number: int, word: str) -> str:
    return f"{number} {word}" if number == 1 else f"{number} {word}s"


# ------------------------------------------------------------------ .keel --

def read_keel(root: Path) -> dict | None:
    """The release settings from .keel — the fixed shape `keel init` writes."""
    path = root / ".keel"
    if not path.is_file():
        return None
    settings: dict = {"remote": "origin", "branch": "main", "tag_prefix": "v", "version_files": []}
    in_release = False
    in_files = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split(" #", 1)[0].rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            in_release = line.startswith("release:")
            in_files = False
            continue
        if not in_release:
            continue
        stripped = line.strip()
        if in_files and stripped.startswith("- "):
            settings["version_files"].append(stripped[2:].strip().strip("\"'"))
            continue
        key, _, value = stripped.partition(":")
        value = value.strip().strip("\"'")
        in_files = key == "version_files" and value == ""
        if key == "version_files":
            continue
        if key in settings:
            settings[key] = value
    return settings


# --------------------------------------------------------- version files --

def toml_tables(text: str) -> dict[str, list[str]]:
    """Lines by TOML table name — enough to find a version key."""
    tables: dict[str, list[str]] = {"": []}
    current = ""
    for line in text.splitlines():
        header = re.match(r"^\s*\[([^\[\]]+)\]\s*$", line)
        if header:
            current = header.group(1).strip()
            tables.setdefault(current, [])
        else:
            tables[current].append(line)
    return tables


def toml_value(lines: list[str], key: str) -> str | None:
    for line in lines:
        match = re.match(rf"^\s*{re.escape(key)}\s*=\s*[\"']([^\"']+)[\"']", line)
        if match:
            return match.group(1)
    return None


def read_version_file(root: Path, rel: str) -> dict:
    path = root / rel
    entry: dict = {"path": rel, "version": None, "note": None}
    if not path.is_file():
        entry["note"] = "listed in .keel but missing"
        return entry
    text = path.read_text(encoding="utf-8")
    name = Path(rel).name

    if name == "Cargo.toml":
        tables = toml_tables(text)
        package = tables.get("package", [])
        if any(re.match(r"^\s*version\.workspace\s*=\s*true", line) for line in package):
            entry["version"] = toml_value(tables.get("workspace.package", []), "version")
            entry["note"] = "version comes from [workspace.package]"
        else:
            entry["version"] = toml_value(package, "version") or toml_value(
                tables.get("workspace.package", []), "version"
            )
    elif name == "pyproject.toml":
        tables = toml_tables(text)
        project = tables.get("project", [])
        if any(re.match(r"^\s*dynamic\s*=.*[\"']version[\"']", line) for line in project):
            entry["note"] = "dynamic: the version comes from the tag — do not edit it"
        else:
            entry["version"] = toml_value(project, "version") or toml_value(
                tables.get("tool.poetry", []), "version"
            )
    elif name in ("package.json", "composer.json"):
        try:
            value = json.loads(text).get("version")
        except (json.JSONDecodeError, AttributeError):
            value = None
            entry["note"] = "not valid JSON"
        entry["version"] = value if isinstance(value, str) else None
        if value is None and entry["note"] is None and name == "composer.json":
            entry["note"] = "no version field: Packagist reads the tag"
    elif name == "VERSION":
        entry["version"] = text.strip() or None
    else:
        entry["note"] = "unknown format: update it by hand"
    return entry


# ------------------------------------------------------------ commits --

def commits_since(root: Path, tag: str | None) -> list[dict]:
    span = f"{tag}..HEAD" if tag else "HEAD"
    code, out = git(root, "log", "--no-merges", "--format=%h%x1f%s%x1f%b%x1e", span)
    if code != 0:
        return []
    commits = []
    for record in out.split("\x1e"):
        record = record.strip("\n")
        if not record.strip():
            continue
        short, subject, body = (record.split("\x1f") + ["", ""])[:3]
        match = CONVENTIONAL.match(subject)
        kind = match.group("type").lower() if match else None
        breaking = bool(match and match.group("bang")) or bool(BREAKING_FOOTER.search(body))
        commits.append({
            "sha": short.strip(),
            "subject": subject,
            "type": kind,
            "scope": match.group("scope") if match else None,
            "breaking": breaking,
        })
    return commits


def propose(last: tuple[int, int, int] | None, commits: list[dict], files: list[dict]) -> dict | None:
    agreed = {entry["version"] for entry in files if entry["version"]}
    file_version = parse_version(next(iter(agreed))) if len(agreed) == 1 else None

    if last is None:
        if file_version and file_version != (0, 0, 0):
            return {"version": show(file_version), "bump": "first",
                    "reason": "first release, at the version the version files already carry"}
        return {"version": "0.1.0", "bump": "first",
                "reason": "first release; 1.0.0 only if the API is declared stable"}

    if file_version and file_version > last:
        return {"version": show(file_version), "bump": "already set",
                "reason": f"the version files already say {show(file_version)}, ahead of v{show(last)}"}
    if not commits:
        return None

    major, minor, patch = last
    stable = major >= 1
    if any(commit["breaking"] for commit in commits):
        bump = "major" if stable else "minor"
        reason = "a breaking change" + ("" if stable else " before 1.0.0 moves the minor")
    elif any(commit["type"] == "feat" for commit in commits):
        bump = "minor" if stable else "patch"
        reason = "new features" + ("" if stable else " before 1.0.0 ship as a patch")
    elif any(commit["type"] in FIXES for commit in commits):
        bump, reason = "patch", "fixes only"
    else:
        bump, reason = "patch", "maintenance only — releasing is optional"

    version = {"major": (major + 1, 0, 0), "minor": (major, minor + 1, 0), "patch": (major, minor, patch + 1)}[bump]
    return {"version": show(version), "bump": bump, "reason": reason}


# --------------------------------------------------------------- plan --

def plan(root: Path, fetch: bool) -> dict:
    problems: list[str] = []
    keel = read_keel(root)
    if keel is None:
        problems.append("no .keel — run `keel init` and commit it, so the release settings are recorded")
    settings = keel or {"remote": "origin", "branch": "main", "tag_prefix": "v", "version_files": []}
    if settings["tag_prefix"] not in ("v", ""):
        problems.append(f".keel asks for tag prefix {settings['tag_prefix']!r}, but keel always tags v<version>")

    if fetch:
        code, _ = git(root, "fetch", "--quiet", settings["remote"])
        if code != 0:
            problems.append(f"could not fetch {settings['remote']} — sync state is as of the last fetch")

    _, branch = git(root, "rev-parse", "--abbrev-ref", "HEAD")
    _, status = git(root, "status", "--porcelain")
    changes = [line for line in status.splitlines() if line.strip()]
    code, upstream = git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    upstream = upstream if code == 0 else None
    ahead = behind = 0
    if upstream:
        _, counts = git(root, "rev-list", "--left-right", "--count", f"{upstream}...HEAD")
        behind, ahead = (int(part) for part in counts.split())

    if branch == "HEAD":
        problems.append("HEAD is detached — check out the release branch")
    elif branch != settings["branch"]:
        problems.append(f"on {branch}, but releases come from {settings['branch']}")
    if changes:
        problems.append(f"{count(len(changes), 'uncommitted change')} — commit or stash them first")
    if upstream is None and branch != "HEAD":
        problems.append(f"{branch} tracks no upstream")
    if behind:
        problems.append(f"{count(behind, 'commit')} behind {upstream} — pull first")

    _, tags = git(root, "tag", "--list")
    versions = sorted(
        ((parse_version(name), name) for name in tags.splitlines() if parse_version(name)),
        reverse=True,
    )
    last = versions[0][0] if versions else None
    last_tag = versions[0][1] if versions else None

    files = [read_version_file(root, rel) for rel in settings["version_files"]]
    commits = commits_since(root, last_tag)
    proposal = propose(last, commits, files)

    for entry in files:
        if entry["version"] and last and parse_version(entry["version"]) not in (last, None):
            if proposal is None or entry["version"] != proposal["version"]:
                problems.append(f"{entry['path']} says {entry['version']}, the last tag is v{show(last)}")

    go = None
    go_mod = root / "go.mod"
    if go_mod.is_file():
        match = re.search(r"^module\s+(\S+)", go_mod.read_text(encoding="utf-8"), re.MULTILINE)
        module = match.group(1) if match else None
        suffix = re.search(r"/v(\d+)$", module or "")
        go = {"module": module, "major_in_path": int(suffix.group(1)) if suffix else None}
        target = parse_version(proposal["version"]) if proposal else None
        if module and target and target[0] >= 2 and go["major_in_path"] != target[0]:
            problems.append(
                f"v{target[0]} of a Go module needs its path to end in /v{target[0]} "
                f"(go.mod says {module}) — that is its own change, not part of a release"
            )

    workflow = next((path for path in WORKFLOWS if (root / path).is_file()), None)

    return {
        "root": str(root),
        "keel": keel,
        "git": {
            "branch": branch,
            "upstream": upstream,
            "ahead": ahead,
            "behind": behind,
            "changes": changes,
        },
        "last": {"tag": last_tag, "version": show(last)} if last else None,
        "commits": commits,
        "counts": {
            "breaking": sum(commit["breaking"] for commit in commits),
            "feat": sum(commit["type"] == "feat" for commit in commits),
            "fix": sum(commit["type"] in FIXES for commit in commits),
            "other": sum(commit["type"] not in FIXES | {"feat"} for commit in commits),
        },
        "proposal": proposal,
        "version_files": files,
        "go": go,
        "release_workflow": workflow,
        "problems": problems,
    }


def render(result: dict) -> str:
    lines = []
    git_state = result["git"]
    sync = (
        f"in sync with {git_state['upstream']}" if git_state["upstream"] and not git_state["ahead"]
        and not git_state["behind"]
        else f"{git_state['ahead']} ahead, {git_state['behind']} behind {git_state['upstream']}"
        if git_state["upstream"] else "no upstream"
    )
    state = "clean" if not git_state["changes"] else count(len(git_state["changes"]), "uncommitted change")
    lines.append(f"branch          {git_state['branch']} · {state} · {sync}")
    last = result["last"]
    lines.append(f"last release    {last['tag'] if last else 'none yet'}")
    counts = result["counts"]
    lines.append(
        f"since then      {count(len(result['commits']), 'commit')}: {counts['breaking']} breaking, "
        f"{counts['feat']} feat, {counts['fix']} fix/perf, {counts['other']} other"
    )
    proposal = result["proposal"]
    lines.append(
        f"proposal        {proposal['version']} ({proposal['bump']}) — {proposal['reason']}"
        if proposal else "proposal        nothing to release"
    )
    for entry in result["version_files"]:
        lines.append(f"version file    {entry['path']} {entry['version'] or '—'}"
                     + (f" · {entry['note']}" if entry["note"] else ""))
    if not result["version_files"]:
        lines.append("version files   none — the tag is the version")
    if result["go"]:
        lines.append(f"go module       {result['go']['module']}")
    lines.append(f"release workflow {result['release_workflow'] or 'none — the tag is the release'}")
    if result["commits"]:
        lines.append("")
        lines.append("commits:")
        for commit in result["commits"]:
            mark = "!" if commit["breaking"] else " "
            lines.append(f"  {commit['sha']} {mark} {commit['subject']}")
    if result["problems"]:
        lines.append("")
        lines.append("problems:")
        lines.extend(f"  ✖ {problem}" for problem in result["problems"])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="any folder in the repository")
    parser.add_argument("--fetch", action="store_true", help="git fetch the release remote first")
    parser.add_argument("--json", action="store_true", help="print one JSON object")
    args = parser.parse_args()

    code, top = git(args.repo, "rev-parse", "--show-toplevel")
    if code != 0:
        message = f"{args.repo} is not inside a git repository"
        print(json.dumps({"error": "no_repository", "message": message}) if args.json else f"✖ {message}")
        return 2

    result = plan(Path(top), args.fetch)
    print(json.dumps(result) if args.json else render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
