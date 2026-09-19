#!/usr/bin/env python3
"""Audit a docs/ folder against the Foundathyon documentation conventions.

`keel docs --check` decides whether the site builds. This checks what keel
does not: that every page carries the front matter the portal relies on, that
the H1 keel drops says the same as the title it shows, that code fences name
their language, that headings do not skip levels, and the rest of the house
rules in references/foundathyon-standard.md. It also covers the two keel
warnings (unlisted pages, raw HTML), so it is still useful where keel is not
installed.

Standard library only, so it runs wherever python3 does.

    python3 audit_docs.py [DOCS_DIR] [--library NAME] [--strict] [--json]

Exit status: 0 clean (warnings allowed), 1 errors (or warnings with --strict),
2 when there is nothing to audit.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

REQUIRED_KEYS = ("title", "description", "library")
DESCRIPTION_LIMIT = 160

KEBAB = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
ATX = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
INLINE_CODE = re.compile(r"(`+).+?\1")
AUTOLINK = re.compile(r"<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s]+)>")
HTML = re.compile(r"<!--|</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?/?>")
PLACEHOLDER = re.compile(r"\b(?:TODO|TBD|FIXME)\b|lorem ipsum", re.IGNORECASE)
ROOTED_LINK = re.compile(r"\]\((/[^)\s]*)")
LINK_TARGET = re.compile(r"\]\(([^)\s]+)")


@dataclass
class Finding:
    level: str  # "error" or "warn"
    path: str
    line: int
    code: str
    message: str


@dataclass
class Page:
    rel: str
    front: dict | None
    body: str
    body_line: int


def unquote(value: str) -> str | None:
    """A front matter value the way keel reads it."""
    if not value or value[0] in "|>":
        return None
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    value = value.replace('\\"', '"').replace("\\\\", "\\").strip()
    return value or None


def split_front_matter(text: str) -> tuple[dict | None, str, int]:
    """(front matter or None, body, line the body starts on). Raises on an
    unclosed block, as keel does."""
    text = text.lstrip("﻿")
    if not (text.startswith("---\n") or text.startswith("---\r\n")):
        return None, text, 1
    lines = text.splitlines(keepends=True)
    front: dict = {}
    for index, line in enumerate(lines[1:], start=1):
        stripped = line.rstrip("\r\n")
        if stripped in ("---", "..."):
            return front, "".join(lines[index + 1 :]), index + 2
        if not stripped.strip() or stripped.lstrip().startswith("#"):
            continue
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        front[key.strip()] = unquote(value.strip())
    raise ValueError("the front matter is opened with --- but never closed")


def plain(markdown: str) -> str:
    """Heading or title text without its inline markup."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", markdown)
    text = text.replace("`", "")
    text = re.sub(r"(\*\*|\*)(.+?)\1", r"\2", text)
    return " ".join(text.split())


def scan(page: Page, add) -> list[str]:
    """Check one page's body. Returns the link targets it contains."""
    headings: list[tuple[int, int, str]] = []
    targets: list[str] = []
    fence: tuple[str, int] | None = None

    for offset, raw in enumerate(page.body.splitlines()):
        number = page.body_line + offset
        opener = FENCE.match(raw)
        if fence:
            if opener and opener.group(1)[0] == fence[0] and len(opener.group(1)) >= fence[1] \
                    and not opener.group(2).strip():
                fence = None
            continue
        if opener and not (opener.group(1)[0] == "`" and "`" in opener.group(2)):
            fence = (opener.group(1)[0], len(opener.group(1)))
            if not opener.group(2).strip():
                add("warn", page.rel, number, "fence-language",
                    "code fence without a language — name it: go, sh, json, text…")
            continue
        if raw.startswith(("    ", "\t")):
            continue  # indented code, or a continuation not worth guessing at

        heading = ATX.match(raw)
        if heading:
            headings.append((number, len(heading.group(1)), plain(heading.group(2) or "")))

        text = AUTOLINK.sub("", INLINE_CODE.sub("", raw))
        html = HTML.search(text)
        if html and not html.group(0).startswith("</"):
            add("warn", page.rel, number, "raw-html",
                f"raw HTML {html.group(0)[:40]!r} shows as text in keel — use markdown, "
                "or backticks for a <placeholder>")
        if PLACEHOLDER.search(text):
            add("warn", page.rel, number, "placeholder", "placeholder text left in the page")
        for rooted in ROOTED_LINK.findall(text):
            add("warn", page.rel, number, "rooted-link",
                f"{rooted} is a rooted path: keel does not check it and it breaks "
                "under a prefix — make it relative")
        targets.extend(LINK_TARGET.findall(text))

    check_headings(page, headings, add)
    return targets


def check_headings(page: Page, headings: list[tuple[int, int, str]], add) -> None:
    title = (page.front or {}).get("title")
    h1s = [(line, text) for line, level, text in headings if level == 1]

    if not h1s:
        add("warn", page.rel, page.body_line, "no-h1",
            f"no H1 — start the page with `# {title or '<title>'}`")
    else:
        line, text = h1s[0]
        if headings[0][1] != 1:
            add("warn", page.rel, headings[0][0], "h1-first",
                "a heading comes before the H1 — the H1 opens the page")
        if title and text != plain(title):
            add("error", page.rel, line, "h1-title",
                f"H1 {text!r} differs from the title {title!r} — keel shows the title and drops this H1")
        for extra_line, _ in h1s[1:]:
            add("warn", page.rel, extra_line, "second-h1",
                "a second H1 renders inside the page — use ## for sections")

    previous = None
    for line, level, _ in headings:
        if previous is not None and level > previous + 1:
            add("warn", page.rel, line, "heading-jump",
                f"jumps from H{previous} to H{level} — do not skip levels")
        previous = level


