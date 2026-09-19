#!/usr/bin/env python3
"""Audit a repository's keel release setup: the half of a release it owns.

A keel release has two witnesses. `keel create-version` tags, pushes, and
reports the version to keel-api from the machine that tagged it. The
repository's Release workflow then checks the tagged commit and reports the
same version with the repository's CI credential — the report that confirms
it. This checks everything the second witness depends on:

- .keel, as `keel init` writes it, agreeing with the origin remote;
- .github/workflows/release.yml in the shape the report relies on: a v*.*.*
  tag trigger, a manual run for an existing tag, one run per tag and none
  cancelled, a verify job, and a report job that runs whether verify passed
  or failed and hands report-version.sh everything it reads;
- .github/scripts/report-version.sh, executable and byte for byte keel-api's
  canonical script: the copy bundled with this skill, or --canonical;
- docs/releases.md, listed in docs/README.md, when there is a docs/;
- dist/ git-ignored, since `keel docs` writes the site there;
- a CI workflow besides the release one.

It reads files and asks git. It changes nothing and never uses the network,
so the one thing it cannot see — the KEEL_CI_TOKEN secret — is for
`gh secret list` to confirm.

Standard library only, so it runs wherever python3 does.

    python3 check_setup.py [REPO] [--canonical FILE] [--strict] [--json]

Exit status: 0 set up (warnings allowed), 1 errors (or warnings with
--strict), 2 when REPO is not a git repository or --canonical is unreadable.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
ASSETS = SKILL / "assets"
BUNDLED_SCRIPT = ASSETS / "report-version.sh"
BUNDLED_SUM = ASSETS / "report-version.sh.sha256"
TEMPLATE = ASSETS / "release.yml"
PAGE_TEMPLATE = ASSETS / "releases.md"

KEEL = ".keel"
RELEASE_WORKFLOWS = (".github/workflows/release.yml", ".github/workflows/release.yaml")
SCRIPT = ".github/scripts/report-version.sh"
DOCS = "docs"
RELEASES = "docs/releases.md"
INDEX = "docs/README.md"

TAG_PATTERN = "v*.*.*"
SAMPLE_TAG = "v1.4.0"
REPORT_ENV = ("KEEL_API_URL", "KEEL_CI_TOKEN", "KEEL_TAG", "KEEL_STATUS", "KEEL_CHECKS")
# Triggers with no tag behind them: the report job would have nothing to report.
TAGLESS_EVENTS = ("pull_request", "pull_request_target", "schedule", "merge_group")
# What a repository is, by the file at its root that says so.
KINDS = (
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("package.json", "node"),
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("composer.json", "php"),
)


# --------------------------------------------------------------- YAML --

class YamlError(ValueError):
    """A line the reader cannot follow."""

    def __init__(self, line: int, reason: str) -> None:
        super().__init__(f"line {line}: {reason}")
        self.line = line
        self.reason = reason


class Unclosed(YamlError):
    """A quote or bracket still open at the end of the text read so far."""


class Map(dict):
    """A mapping that remembers the line each of its keys is on."""

    def __init__(self) -> None:
        super().__init__()
        self.lines: dict[str, int] = {}


ESCAPES = {
    "0": "\0", "a": "\a", "b": "\b", "t": "\t", "\t": "\t", "n": "\n", "v": "\v",
    "f": "\f", "r": "\r", "e": "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\",
    "N": "\x85", "_": "\xa0", "L": chr(0x2028), "P": chr(0x2029),
}
HEX_ESCAPES = {"x": 2, "u": 4, "U": 8}
BOM = chr(0xFEFF)


def spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def is_item(content: str) -> bool:
    """Whether a line's content opens a block sequence item."""
    return content == "-" or content.startswith("- ")


def plain(text: str) -> str:
    """A plain scalar without its trailing comment."""
    match = re.search(r"[ \t]#", text)
    return (text[: match.start()] if match else text).strip()


def quoted(text: str, number: int) -> tuple[str, str]:
    """The quoted scalar `text` starts with: (its value, what follows it)."""
    quote, out, index = text[0], [], 1
    while index < len(text):
        char = text[index]
        if quote == "'":
            if char == "'":
                if text.startswith("''", index):
                    out.append("'")
                    index += 2
                    continue
                return "".join(out), text[index + 1 :]
        elif char == "\\":
            code = text[index + 1 : index + 2]
            if code in HEX_ESCAPES:
                digits = text[index + 2 : index + 2 + HEX_ESCAPES[code]]
                if len(digits) != HEX_ESCAPES[code] or not all(c in "0123456789abcdefABCDEF" for c in digits):
                    raise YamlError(number, f"a bad escape \\{code}{digits}")
                out.append(chr(int(digits, 16)))
                index += 2 + HEX_ESCAPES[code]
                continue
            if code not in ESCAPES:
                raise YamlError(number, f"an unknown escape \\{code}")
            out.append(ESCAPES[code])
            index += 2
            continue
        elif char == '"':
            return "".join(out), text[index + 1 :]
        out.append(char)
        index += 1
    raise Unclosed(number, "a quoted value is never closed")


def split_key(content: str, number: int) -> tuple[str, str] | None:
    """(key, the rest of the line) when `content` opens a mapping entry."""
    if content[:1] in ("'", '"'):
        try:
            key, rest = quoted(content, number)
        except YamlError:
            return None
        rest = rest.lstrip(" \t")
        if rest == ":" or rest.startswith((": ", ":\t")):
            return key, rest[1:]
        return None
    if not content or content[0] in "[]{},#&*!|>%@`?":
        return None
    match = re.search(r":(?:[ \t]|$)", content)
    if not match:
        return None
    key = content[: match.start()].rstrip()
    if not key or re.search(r"[ \t]#", key):
        return None
    return key, content[match.end() :]


