#!/usr/bin/env python3
"""Validate the marketplace: its catalogue, every plugin, every skill.

Each rule here exists because some agent depends on it:

- Claude Code, Copilot CLI and Codex all read .claude-plugin/marketplace.json,
  and Codex only follows plugin sources written as relative string paths.
- Codex, Copilot and VS Code read the Agent Plugins plugin.json at a plugin's
  root; Claude Code reads .claude-plugin/plugin.json.
- Every agent reads SKILL.md by the Agent Skills format: the name matches the
  folder, the description says when to use the skill.
- keel installs by skill name, so a name offered twice is ambiguous.

Standard library only, except that PyYAML is used when it is installed — it
parses frontmatter the way the agents do, where the fallback reader is only
approximate. CI installs it.

    python3 plugins/scripts/validate.py [--root DIR]

Exit status: 0 valid, 1 not.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
TAG = re.compile(r"<[A-Za-z/!][^>]*>")
MARKDOWN_LINK = re.compile(r"\]\(([^)\s#]+)(?:#[^)]*)?\)")
FENCED_BLOCK = re.compile(r"^(\s*)(`{3,}|~{3,}).*?^\1\2[ \t]*$", re.DOTALL | re.MULTILINE)
INLINE_CODE = re.compile(r"(`+).+?\1")
RESERVED = ("anthropic", "claude")
BODY_LINES = 500

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - exercised where PyYAML is missing
    yaml = None


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, where: str, message: str) -> None:
        self.errors.append(f"{where}: {message}")

    def warn(self, where: str, message: str) -> None:
        self.warnings.append(f"{where}: {message}")


def read_json(path: Path, report: Report, where: str) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        report.error(where, f"{path.name} is missing")
        return None
    except (json.JSONDecodeError, UnicodeDecodeError) as why:
        report.error(where, f"{path.name} is not valid JSON: {why}")
        return None
    if not isinstance(value, dict):
        report.error(where, f"{path.name} is not a JSON object")
        return None
    return value


def frontmatter(text: str) -> tuple[dict, str]:
    """(fields, body). Raises ValueError when there is no closed block."""
    if not text.startswith("---"):
        raise ValueError("SKILL.md must start with --- frontmatter")
    lines = text.splitlines()
    try:
        end = next(i for i, line in enumerate(lines[1:], start=1) if line.strip() == "---")
    except StopIteration:
        raise ValueError("the frontmatter is never closed") from None
    block = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1 :])
    if yaml is not None:
        try:
            fields = yaml.safe_load(block) or {}
        except yaml.YAMLError as why:
            raise ValueError(f"the frontmatter is not valid YAML: {why}") from None
        if not isinstance(fields, dict):
            raise ValueError("the frontmatter is not a mapping")
        return fields, body
    return fallback_frontmatter(block), body


def fallback_frontmatter(block: str) -> dict:
    """Enough YAML for SKILL.md when PyYAML is not installed."""
    fields: dict = {}
    current = None
    for raw in block.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if raw[0] in " \t" and current is not None:
            key, _, value = raw.strip().partition(":")
            if isinstance(fields[current], dict) and value:
                fields[current][key.strip()] = value.strip().strip("\"'")
            elif isinstance(fields[current], str):
                fields[current] = (fields[current] + " " + raw.strip()).strip()
            continue
        key, _, value = raw.partition(":")
        current = key.strip()
        value = value.strip()
        if value in ("", "|", ">", "|-", ">-"):
            fields[current] = {} if value == "" else ""
        else:
            fields[current] = value.strip("\"'")
    return {key: ("" if value == {} else value) for key, value in fields.items()}


def check_skill(skill_dir: Path, report: Report) -> dict | None:
    where = str(skill_dir)
    skill_md = skill_dir / "SKILL.md"
    try:
        text = skill_md.read_text(encoding="utf-8")
    except FileNotFoundError:
        report.error(where, "no SKILL.md")
        return None
    try:
        fields, body = frontmatter(text)
    except ValueError as why:
        report.error(where, str(why))
        return None

    name = fields.get("name")
    if not isinstance(name, str) or not NAME.match(name) or len(name) > 64:
        report.error(where, f"name {name!r} must be a-z, 0-9 and single hyphens, up to 64")
    elif name != skill_dir.name:
        report.error(where, f"name {name!r} must match its folder {skill_dir.name!r}")
    elif any(word in name for word in RESERVED):
        report.error(where, f"name {name!r} uses a word Claude Code reserves")

    description = fields.get("description")
    if not isinstance(description, str) or not description.strip():
        report.error(where, "description is missing")
    else:
        if len(description) > 1024:
            report.error(where, f"description is {len(description)} characters; the limit is 1024")
        if TAG.search(description):
            report.error(where, "description contains an XML tag, which Claude Code rejects")
        if "use when" not in description.lower() and "use it when" not in description.lower():
            report.warn(where, "description never says when to use the skill (\"Use when …\")")

    compatibility = fields.get("compatibility")
    if compatibility is not None and (not isinstance(compatibility, str) or len(compatibility) > 500):
        report.error(where, "compatibility must be text of at most 500 characters")

    metadata = fields.get("metadata")
    version = None
    if metadata is not None:
        if not isinstance(metadata, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in metadata.items()
        ):
            report.error(where, "metadata must map strings to strings — quote numbers like \"0.1.0\"")
        else:
            version = metadata.get("version")
    if not isinstance(version, str) or not SEMVER.match(version):
        report.error(where, f"metadata.version {version!r} must be a semantic version, quoted")

    if len(body.splitlines()) > BODY_LINES:
        report.warn(where, f"SKILL.md body is over {BODY_LINES} lines — move detail to references/")

    # Links shown as examples, in code, are not links the skill depends on.
    prose = INLINE_CODE.sub("", FENCED_BLOCK.sub("", body))
    for target in MARKDOWN_LINK.findall(prose):
        if "://" in target or target.startswith(("mailto:", "#")):
            continue
        if not (skill_dir / target).exists():
            report.error(where, f"SKILL.md links to {target}, which is not in the skill")

    # Compiled in memory: py_compile would leave a __pycache__ in the skill,
    # and whatever is in the folder gets installed.
    for script in skill_dir.rglob("*.py"):
        try:
            compile(script.read_text(encoding="utf-8"), str(script), "exec")
        except (SyntaxError, UnicodeDecodeError) as why:
            report.error(str(script), f"does not compile: {why}")

    return {"name": name, "version": version}


def check_plugin(root: Path, entry: dict, report: Report) -> list[str]:
    name = entry.get("name")
    where = f"plugin {name!r}"
    if not isinstance(name, str) or not NAME.match(name):
        report.error(where, "name must be a-z, 0-9 and single hyphens")
        return []

    source = entry.get("source")
    if not isinstance(source, str) or not source.startswith("./"):
        report.error(where, "source must be a relative path such as \"./plugins/<name>\" — Codex skips any other kind")
        return []
    plugin_dir = (root / source).resolve()
    if root.resolve() not in plugin_dir.parents and plugin_dir != root.resolve():
        report.error(where, "source points outside the marketplace")
        return []
    if not plugin_dir.is_dir():
        report.error(where, f"source {source} does not exist")
        return []

    for key in ("description", "version", "category"):
        if not entry.get(key):
            report.error(where, f"the marketplace entry has no {key}")
    version = entry.get("version")

    agent_plugins = read_json(plugin_dir / "plugin.json", report, where)
    claude = read_json(plugin_dir / ".claude-plugin" / "plugin.json", report, where)
    if agent_plugins is not None and agent_plugins.get("$schema") != AGENT_PLUGINS_SCHEMA:
        report.error(where, f"plugin.json $schema must be {AGENT_PLUGINS_SCHEMA}")
    for label, manifest in (("plugin.json", agent_plugins), (".claude-plugin/plugin.json", claude)):
        if manifest is None:
            continue
        if manifest.get("name") != name:
            report.error(where, f"{label} is named {manifest.get('name')!r}, not {name!r}")
        if manifest.get("version") != version:
            report.error(where, f"{label} is version {manifest.get('version')!r}, the entry says {version!r}")
        if not manifest.get("description"):
            report.error(where, f"{label} has no description")

    skills_dir = plugin_dir / "skills"
    skill_dirs = sorted(path for path in skills_dir.iterdir() if path.is_dir()) if skills_dir.is_dir() else []
    if not skill_dirs:
        report.error(where, "has no skills/<skill>/SKILL.md")
    names = []
    for skill_dir in skill_dirs:
        skill = check_skill(skill_dir, report)
        if skill is None:
            continue
        names.append(skill["name"])
        if len(skill_dirs) == 1 and skill["version"] and version and skill["version"] != version:
            report.error(str(skill_dir), f"version {skill['version']} differs from its plugin's {version}")
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    root: Path = args.root
    report = Report()

    catalogue = read_json(root / ".claude-plugin" / "marketplace.json", report, "marketplace")
    offered: dict[str, str] = {}
    if catalogue is not None:
        if not isinstance(catalogue.get("name"), str) or not NAME.match(catalogue["name"]):
            report.error("marketplace", "name must be a-z, 0-9 and single hyphens")
        if not isinstance(catalogue.get("owner"), dict) or not catalogue["owner"].get("name"):
            report.error("marketplace", "owner.name is required")
        plugins = catalogue.get("plugins")
        if not isinstance(plugins, list) or not plugins:
            report.error("marketplace", "plugins must be a non-empty list")
            plugins = []
        seen_plugins = set()
        for entry in plugins:
            if not isinstance(entry, dict):
                report.error("marketplace", "every plugin entry must be an object")
                continue
            if entry.get("name") in seen_plugins:
                report.error("marketplace", f"plugin {entry.get('name')!r} is listed twice")
            seen_plugins.add(entry.get("name"))
            for skill in check_plugin(root, entry, report):
                if skill in offered:
                    report.error("marketplace", f"skill {skill!r} is offered by {offered[skill]!r} and {entry['name']!r}")
                offered[skill] = entry["name"]

    # A skill folder no catalogue entry reaches would never be installable.
    for skill_md in sorted((root / "plugins").glob("*/skills/*/SKILL.md")):
        if skill_md.parent.name not in offered:
            report.error(str(skill_md.parent), "no marketplace entry reaches this skill")

    for warning in report.warnings:
        print(f"WARN   {warning}")
    for error in report.errors:
        print(f"ERROR  {error}")
    if yaml is None:
        print("note   PyYAML is not installed; frontmatter was read approximately (pip install pyyaml)")
    if report.errors:
        print(f"✖ {len(report.errors)} errors, {len(report.warnings)} warnings")
        return 1
    print(f"✔ {len(offered)} skills in {len(catalogue.get('plugins', [])) if catalogue else 0} plugins are valid"
          + (f" · {len(report.warnings)} warnings" if report.warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