def check_front_matter(page: Page, add) -> None:
    if page.front is None:
        add("error", page.rel, 1, "front-matter",
            "no front matter — every page needs title, description and library")
        return
    for key in REQUIRED_KEYS:
        if not page.front.get(key):
            add("error", page.rel, 1, f"missing-{key}", f"front matter has no {key}")
    description = page.front.get("description") or ""
    if len(description) > DESCRIPTION_LIMIT:
        add("warn", page.rel, 1, "long-description",
            f"description is {len(description)} characters — keep it one sentence under {DESCRIPTION_LIMIT}")


def resolve(base: str, target: str) -> str | None:
    """A link target relative to docs/, the way keel resolves it, or None
    when it is not a page reference at all."""
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target or "://" in target or target.startswith(("/", "mailto:", "tel:")):
        return None
    parts = [part for part in base.split("/") if part]
    for segment in target.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(segment)
    path = "/".join(parts)
    if not path:
        return "README.md"
    return path if path.endswith(".md") else path.rstrip("/") + ".md"


def gitignored(docs: Path) -> bool | None:
    """Whether the site keel writes would be ignored; None outside git."""
    try:
        root = subprocess.run(["git", "-C", str(docs), "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, check=False)
        if root.returncode != 0:
            return None
        probe = subprocess.run(["git", "-C", root.stdout.strip(), "check-ignore", "-q",
                                "dist/docs/index.html"], capture_output=True, check=False)
    except OSError:
        return None
    return probe.returncode == 0


def default_docs() -> Path:
    try:
        root = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, check=False)
        if root.returncode == 0:
            return Path(root.stdout.strip()) / "docs"
    except OSError:
        pass
    return Path("docs")


def audit(docs: Path, library: str | None) -> tuple[list[Finding], int]:
    findings: list[Finding] = []

    def add(level: str, path: str, line: int, code: str, message: str) -> None:
        findings.append(Finding(level, path, line, code, message))

    pages: list[Page] = []
    for path in sorted(docs.rglob("*.md")):
        rel_path = path.relative_to(docs)
        if any(part.startswith(".") for part in rel_path.parts):
            continue
        rel = rel_path.as_posix()
        if path.name != "README.md" and not KEBAB.match(path.name):
            add("warn", rel, 1, "file-name", "file name is not kebab-case")
        try:
            front, body, body_line = split_front_matter(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            add("error", rel, 1, "encoding", "not valid UTF-8 — keel cannot read it")
            continue
        except ValueError as why:
            add("error", rel, 1, "front-matter", str(why))
            continue
        pages.append(Page(rel, front, body, body_line))

    if not any(page.rel == "README.md" for page in pages):
        add("error", "README.md", 1, "no-index",
            "docs/README.md is missing — it is the front page and the sidebar")

    listed: set[str] = set()
    for page in pages:
        check_front_matter(page, add)
        targets = scan(page, add)
        if page.rel == "README.md":
            for target in targets:
                resolved = resolve("", target)
                if resolved:
                    listed.add(resolved)
                    listed.add(resolved[: -len(".md")] + "/README.md")

    # One library name across the whole site, the one asked for if any.
    names = [page.front.get("library") for page in pages if page.front and page.front.get("library")]
    expected = library or (max(set(names), key=names.count) if names else None)
    for page in pages:
        name = (page.front or {}).get("library")
        if expected and name and name != expected:
            add("error", page.rel, 1, "library",
                f"library is {name!r}, but the site is {expected!r} — use one name on every page")

    if any(page.rel == "README.md" for page in pages):
        for page in pages:
            if page.rel != "README.md" and page.rel not in listed:
                add("warn", page.rel, 1, "unlisted",
                    "the index never links this page, so the sidebar cannot reach it")

    if gitignored(docs) is False:
        add("warn", ".gitignore", 1, "dist-ignored",
            "dist/ is not git-ignored — keel docs writes the site to dist/docs/")

    findings.sort(key=lambda f: (f.path, f.line, f.level != "error"))
    return findings, len(pages)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("docs", nargs="?", type=Path, help="docs folder [default: <git root>/docs]")
    parser.add_argument("--library", help="the library name every page must carry")
    parser.add_argument("--strict", action="store_true", help="fail on warnings too")
    parser.add_argument("--json", action="store_true", help="print one JSON object")
    args = parser.parse_args()

    docs = args.docs or default_docs()
    if not docs.is_dir():
        message = f"there is no {docs} here"
        print(json.dumps({"error": "no_docs", "message": message}) if args.json else f"✖ {message}")
        return 2

    findings, pages = audit(docs, args.library)
    errors = sum(1 for f in findings if f.level == "error")
    warnings = len(findings) - errors

    if args.json:
        print(json.dumps({
            "docs": str(docs),
            "pages": pages,
            "errors": errors,
            "warnings": warnings,
            "findings": [asdict(f) for f in findings],
        }))
    else:
        current = None
        for finding in findings:
            if finding.path != current:
                current = finding.path
                print(finding.path)
            label = "ERROR" if finding.level == "error" else "WARN "
            print(f"  {label} {finding.line:>4}  {finding.message}  [{finding.code}]")
        if findings:
            print()
        if errors or warnings:
            mark = "✖" if errors or args.strict else "⚠"
            print(f"{mark} {errors} errors, {warnings} warnings in {pages} pages")
        else:
            print(f"✔ {pages} pages follow the conventions")

    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