class Flow:
    """A flow collection — `[a, "b"]`, `{ref: x}` — possibly over lines."""

    def __init__(self, text: str, number: int) -> None:
        self.text, self.number, self.index = text, number, 0

    def at(self) -> str:
        return self.text[self.index : self.index + 1]

    def skip(self) -> None:
        while self.index < len(self.text):
            char = self.text[self.index]
            if char in " \t\n":
                self.index += 1
            elif char == "#" and (self.index == 0 or self.text[self.index - 1] in " \t\n"):
                end = self.text.find("\n", self.index)
                self.index = len(self.text) if end == -1 else end
            else:
                return

    def value(self):
        self.skip()
        char = self.at()
        if char == "[":
            return self.sequence()
        if char == "{":
            return self.mapping()
        if char in ("'", '"'):
            value, rest = quoted(self.text[self.index :], self.number)
            self.index = len(self.text) - len(rest)
            return value
        start = self.index
        while self.index < len(self.text):
            char = self.text[self.index]
            if char in ",]}\n":
                break
            if char == ":" and self.text[self.index + 1 : self.index + 2] in ("", " ", "\t", "\n", ",", "]", "}"):
                break
            if char == "#" and self.index > start and self.text[self.index - 1] in " \t":
                break
            self.index += 1
        return self.text[start : self.index].strip()

    def sequence(self) -> list:
        self.index += 1
        items: list = []
        while True:
            self.skip()
            if self.index >= len(self.text):
                raise Unclosed(self.number, "a [ is never closed")
            if self.at() == "]":
                self.index += 1
                return items
            items.append(self.value())
            self.skip()
            if self.at() == ",":
                self.index += 1
            elif self.at() != "]":
                if self.index >= len(self.text):
                    raise Unclosed(self.number, "a [ is never closed")
                raise YamlError(self.number, "expected , or ] in a flow sequence")

    def mapping(self) -> Map:
        self.index += 1
        result = Map()
        while True:
            self.skip()
            if self.index >= len(self.text):
                raise Unclosed(self.number, "a { is never closed")
            if self.at() == "}":
                self.index += 1
                return result
            key = str(self.value())
            self.skip()
            value = None
            if self.at() == ":":
                self.index += 1
                value = self.value()
            result[key] = value
            result.lines[key] = self.number
            self.skip()
            if self.at() == ",":
                self.index += 1
            elif self.at() != "}":
                if self.index >= len(self.text):
                    raise Unclosed(self.number, "a { is never closed")
                raise YamlError(self.number, "expected , or } in a flow mapping")


class Reader:
    """Enough YAML for GitHub workflows and .keel: block mappings and
    sequences (compact ones included), flow collections, plain and quoted
    scalars, block scalars and comments. Every scalar stays a string, so the
    key `on` is "on" and never true. Anchors, aliases, tags and multiple
    documents are refused rather than guessed at."""

    def __init__(self, text: str) -> None:
        self.lines = text.lstrip(BOM).replace("\r\n", "\n").split("\n")
        self.index = 0

    def load(self):
        self.skip(top=True)
        if self.index >= len(self.lines):
            return None
        value = self.block(spaces(self.lines[self.index]))
        self.skip()
        if self.index < len(self.lines):
            number = self.index + 1
            if self.lines[self.index].rstrip() in ("---", "..."):
                raise YamlError(number, "a second document — one file, one document")
            raise YamlError(number, "this line is indented less than the document")
        return value

    def skip(self, top: bool = False) -> None:
        while self.index < len(self.lines):
            raw = self.lines[self.index]
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or (top and (raw.rstrip() == "---" or raw.startswith("%"))):
                self.index += 1
                continue
            lead = raw[: len(raw) - len(raw.lstrip(" \t"))]
            if "\t" in lead:
                raise YamlError(self.index + 1, "a tab in the indentation — YAML indents with spaces")
            return

    def block(self, indent: int):
        number = self.index + 1
        content = self.lines[self.index][indent:]
        if is_item(content):
            return self.sequence(indent)
        if split_key(content, number) is not None:
            return self.mapping(indent)
        self.index += 1
        return self.scalar(content.strip(), indent - 1, number)

    def mapping(self, indent: int) -> Map:
        result = Map()
        while True:
            self.skip()
            if self.index >= len(self.lines):
                return result
            raw = self.lines[self.index]
            here = spaces(raw)
            if here < indent or raw.rstrip() in ("---", "..."):
                return result
            number = self.index + 1
            if here > indent:
                raise YamlError(number, "indented deeper than the keys around it")
            content = raw[here:]
            if is_item(content):
                raise YamlError(number, "a list item where a key was expected")
            entry = split_key(content, number)
            if entry is None:
                raise YamlError(number, "expected key: value")
            key, rest = entry
            if key in result:
                raise YamlError(number, f"{key!r} is given twice")
            self.index += 1
            result.lines[key] = number
            result[key] = self.value(rest, indent, number)

    def sequence(self, indent: int) -> list:
        items: list = []
        while True:
            self.skip()
            if self.index >= len(self.lines):
                return items
            raw = self.lines[self.index]
            here = spaces(raw)
            if here < indent or raw.rstrip() in ("---", "..."):
                return items
            number = self.index + 1
            if here > indent:
                raise YamlError(number, "indented deeper than the items around it")
            content = raw[here:]
            if not is_item(content):
                return items
            after = content[1:]
            text = after.strip()
            if not text or text.startswith("#"):
                self.index += 1
                items.append(self.value("", indent, number, compact=False))
                continue
            if is_item(text) or split_key(text, number) is not None:
                # The item is a mapping, or a list, whose first line is this
                # one: read it as if the dash were a space.
                column = here + 1 + spaces(after)
                self.lines[self.index] = " " * column + text
                items.append(self.block(column))
            else:
                self.index += 1
                items.append(self.scalar(text, indent, number))

    def value(self, rest: str, parent: int, number: int, compact: bool = True):
        """What follows `key:` (or a bare `-`): inline, or the block below."""
        text = rest.strip()
        if text and not text.startswith("#"):
            return self.scalar(text, parent, number)
        self.skip()
        if self.index >= len(self.lines):
            return None
        raw = self.lines[self.index]
        here = spaces(raw)
        if here > parent:
            return self.block(here)
        if compact and here == parent and is_item(raw[here:]):
            return self.sequence(here)
        return None

    def scalar(self, text: str, parent: int, number: int):
        first = text[0]
        if first in "|>":
            return self.block_scalar(text, parent, number)
        if first in "[{":
            return self.flow(text, number)
        if first in ("'", '"'):
            return self.quoted(text, number)
        if first in "&*!%@`":
            raise YamlError(number, f"{text[:20]!r} starts with {first!r}, which YAML reserves "
                                    "(anchors, aliases, tags) — quote it, or wrap an expression in ${{ }}")
        parts = [plain(text)]
        # A plain scalar continues on the lines indented under it.
        while self.index < len(self.lines):
            raw = self.lines[self.index]
            stripped = raw.strip()
            if not stripped or stripped.startswith("#") or spaces(raw) <= parent:
                break
            if split_key(stripped, self.index + 1) is not None:
                raise YamlError(self.index + 1, "a key indented under a value — check the indentation")
            parts.append(plain(stripped))
            self.index += 1
        return " ".join(parts)

    def quoted(self, text: str, number: int) -> str:
        joined = text
        while True:
            try:
                value, rest = quoted(joined, number)
                break
            except Unclosed:
                if self.index >= len(self.lines):
                    raise
                following = self.lines[self.index].strip()
                self.index += 1
                if not following:
                    joined += "\n"
                else:
                    joined += following if joined.endswith("\n") else " " + following
        rest = rest.strip()
        if rest and not rest.startswith("#"):
            raise YamlError(number, "text after a quoted value")
        return value

    def flow(self, text: str, number: int):
        joined = text
        while True:
            reader = Flow(joined, number)
            try:
                value = reader.value()
                break
            except Unclosed:
                if self.index >= len(self.lines):
                    raise
                joined += "\n" + self.lines[self.index]
                self.index += 1
        rest = joined[reader.index :].strip()
        if rest and not rest.startswith("#"):
            raise YamlError(number, "text after a flow collection")
        return value

    def block_scalar(self, header: str, parent: int, number: int) -> str:
        match = re.match(r"^([|>])([1-9]?)([+-]?)([1-9]?)\s*(?:#.*)?$", header)
        if not match:
            raise YamlError(number, f"a block scalar header {header!r} it cannot read")
        style, chomp = match.group(1), match.group(3)
        explicit = match.group(2) or match.group(4)
        content = parent + int(explicit) if explicit and parent >= 0 else None
        lines: list[str] = []
        while self.index < len(self.lines):
            raw = self.lines[self.index]
            if not raw.strip():
                lines.append("")
                self.index += 1
                continue
            here = spaces(raw)
            if content is None:
                if here <= parent:
                    break
                content = here
            if here < content:
                break
            lines.append(raw[content:])
            self.index += 1
        trailing = 0
        while lines and lines[-1] == "":
            lines.pop()
            trailing += 1
        if not lines:
            return ""
        if style == "|":
            body = "\n".join(lines)
        else:
            # Folding: a single line break between two text lines becomes a
            # space; empty lines stay line breaks; more-indented lines are
            # never folded.
            body, empty, started, indented = "", 0, False, False
            for line in lines:
                if not line:
                    empty += 1
                    continue
                if line[0] in " \t":
                    body += "\n" * (empty + 1 if started else empty)
                    indented = True
                elif indented:
                    body += "\n" * (empty + 1)
                    indented = False
                elif empty:
                    body += "\n" * empty
                elif started:
                    body += " "
                body += line
                empty, started = 0, True
        if chomp == "-":
            return body
        if chomp == "+":
            return body + "\n" * (trailing + 1)
        return body + "\n"


def load_yaml(text: str):
    return Reader(text).load()


# ------------------------------------------------------------ helpers --

@dataclass
class Finding:
    level: str  # "error" or "warn"
    path: str
    line: int | None
    code: str
    message: str
    details: dict | None = None


def git(root: Path, *args: str) -> tuple[int, str]:
    try:
        run = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    except OSError:
        return 127, ""
    return run.returncode, run.stdout.strip()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def github_slug(url: str) -> str | None:
    """`owner/name` when the URL points at GitHub — the way keel reads it."""
    url = url.strip().rstrip("/")
    if "://" in url:
        after = url.split("://", 1)[1]
        authority = after.split("/", 1)[0]
        if "@" in authority:
            after = after.split("@", 1)[1]
        host, _, path = after.partition("/")
    else:
        after = url.split("@", 1)[1] if "@" in url.split(":", 1)[0] else url
        host, _, path = after.partition(":")
    if host.split(":", 1)[0].lower() not in ("github.com", "www.github.com") or not path:
        return None
    if path.endswith(".git"):
        path = path[:-4]
    parts = path.split("/")
    if len(parts) != 2 or not all(parts):
        return None
    return "/".join(parts)


def redact(url: str) -> str:
    """The URL without any credential in it: a remote may carry a token."""
    def hide(match: re.Match) -> str:
        return match.group(0) if match.group(2) == "git" else match.group(1) + "***@"

    return re.sub(r"^([a-zA-Z][a-zA-Z0-9+.-]*://)([^/@]+)@", hide, url)


def line_of(node, key: str) -> int | None:
    """The line a key of a parsed mapping is on, when the reader knows it."""
    return getattr(node, "lines", {}).get(key)


def strings(value) -> list[str]:
    """A YAML value that may be one string or a list of them."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def squash(value) -> str:
    """An expression with its whitespace removed, for comparing."""
    return "".join(str(value).split()) if value is not None else ""


def triggers(value) -> dict:
    if isinstance(value, str):
        return {value: None}
    if isinstance(value, list):
        return {item: None for item in value if isinstance(item, str)}
    if isinstance(value, dict):
        return value
    return {}


def glob_match(pattern: str, text: str) -> bool:
    """Whether a GitHub Actions ref filter matches `text`."""
    regex, index = "", 0
    while index < len(pattern):
        char = pattern[index]
        if pattern.startswith("**", index):
            regex, index = regex + ".*", index + 2
            continue
        if char == "*":
            regex += "[^/]*"
        elif char in "?+":
            regex += char
        elif char == "[" and "]" in pattern[index:]:
            end = pattern.index("]", index)
            regex, index = regex + pattern[index : end + 1], end + 1
            continue
        elif char == "\\" and index + 1 < len(pattern):
            regex, index = regex + re.escape(pattern[index + 1]), index + 2
            continue
        else:
            regex += re.escape(char)
        index += 1
    try:
        return re.fullmatch(regex, text) is not None
    except re.error:
        return False


def differences(a, b, path: str = "") -> list[str]:
    """Where two parsed YAML values differ, as dotted paths."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in list(a) + [key for key in b if key not in a]:
            where = f"{path}.{key}" if path else str(key)
            if key not in a or key not in b:
                out.append(where)
            else:
                out.extend(differences(a[key], b[key], where))
        return out
    if isinstance(a, list) and isinstance(b, list):
        out = []
        for index in range(max(len(a), len(b))):
            where = f"{path}[{index}]"
            if index >= len(a) or index >= len(b):
                out.append(where)
            else:
                out.extend(differences(a[index], b[index], where))
        return out
    return [] if a == b else [path or "the whole job"]


def front_matter(text: str) -> dict:
    lines = text.lstrip(BOM).splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    found = {}
    for line in lines[1:]:
        if line.strip() in ("---", "..."):
            return found
        key, sep, value = line.partition(":")
        if sep and not line.startswith((" ", "\t", "#")):
            found[key.strip()] = value.strip().strip("\"'")
    return {}


def link_to_releases(target: str) -> bool:
    target = target.strip("<>").split("#", 1)[0].split("?", 1)[0]
    while target.startswith("./"):
        target = target[2:]
    return target in ("releases.md", "releases")


def index_listing(text: str) -> str:
    """How docs/README.md links releases.md: "list" when a list or a table
    does (keel's sidebar), "prose" when only a paragraph does, else "none"."""
    found, fence = "none", None
    for line in text.splitlines():
        opener = re.match(r"^\s*(`{3,}|~{3,})", line)
        if fence:
            if opener and opener.group(1)[0] == fence[0] and len(opener.group(1)) >= len(fence):
                fence = None
            continue
        if opener:
            fence = opener.group(1)
            continue
        text_only = re.sub(r"(`+).+?\1", "", line)
        if any(link_to_releases(target) for target in re.findall(r"\]\(\s*([^)\s]+)", text_only)):
            if re.match(r"^\s*(?:[-*+]|\d{1,9}[.)])\s", line) or line.lstrip().startswith("|") \
                    or re.match(r"^ {2,}\S", line):
                return "list"
            found = "prose"
    return found


def shown(path: Path) -> str:
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if home not in ("", "/") and text.startswith(home + os.sep) else text


# -------------------------------------------------------------- audit --

class Audit:
    def __init__(self, root: Path, canonical: bytes | None, canonical_label: str,
                 canonical_given: bool = False) -> None:
        self.root = root
        self.canonical = canonical
        self.canonical_label = canonical_label
        self.canonical_given = canonical_given
        self.findings: list[Finding] = []
        self.facts: dict = {"root": str(root)}
        self.slug: str | None = None
        self.remotes: list[str] = []
        self.head = git(root, "rev-parse", "--verify", "-q", "HEAD")[0] == 0
        self.dispatch_tag = False
        self.index: dict[str, str] | None = None

    def add(self, level: str, path: str, code: str, message: str,
            line: int | None = None, details: dict | None = None) -> None:
        self.findings.append(Finding(level, path, line, code, message, details))

    def error(self, path: str, code: str, message: str, **extra) -> None:
        self.add("error", path, code, message, **extra)

    def warn(self, path: str, code: str, message: str, **extra) -> None:
        self.add("warn", path, code, message, **extra)

    def index_mode(self, rel: str) -> str | None:
        """The mode git records for a file, or None when git does not track it."""
        if self.index is None:
            # One question for every file this audit looks at: staged counts.
            code, out = git(self.root, "ls-files", "-s", "-z", "--", KEEL, ".github", DOCS)
            self.index = {}
            for entry in out.split("\0") if code == 0 else []:
                meta, _, name = entry.partition("\t")
                if name:
                    self.index[name] = meta.split()[0]
        return self.index.get(rel)

    def untracked(self, rel: str, why: str) -> bool:
        if self.index_mode(rel) is None:
            self.warn(rel, "untracked", f"{rel} is not tracked by git — {why}")
            return True
        return False

    def run(self) -> None:
        self.check_repository()
        self.check_keel()
        self.check_release_workflow()
        self.check_script()
        self.check_docs()
        self.check_dist()
        self.check_ci()

    # ------------------------------------------------------ repository --

    def check_repository(self) -> None:
        kinds: list[str] = []
        for name, kind in KINDS:
            if (self.root / name).is_file() and kind not in kinds:
                kinds.append(kind)
        module = None
        if (self.root / "go.mod").is_file():
            match = re.search(r"^module\s+(\S+)", (self.root / "go.mod").read_text(encoding="utf-8", errors="replace"),
                              re.MULTILINE)
            module = match.group(1).strip("\"") if match else None
        self.facts["kind"] = kinds
        self.facts["go_module"] = module
        self.facts["head"] = self.head

        self.remotes = git(self.root, "remote")[1].split()
        code, url = git(self.root, "config", "--get", "remote.origin.url")
        url = url if code == 0 else ""
        self.slug = github_slug(url) if url else None
        self.facts["origin"] = {
            "url": redact(url) if url else None,
            "repository": self.slug,
            "name": self.slug.split("/")[1] if self.slug else None,
        }
        if not url:
            self.error("origin", "no-origin",
                       "there is no origin remote — keel create-version pushes the tag there, and the "
                       "Release workflow runs on GitHub: add the repository's GitHub remote as origin")
        elif not self.slug:
            self.error("origin", "origin-not-github",
                       f"origin is {redact(url)}, not a GitHub repository — keel create-version tags for "
                       "GitHub only, and the Release workflow is a GitHub Actions workflow")

    # ------------------------------------------------------------ .keel --

    def check_keel(self) -> None:
        path = self.root / KEEL
        self.facts["keel"] = None
        if not path.is_file():
            if self.head:
                message = ("no .keel — run `keel init --dry-run`, review what it would write, "
                           "then `keel init`")
            else:
                message = ("no .keel, and `keel init` cannot write one yet: it reads HEAD, and this "
                           "repository has no commit — the first commit is the user's to make")
            self.error(KEEL, "keel-missing", message)
            return
        try:
            settings = load_yaml(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            self.error(KEEL, "keel-unparseable", ".keel is not UTF-8 — regenerate it with `keel init --force`")
            return
        except YamlError as why:
            self.error(KEEL, "keel-unparseable",
                       f".keel cannot be read: {why.reason} — regenerate it with `keel init --force`",
                       line=why.line)
            return
        tracked = self.index_mode(KEEL) is not None
        self.facts["keel"] = {"path": KEEL, "tracked": tracked,
                              "settings": settings if isinstance(settings, dict) else None}
        if not isinstance(settings, dict):
            self.error(KEEL, "keel-shape", ".keel holds no settings — regenerate it with `keel init --force`")
            return

        project = settings.get("project") if isinstance(settings.get("project"), dict) else {}
        release = settings.get("release") if isinstance(settings.get("release"), dict) else {}
        missing = []
        if not isinstance(project.get("name"), str) or not project.get("name"):
            missing.append("project.name")
        if not release:
            missing.append("release")
        else:
            for key in ("remote", "branch", "tag_prefix"):
                if not isinstance(release.get(key), str) or not release.get(key):
                    missing.append(f"release.{key}")
            files = release.get("version_files")
            if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
                missing.append("release.version_files")
        if missing:
            self.error(KEEL, "keel-shape",
                       f".keel has no {', '.join(missing)} — `keel init` writes every one of them: "
                       "compare with `keel init --dry-run`, then fix it or regenerate it with `keel init --force`")

        repository = project.get("repository")
        if self.slug:
            name = self.slug.split("/")[1]
            if not isinstance(repository, str) or not repository:
                self.error(KEEL, "keel-repository",
                           f".keel has no project.repository — origin is {self.slug}, which keel init records",
                           line=line_of(settings, "project"))
            elif repository.lower() != self.slug.lower():
                self.error(KEEL, "keel-repository",
                           f"project.repository is {repository}, but origin is {self.slug}",
                           line=line_of(project, "repository"))
            project_name = project.get("name")
            if isinstance(project_name, str) and project_name and project_name.lower() != name.lower():
                self.warn(KEEL, "keel-name",
                          f"project.name is {project_name}, but the repository is {name} — keel-api files "
                          f"versions under the repository's name",
                          line=line_of(project, "name"))

        remote = release.get("remote")
        if isinstance(remote, str) and remote:
            if remote not in self.remotes:
                self.error(KEEL, "keel-remote",
                           f"release.remote is {remote}, which is not a remote of this repository",
                           line=line_of(release, "remote"))
            elif remote != "origin":
                self.warn(KEEL, "keel-remote",
                          f"release.remote is {remote} — keel create-version pushes to origin unless it is "
                          f"given --remote {remote}",
                          line=line_of(release, "remote"))

        prefix = release.get("tag_prefix")
        if isinstance(prefix, str) and prefix and prefix != "v":
            self.error(KEEL, "keel-tag-prefix",
                       f"release.tag_prefix is {prefix!r} — keel tags v<version>, and the Release workflow "
                       "starts on v*.*.* tags",
                       line=line_of(release, "tag_prefix"))

        files = release.get("version_files") if isinstance(release.get("version_files"), list) else []
        files = [item for item in files if isinstance(item, str)]
        for entry in files:
            if not (self.root / entry).is_file():
                self.error(KEEL, "keel-version-file",
                           f"{entry} is listed in release.version_files, but it is not in the repository",
                           line=line_of(release, "version_files"))
        if files and (self.root / "go.mod").is_file():
            self.warn(KEEL, "keel-version-file",
                      f"a Go module's version is its tag, yet .keel lists {', '.join(files)} as version files — "
                      "keel-release bumps them at every release: keep one only if it carries this "
                      "repository's release version",
                      line=line_of(release, "version_files"))

        branch = release.get("branch")
        if isinstance(branch, str) and branch:
            origin = remote if isinstance(remote, str) and remote else "origin"
            code, default = git(self.root, "symbolic-ref", "-q", "--short", f"refs/remotes/{origin}/HEAD")
            if code == 0 and default.startswith(f"{origin}/"):
                default = default[len(origin) + 1 :]
                if branch != default:
                    self.warn(KEEL, "keel-branch",
                              f"release.branch is {branch}, but {origin}'s default branch is {default} — "
                              "keel init records whichever branch it ran on",
                              line=line_of(release, "branch"))
            elif self.head:
                wanted = {f"refs/heads/{branch}", f"refs/remotes/{origin}/{branch}"}
                _, refs = git(self.root, "for-each-ref", "--format=%(refname)", *sorted(wanted))
                if not wanted & set(refs.split()):
                    self.warn(KEEL, "keel-branch",
                              f"release.branch is {branch}, which is not a branch here or on {origin}",
                              line=line_of(release, "branch"))

        if not tracked:
            self.warn(KEEL, "untracked",
                      ".keel is not tracked by git — add and commit it, so everyone on the project shares these settings")

    # ------------------------------------------------- release workflow --

    def check_release_workflow(self) -> None:
        rel = next((name for name in RELEASE_WORKFLOWS if (self.root / name).is_file()), None)
        self.facts["release_workflow"] = None
        if rel is None:
            self.error(RELEASE_WORKFLOWS[0], "release-missing",
                       f"no Release workflow — copy {TEMPLATE} there; outside Go, adapt only its verify job")
            return
        raw = (self.root / rel).read_bytes()
        try:
            workflow = load_yaml(raw.decode("utf-8"))
        except UnicodeDecodeError:
            self.error(rel, "release-unparseable", f"{rel} is not UTF-8")
            return
        except YamlError as why:
            self.error(rel, "release-unparseable", f"{rel} cannot be read: {why.reason}", line=why.line)
            return
        if not isinstance(workflow, dict):
            self.error(rel, "release-unparseable", f"{rel} is not a workflow")
            return

        template = load_yaml(TEMPLATE.read_text(encoding="utf-8"))
        canonical_report = template["jobs"]["report"]
        jobs = workflow.get("jobs") if isinstance(workflow.get("jobs"), dict) else Map()
        report = jobs.get("report")
        facts = {
            "path": rel,
            "tracked": self.index_mode(rel) is not None,
            "go_template": raw == TEMPLATE.read_bytes(),
            "report_job_canonical": report == canonical_report,
        }
        self.facts["release_workflow"] = facts

        on = triggers(workflow.get("on"))
        on_line = workflow.lines.get("on")
        self.check_triggers(rel, on, on_line)
        self.check_concurrency(rel, workflow, on)
        self.check_verify(rel, jobs)
        self.check_report(rel, workflow, jobs, canonical_report)

        if not facts["tracked"]:
            self.warn(rel, "untracked", f"{rel} is not tracked by git — a tag only runs the workflow its commit holds")

    def check_triggers(self, rel: str, on: dict, line: int | None) -> None:
        push = on.get("push")
        ref_filters = ("tags", "tags-ignore", "branches", "branches-ignore")
        if "push" not in on:
            self.error(rel, "release-trigger",
                       f"{rel} does not start on a pushed tag — add on.push.tags: [\"{TAG_PATTERN}\"]", line=line)
        elif not isinstance(push, dict) or not any(key in push for key in ref_filters):
            self.error(rel, "release-trigger",
                       f"{rel} runs on every push, branches included — the report job would fail on each "
                       f"branch push, with no tag to report: limit push to tags: [\"{TAG_PATTERN}\"]", line=line)
        else:
            tags = strings(push.get("tags"))
            if "branches" in push or "branches-ignore" in push:
                self.error(rel, "release-trigger",
                           f"{rel} {'also runs' if tags else 'runs'} on branch pushes, which carry no tag to "
                           f"report — keep branches in the CI workflow and push.tags: [\"{TAG_PATTERN}\"] here",
                           line=line)
            elif TAG_PATTERN in tags:
                pass
            elif any(glob_match(pattern, SAMPLE_TAG) for pattern in tags if not pattern.startswith("!")):
                self.warn(rel, "release-trigger",
                          f"{rel} starts on tags {', '.join(tags)} rather than {TAG_PATTERN} — keel tags "
                          f"v<major>.<minor>.<patch>, which {TAG_PATTERN} matches and nothing else does",
                          line=line)
            else:
                self.error(rel, "release-trigger",
                           f"{rel} starts on tags {', '.join(tags) or '(none)'}, none of which matches the "
                           f"{SAMPLE_TAG} kind of tag keel creates — use {TAG_PATTERN}", line=line)
        for event in TAGLESS_EVENTS:
            if event in on:
                self.error(rel, "release-trigger",
                           f"{rel} also runs on {event}, which carries no tag to report — that belongs in "
                           "the CI workflow", line=line)

        if "workflow_dispatch" not in on:
            self.error(rel, "release-dispatch",
                       f"{rel} has no workflow_dispatch — a tag made before the workflow existed, or one whose "
                       "run can no longer be re-run, could never be reported", line=line)
            return
        dispatch = on.get("workflow_dispatch")
        inputs = dispatch.get("inputs") if isinstance(dispatch, dict) else None
        if not isinstance(inputs, dict) or "tag" not in inputs:
            self.error(rel, "release-dispatch",
                       "workflow_dispatch has no tag input — a manual run would report the branch it started "
                       "from, not a tag", line=line)
            return
        self.dispatch_tag = True
        tag_input = inputs.get("tag")
        required = tag_input.get("required") if isinstance(tag_input, dict) else None
        if str(required).strip().lower() != "true":
            self.warn(rel, "release-dispatch",
                      "the tag input of workflow_dispatch is optional — a run without it has no tag to report: "
                      "required: true", line=inputs.lines.get("tag"))

    def check_concurrency(self, rel: str, workflow: Map, on: dict) -> None:
        concurrency = workflow.get("concurrency")
        line = workflow.lines.get("concurrency")
        if concurrency is None:
            self.error(rel, "release-concurrency",
                       f"{rel} has no concurrency — two runs of one tag would race, and whichever reported "
                       "last would decide the version's status: group on the tag, cancel-in-progress: false",
                       line=line)
            return
        if isinstance(concurrency, dict):
            group, cancel = concurrency.get("group"), concurrency.get("cancel-in-progress")
            cancel_line = concurrency.lines.get("cancel-in-progress", line)
        else:
            group, cancel, cancel_line = concurrency, None, line
        group_text = squash(group)
        if "inputs.tag" not in group_text and "github.ref" not in group_text:
            self.error(rel, "release-concurrency",
                       f"the concurrency group {str(group)!r} is not per tag — runs of different tags would "
                       "queue behind one another, and GitHub cancels a queued run when the next one arrives: "
                       "group: release-${{ inputs.tag || github.ref }}", line=line)
        elif "workflow_dispatch" in on and "inputs.tag" not in group_text:
            self.warn(rel, "release-concurrency",
                      "the concurrency group ignores inputs.tag — a manual run shares the group of the branch "
                      "it started from, not its tag's", line=line)
        value = str(cancel).strip().lower() if cancel is not None else "false"
        if value == "true":
            self.error(rel, "release-concurrency",
                       "cancel-in-progress is true — a second run of a tag would cancel the first, and a "
                       "cancelled run reports nothing: make it false", line=cancel_line)
        elif value != "false":
            self.warn(rel, "release-concurrency",
                      f"cancel-in-progress is {cancel!r} — make it false, so no run of a tag is ever cancelled",
                      line=cancel_line)

    def check_verify(self, rel: str, jobs: dict) -> None:
        verify = jobs.get("verify")
        line = line_of(jobs, "verify")
        if not isinstance(verify, dict):
            self.error(rel, "release-verify",
                       f"{rel} has no verify job — the report says published or failed from its result",
                       line=line_of(jobs, "report"))
            return
        if not verify.get("steps") and not verify.get("uses"):
            self.error(rel, "release-verify",
                       "the verify job has no steps — it would pass without checking anything", line=line)
            return
        steps = [step for step in verify.get("steps") or [] if isinstance(step, dict)]
        checkout = next((step for step in steps if str(step.get("uses", "")).startswith("actions/checkout")), None)
        if checkout is not None and self.dispatch_tag:
            ref = checkout.get("with", {}).get("ref") if isinstance(checkout.get("with"), dict) else None
            if "inputs.tag" not in squash(ref):
                self.warn(rel, "release-verify",
                          "verify checks out the default ref — a manual run would check the branch it started "
                          "from instead of the tag: ref: ${{ inputs.tag || github.ref }}", line=line)

    def check_report(self, rel: str, workflow: Map, jobs: dict, canonical: dict) -> None:
        report = jobs.get("report")
        line = line_of(jobs, "report")
        if not isinstance(report, dict):
            self.error(rel, "report-job",
                       f"{rel} has no report job — without it the CI never confirms a version: copy the report "
                       f"job from {TEMPLATE}, unchanged")
            return
        before = len(self.findings)

        if "verify" not in strings(report.get("needs")):
            self.error(rel, "report-needs",
                       "the report job does not need verify — it would report before the checks finish, and "
                       "KEEL_STATUS reads needs.verify.result", line=report.lines.get("needs", line))
        condition = report.get("if")
        text = squash(condition)
        if_line = report.lines.get("if", line)
        if not condition:
            self.error(rel, "report-if",
                       "the report job has no if — it runs only when verify passed, so a tag whose checks "
                       "failed is never reported: if: ${{ !cancelled() }}", line=line)
        elif "!cancelled()" in text:
            pass
        elif "always()" in text:
            self.error(rel, "report-if",
                       "the report job runs on always() — a cancelled run concluded nothing, and must not be "
                       "reported as failed: if: ${{ !cancelled() }}", line=if_line)
        else:
            self.error(rel, "report-if",
                       f"the report job runs on {condition!r} — it must run whether verify passed or failed, "
                       "and only then: if: ${{ !cancelled() }}", line=if_line)

        steps = [step for step in report.get("steps") or [] if isinstance(step, dict)]
        run_at = next((index for index, step in enumerate(steps) if SCRIPT in str(step.get("run", ""))), None)
        if run_at is None:
            self.error(rel, "report-run", f"no step of the report job runs {SCRIPT}", line=line)
        checkout_at = next((index for index, step in enumerate(steps)
                            if str(step.get("uses", "")).startswith("actions/checkout")), None)
        if checkout_at is None or (run_at is not None and checkout_at > run_at):
            self.error(rel, "report-checkout",
                       "the report job does not check the repository out before the script runs — neither the "
                       "script nor the tag is on the runner until it does", line=line)
        elif self.dispatch_tag:
            options = steps[checkout_at].get("with")
            ref = options.get("ref") if isinstance(options, dict) else None
            if "inputs.tag" not in squash(ref):
                self.error(rel, "report-checkout",
                           "the report job's checkout ignores inputs.tag — a manual run would report the commit "
                           "of the branch it started from, not the tag's: ref: ${{ inputs.tag || github.ref }}",
                           line=line)

        if run_at is not None:
            self.check_report_env(rel, workflow, report, steps[run_at], line)

        # Only once it works: until then, the errors above say more than a diff.
        if len(self.findings) == before and report != canonical:
            where = differences(report, canonical)
            self.warn(rel, "report-drift",
                      f"the report job differs from the canonical one at {', '.join(where[:4])}"
                      f"{' …' if len(where) > 4 else ''} — it is meant to be the same in every repository: "
                      f"copy it from {TEMPLATE}", line=line, details={"differences": where})

    def check_report_env(self, rel: str, workflow: Map, report: dict, step: dict, line: int | None) -> None:
        env: dict = {}
        for scope in (workflow.get("env"), report.get("env"), step.get("env")):
            if isinstance(scope, dict):
                env.update(scope)
        line = line_of(step, "env") or line
        missing = [name for name in REPORT_ENV if name not in env]
        if missing:
            self.error(rel, "report-env",
                       f"the report step does not set {', '.join(missing)} — report-version.sh reads "
                       f"{'it' if len(missing) == 1 else 'them'}", line=line)
        token = env.get("KEEL_CI_TOKEN")
        if token is not None:
            if "klc_" in str(token):
                # Never repeat the value: this message ends up in logs.
                self.error(rel, "report-secret",
                           "KEEL_CI_TOKEN is written into the workflow — anyone who can read the repository has "
                           "that credential: revoke it in keel's admin, and read a new one from "
                           "secrets.KEEL_CI_TOKEN", line=line)
            elif "secrets." not in squash(token):
                self.error(rel, "report-secret",
                           "KEEL_CI_TOKEN does not come from a repository secret — ${{ secrets.KEEL_CI_TOKEN }}",
                           line=line)
        status = env.get("KEEL_STATUS")
        if status is not None and "needs.verify.result" not in squash(status):
            self.error(rel, "report-env",
                       "KEEL_STATUS does not follow needs.verify.result — the report must say failed when "
                       "verify failed", line=line)
        tag = env.get("KEEL_TAG")
        if tag is not None and self.dispatch_tag and "inputs.tag" not in squash(tag):
            self.error(rel, "report-env",
                       "KEEL_TAG ignores inputs.tag — a manual run would report the branch name as the version",
                       line=line)

    # ----------------------------------------------------- report script --

    def check_script(self) -> None:
        path = self.root / SCRIPT
        self.facts["report_script"] = None
        if not path.is_file():
            self.error(SCRIPT, "script-missing",
                       f"no {SCRIPT} — copy keel-api's scripts/ci/report-version.sh there verbatim "
                       f"(or {BUNDLED_SCRIPT}), mode 755")
            return
        data = path.read_bytes()
        mode = self.index_mode(SCRIPT)
        executable = os.name == "nt" or bool(path.stat().st_mode & 0o111)
        facts = {
            "path": SCRIPT,
            "sha256": sha256(data),
            "canonical_sha256": sha256(self.canonical) if self.canonical is not None else None,
            "canonical": self.canonical_label,
            "identical": data == self.canonical if self.canonical is not None else None,
            "executable": executable,
            "index_mode": mode,
        }
        self.facts["report_script"] = facts

        if self.canonical is not None and data != self.canonical:
            expected = sha256(self.canonical)
            if data.replace(b"\r\n", b"\n") == self.canonical:
                why = ("it has Windows line endings (CRLF), which bash cannot run — copy it again, and keep git "
                       "from converting it (`*.sh text eol=lf` in .gitattributes)")
            elif b"".join(data.split()) == b"".join(self.canonical.split()):
                why = "only whitespace differs"
            else:
                ours = data.decode("utf-8", "replace").splitlines()
                theirs = self.canonical.decode("utf-8", "replace").splitlines()
                matcher = difflib.SequenceMatcher(a=theirs, b=ours, autojunk=False)
                changed = [op for op in matcher.get_opcodes() if op[0] != "equal"]
                lines = sum(max(i2 - i1, j2 - j1) for _, i1, i2, j1, j2 in changed)
                first = changed[0][3] + 1 if changed else 1
                why = f"{lines} {'line differs' if lines == 1 else 'lines differ'}, the first at line {first}"
            diff = list(difflib.unified_diff(
                self.canonical.decode("utf-8", "replace").splitlines(),
                data.decode("utf-8", "replace").splitlines(),
                "canonical", SCRIPT, lineterm="", n=1))
            self.error(SCRIPT, "script-drift",
                       f"{SCRIPT} is not keel-api's canonical script: {why}. sha256 {facts['sha256'][:12]}… here, "
                       f"{expected[:12]}… in {self.canonical_label} — replace it with the canonical copy; a change "
                       "it needs belongs in keel-api"
                       + ("" if self.canonical_given else
                          " (if keel-api's script is newer than this skill's copy, audit again with --canonical)"),
                       details={"sha256": facts["sha256"], "canonical_sha256": expected,
                                "canonical": self.canonical_label, "diff": diff[:60]})

        if not executable:
            self.error(SCRIPT, "script-not-executable",
                       f"{SCRIPT} is not executable (mode {oct(path.stat().st_mode & 0o777)[2:]}) — keel-api "
                       f"keeps it at 755: chmod 755 {SCRIPT}")
        if mode == "100644":
            self.error(SCRIPT, "script-not-executable",
                       f"git records {SCRIPT} as 100644, so every checkout gets it without its executable bit — "
                       f"git update-index --chmod=+x {SCRIPT}")
        if mode is None:
            self.warn(SCRIPT, "untracked", f"{SCRIPT} is not tracked by git — the Release workflow runs the copy the "
                                           "tagged commit holds")

    # --------------------------------------------------------------- docs --

    def check_docs(self) -> None:
        self.facts["docs"] = None
        if not (self.root / DOCS).is_dir():
            return
        page = self.root / RELEASES
        facts = {"releases": RELEASES if page.is_file() else None, "listed": None}
        self.facts["docs"] = facts
        if not page.is_file():
            self.error(RELEASES, "releases-missing",
                       f"docs/ has no releases.md — render {PAGE_TEMPLATE} with this repository's name")
            return

        text = page.read_text(encoding="utf-8", errors="replace")
        placeholders = sorted(set(re.findall(r"\{\{\s*[A-Za-z_]+\s*\}\}", text)))
        if placeholders:
            self.error(RELEASES, "releases-placeholder",
                       f"{RELEASES} still has template placeholders: {', '.join(placeholders)}")
        if self.slug:
            others = sorted({name for name in re.findall(r"--repo[ =]([\w.-]+/[\w.-]+)", text)
                             if name.lower() != self.slug.lower()})
            if others:
                self.error(RELEASES, "releases-other-repository",
                           f"{RELEASES} sets the secret of {', '.join(others)}, but this is {self.slug} — "
                           "was it copied from another repository?")

        index = self.root / INDEX
        library = front_matter(text).get("library")
        if index.is_file():
            index_text = index.read_text(encoding="utf-8", errors="replace")
            expected = front_matter(index_text).get("library")
            if library and expected and library != expected and "{{" not in library:
                self.error(RELEASES, "releases-library",
                           f"{RELEASES} says library: {library}, but docs/README.md says {expected} — "
                           "one name on every page")
            listing = index_listing(index_text)
            facts["listed"] = listing == "list"
            if listing == "none":
                self.error(INDEX, "releases-unlisted",
                           "docs/README.md never links releases.md — add it to the list or table the other "
                           "pages are in, so keel's sidebar reaches it")
            elif listing == "prose":
                self.warn(INDEX, "releases-prose-link",
                          "docs/README.md links releases.md only from a paragraph — keel's sidebar is built "
                          "from the index's lists and tables")
        else:
            facts["listed"] = False
            self.error(INDEX, "releases-unlisted",
                       "docs/README.md is missing, so nothing lists releases.md — keel docs needs the index too")

        self.untracked(RELEASES, "a version only carries the docs its commit holds")

    # ----------------------------------------------------------- .gitignore --

    def check_dist(self) -> None:
        code, _ = git(self.root, "check-ignore", "-q", "--no-index", "dist/docs/index.html")
        self.facts["dist_ignored"] = code == 0 if code in (0, 1) else None
        if code == 1:
            self.error(".gitignore", "dist-not-ignored",
                       "dist/ is not git-ignored — keel docs writes the site to dist/docs/: add a dist/ line "
                       "to .gitignore")

    # ------------------------------------------------------------------ ci --

    def check_ci(self) -> None:
        folder = self.root / ".github" / "workflows"
        found = []
        for path in sorted(folder.glob("*.y*ml")) if folder.is_dir() else []:
            rel = path.relative_to(self.root).as_posix()
            if rel in RELEASE_WORKFLOWS or path.suffix not in (".yml", ".yaml"):
                continue
            try:
                workflow = load_yaml(path.read_text(encoding="utf-8"))
                on = triggers(workflow.get("on")) if isinstance(workflow, dict) else {}
            except (YamlError, UnicodeDecodeError):
                found.append(rel)  # cannot tell what it runs on: give it the benefit of the doubt
                continue
            push = on.get("push")
            tags_only = isinstance(push, dict) and bool(push.get("tags") or push.get("tags-ignore")) \
                and not (push.get("branches") or push.get("branches-ignore"))
            if "pull_request" in on or ("push" in on and not tags_only):
                found.append(rel)
        self.facts["ci_workflows"] = found
        if not found:
            self.warn(".github/workflows", "no-ci",
                      "no CI workflow runs the checks on pushes and pull requests — the Release workflow only "
                      "checks a commit once it is tagged")


# ------------------------------------------------------------- output --

def render(result: dict) -> str:
    facts = result["facts"]
    lines = [f"repository     {shown(Path(facts['root']))}"]
    origin = facts.get("origin") or {}
    lines.append(f"origin         {origin.get('repository') or origin.get('url') or 'none'}")
    kinds = [f"go module {facts['go_module']}" if kind == "go" and facts.get("go_module") else kind
             for kind in facts.get("kind") or []]
    lines.append(f"kind           {', '.join(kinds) or 'unknown: no go.mod, Cargo.toml, package.json, pyproject.toml or composer.json'}")

    keel = facts.get("keel")
    if keel is None:
        lines.append("keel file      none")
    else:
        settings = keel.get("settings") or {}
        release = settings.get("release") if isinstance(settings.get("release"), dict) else {}
        files = release.get("version_files") if isinstance(release.get("version_files"), list) else []
        lines.append(f"keel file      .keel · {'tracked' if keel['tracked'] else 'untracked'}"
                     f" · {release.get('remote', '?')}/{release.get('branch', '?')}"
                     f" · version files: {', '.join(files) if files else 'none — the tag is the version'}")

    workflow = facts.get("release_workflow")
    if workflow is None:
        lines.append("release        none")
    else:
        how = ("the Go template, byte for byte" if workflow["go_template"]
               else "report job canonical" if workflow["report_job_canonical"]
               else "report job differs from the canonical one")
        lines.append(f"release        {workflow['path']} · {how}")

    script = facts.get("report_script")
    if script is None:
        lines.append("report script  none")
    else:
        state = ("canonical" if script["identical"] else "differs from the canonical"
                 if script["identical"] is False else "not compared")
        lines.append(f"report script  {script['path']} · {state} · "
                     f"{script['index_mode'] or 'untracked'}")
    lines.append(f"canonical      {facts.get('canonical')} · {(facts.get('canonical_sha256') or 'unknown')[:12]}")

    docs = facts.get("docs")
    if docs is None:
        lines.append("releases page  no docs/")
    else:
        lines.append(f"releases page  {docs['releases'] or 'none'}"
                     + (" · listed in docs/README.md" if docs.get("listed") else ""))
    ignored = facts.get("dist_ignored")
    lines.append(f"dist/          {'ignored' if ignored else 'not ignored' if ignored is False else 'unknown'}")
    lines.append(f"ci             {', '.join(facts.get('ci_workflows') or []) or 'none'}")

    if result["findings"]:
        lines.append("")
    current = None
    for finding in result["findings"]:
        if finding["path"] != current:
            current = finding["path"]
            lines.append(current)
        label = "ERROR" if finding["level"] == "error" else "WARN "
        where = f"{finding['line']:>4}" if finding["line"] else "    "
        lines.append(f"  {label} {where}  {finding['message']}  [{finding['code']}]")

    lines.append("")
    errors, warnings = result["errors"], result["warnings"]
    if errors or warnings:
        mark = "✖" if errors or result["strict"] else "⚠"
        lines.append(f"{mark} {errors} error{'s' if errors != 1 else ''}, "
                     f"{warnings} warning{'s' if warnings != 1 else ''}")
    else:
        lines.append("✔ set up for keel releases")
    return "\n".join(lines)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("repo", nargs="?", type=Path, default=Path.cwd(),
                        help="any folder in the repository [default: here]")
    parser.add_argument("--canonical", type=Path,
                        help="keel-api's scripts/ci/report-version.sh, freshly fetched, to compare against "
                             "instead of the copy bundled with this skill")
    parser.add_argument("--strict", action="store_true", help="fail on warnings too")
    parser.add_argument("--json", action="store_true", help="print one JSON object")
    args = parser.parse_args()

    def refuse(error: str, message: str) -> int:
        print(json.dumps({"error": error, "message": message}) if args.json else f"✖ {message}")
        return 2

    code, top = git(args.repo, "rev-parse", "--show-toplevel") if args.repo.is_dir() else (1, "")
    if code != 0 or not top:
        return refuse("no_repository", f"{args.repo} is not inside a git repository")

    bundled = BUNDLED_SCRIPT.read_bytes() if BUNDLED_SCRIPT.is_file() else b""
    recorded = BUNDLED_SUM.read_text(encoding="utf-8").split()[0] if BUNDLED_SUM.is_file() else None
    findings: list[Finding] = []
    if args.canonical is not None:
        try:
            canonical: bytes | None = args.canonical.read_bytes()
        except OSError as why:
            return refuse("no_canonical", f"cannot read {args.canonical}: {why.strerror or why}")
        label = str(args.canonical)
        if canonical != bundled:
            findings.append(Finding(
                "warn", str(BUNDLED_SCRIPT), None, "bundled-stale",
                f"the canonical script ({sha256(canonical)[:12]}…) is not the copy bundled with keel-setup "
                f"({sha256(bundled)[:12]}…) — keel-api has moved on: refresh the skill's copy "
                "(references/canonical-script.md)"))
    elif sha256(bundled) == recorded:
        canonical, label = bundled, "the copy bundled with keel-setup"
    else:
        canonical, label = None, "the copy bundled with keel-setup"
        findings.append(Finding(
            "error", str(BUNDLED_SCRIPT), None, "bundled-corrupt",
            "the bundled report-version.sh is missing or does not match its recorded SHA-256, so the "
            "repository's copy cannot be checked against it — reinstall the skill, or pass --canonical "
            "with keel-api's script"))

    audit = Audit(Path(top), canonical, label, canonical_given=args.canonical is not None)
    audit.facts["canonical"] = label
    audit.facts["canonical_sha256"] = sha256(canonical) if canonical is not None else None
    audit.run()
    audit.findings.extend(findings)

    errors = sum(1 for finding in audit.findings if finding.level == "error")
    warnings = len(audit.findings) - errors
    result = {
        "facts": audit.facts,
        "errors": errors,
        "warnings": warnings,
        "strict": args.strict,
        "findings": [asdict(finding) for finding in audit.findings],
    }
    print(json.dumps(result) if args.json else render(result))
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
