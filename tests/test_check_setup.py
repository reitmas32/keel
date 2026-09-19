"""Tests for keel-setup's audit, against real throwaway repositories.

Each test starts from a copy of one repository wired exactly the way
fd_http and fd_logging are, breaks one thing, and checks that the audit says
so — by finding code, level and exit status, as an agent reads it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "plugins/keel-setup/skills/keel-setup"
SCRIPT = SKILL / "scripts/check_setup.py"
ASSETS = SKILL / "assets"

# The files fd_http and fd_logging carry since they were wired for keel
# ("ci: report every release to keel-api from a Release workflow"). The
# bundled templates exist to reproduce them, byte for byte.
RELEASE_YML_SHA256 = "dc993cd328667f70e2957b4fb8680cdfe024b4eb8cb1d94f07b7cbc66fcfceb6"
RELEASES_PAGE_SHA256 = {
    "fd_http": "11bbc777da8bee6861d64e0adde8a7845214bb87f2ab3832ecaec630cd0bca9b",
    "fd_logging": "c3b7caaaa3b0632cec1adf2cf19bc337075a1729daf86bd2c727b2cce13e8cdd",
}

WORKFLOW = ".github/workflows/release.yml"
REPORTER = ".github/scripts/report-version.sh"

KEEL = """\
# .keel — project settings for the keel CLI
# Written by keel 0.3.9. Regenerate with: keel init --force

keel: "0.3.9"

project:
  name: widget
  repository: acme/widget

release:
  remote: origin
  branch: main
  tag_prefix: v
  version_files: []
"""

CI = """\
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: go test ./...
"""

INDEX = """\
---
title: widget documentation
description: The widget, documented.
library: widget
---

# widget documentation

## Reference

- [Releases and version reporting](releases.md) — cutting a version.
"""


def render(name: str = "widget", repository: str = "acme/widget", module: str = "github.com/acme/widget") -> str:
    """The releases page, rendered the way SKILL.md's sed command does."""
    text = (ASSETS / "releases.md").read_text(encoding="utf-8")
    return text.replace("{{name}}", name).replace("{{repository}}", repository).replace("{{module}}", module)


def environment(home: Path) -> dict:
    """git with nothing of the machine's own configuration in it."""
    return {
        **os.environ,
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": str(home / ".gitconfig"),
        "GIT_AUTHOR_NAME": "Test",
        "GIT_AUTHOR_EMAIL": "test@example.com",
        "GIT_COMMITTER_NAME": "Test",
        "GIT_COMMITTER_EMAIL": "test@example.com",
    }


class Repo:
    """A repository in `base/widget`, driven through real git."""

    def __init__(self, base: Path, root: Path | None = None) -> None:
        self.base = base
        self.env = environment(base)
        self.root = root or base / "widget"

    @classmethod
    def create(cls, base: Path) -> "Repo":
        repo = cls(base)
        repo.root.mkdir()
        repo.git("init", "-q", "-b", "main")
        repo.git("config", "commit.gpgsign", "false")
        repo.git("remote", "add", "origin", "git@github.com:acme/widget.git")
        return repo

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True, capture_output=True, text=True, env=self.env,
        ).stdout

    def write(self, rel: str, text: str | bytes, mode: int | None = None) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            path.write_bytes(text)
        else:
            path.write_text(text, encoding="utf-8")
        if mode is not None:
            path.chmod(mode)

    def read(self, rel: str) -> str:
        return (self.root / rel).read_text(encoding="utf-8")

    def edit(self, rel: str, old: str, new: str, count: int = 1) -> None:
        text = self.read(rel)
        if old not in text:
            raise AssertionError(f"{old!r} is not in {rel}: the test would test nothing")
        self.write(rel, text.replace(old, new, count))

    def remove(self, rel: str) -> None:
        (self.root / rel).unlink()

    def commit(self, message: str = "chore: wire keel") -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def wire(self) -> None:
        """Everything keel-setup installs, as fd_http and fd_logging have it."""
        self.write("go.mod", "module github.com/acme/widget\n\ngo 1.25\n")
        self.write(".keel", KEEL)
        self.write(".gitignore", "# Build and coverage output.\ncoverage.out\ndist/\n")
        self.write(WORKFLOW, (ASSETS / "release.yml").read_text(encoding="utf-8"))
        self.write(REPORTER, (ASSETS / "report-version.sh").read_bytes(), mode=0o755)
        self.write(".github/workflows/ci.yml", CI)
        self.write("docs/README.md", INDEX)
        self.write("docs/releases.md", render())
        self.commit()


def job(text: str, name: str) -> tuple[str, str, str]:
    """(before, the job, after) — so an edit can reach one job only."""
    start = text.index(f"\n  {name}:\n") + 1
    following = [text.find(f"\n  {other}:\n", start) for other in ("verify", "report") if other != name]
    ends = [index + 1 for index in following if index > start]
    end = min(ends) if ends else len(text)
    return text[:start], text[start:end], text[end:]


class CheckSetup(unittest.TestCase):
    """Starts every test from a copy of one fully wired repository."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.pristine_dir = tempfile.TemporaryDirectory()
        cls.pristine = Repo.create(Path(cls.pristine_dir.name))
        cls.pristine.wire()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.pristine_dir.cleanup()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        shutil.copytree(self.pristine.root, base / "widget", symlinks=True)
        self.repo = Repo(base)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # ------------------------------------------------------------ helpers --

    def run_script(self, *args: str, script: Path = SCRIPT) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(script), *args],
            capture_output=True, text=True, env=self.repo.env,
        )

    def audit(self, *extra: str, script: Path = SCRIPT) -> tuple[int, dict]:
        run = self.run_script(str(self.repo.root), "--json", *extra, script=script)
        self.assertIn(run.returncode, (0, 1), run.stderr)
        report = json.loads(run.stdout)
        self.assertEqual(report["errors"] + report["warnings"], len(report["findings"]))
        return run.returncode, report

    def codes(self, report: dict) -> set[tuple[str, str]]:
        return {(finding["path"], finding["code"]) for finding in report["findings"]}

    def levels(self, report: dict, code: str) -> set[str]:
        return {finding["level"] for finding in report["findings"] if finding["code"] == code}

    def messages(self, report: dict, code: str) -> str:
        return " | ".join(finding["message"] for finding in report["findings"] if finding["code"] == code)

    def expect(self, *pairs: tuple[str, str], code: int = 1, extra: tuple[str, ...] = ()) -> dict:
        """Exactly these findings, and this exit status."""
        status, report = self.audit(*extra)
        self.assertEqual(self.codes(report), set(pairs), json.dumps(report["findings"], indent=1))
        self.assertEqual(status, code)
        return report

    def edit_job(self, name: str, old: str, new: str) -> None:
        before, body, after = job(self.repo.read(WORKFLOW), name)
        if old not in body:
            raise AssertionError(f"{old!r} is not in the {name} job")
        self.repo.write(WORKFLOW, before + body.replace(old, new, 1) + after)

    # --------------------------------------------------------------- whole --

    def test_a_wired_repository_passes_strict(self) -> None:
        status, report = self.audit("--strict")
        self.assertEqual(report["findings"], [])
        self.assertEqual(status, 0)
        facts = report["facts"]
        self.assertEqual(facts["kind"], ["go"])
        self.assertEqual(facts["go_module"], "github.com/acme/widget")
        self.assertEqual(facts["origin"], {"url": "git@github.com:acme/widget.git",
                                           "repository": "acme/widget", "name": "widget"})
        self.assertTrue(facts["keel"]["tracked"])
        self.assertEqual(facts["keel"]["settings"]["release"]["version_files"], [])
        self.assertEqual(facts["release_workflow"], {"path": WORKFLOW, "tracked": True,
                                                     "go_template": True, "report_job_canonical": True})
        self.assertTrue(facts["report_script"]["identical"])
        self.assertEqual(facts["report_script"]["index_mode"], "100755")
        self.assertEqual(facts["docs"], {"releases": "docs/releases.md", "listed": True})
        self.assertTrue(facts["dist_ignored"])
        self.assertEqual(facts["ci_workflows"], [".github/workflows/ci.yml"])
        self.assertEqual(facts["canonical"], "the copy bundled with keel-setup")

    def test_the_text_report_ends_with_the_verdict(self) -> None:
        run = self.run_script(str(self.repo.root))
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn("release        .github/workflows/release.yml · the Go template, byte for byte", run.stdout)
        self.assertEqual(run.stdout.strip().splitlines()[-1], "✔ set up for keel releases")

        self.repo.remove(".keel")
        run = self.run_script(str(self.repo.root))
        self.assertEqual(run.returncode, 1)
        self.assertIn("[keel-missing]", run.stdout)
        self.assertEqual(run.stdout.strip().splitlines()[-1], "✖ 1 error, 0 warnings")

    def test_a_bare_go_module_lists_every_gap(self) -> None:
        base = Path(self.tmp.name) / "bare"
        base.mkdir()
        self.repo = Repo.create(base)
        self.repo.write("go.mod", "module github.com/acme/widget\n\ngo 1.25\n")
        self.repo.commit("feat: the first thing")
        report = self.expect(
            (".keel", "keel-missing"),
            (WORKFLOW, "release-missing"),
            (REPORTER, "script-missing"),
            (".gitignore", "dist-not-ignored"),
            (".github/workflows", "no-ci"),
        )
        self.assertEqual(self.levels(report, "no-ci"), {"warn"})
        self.assertIn("keel init --dry-run", self.messages(report, "keel-missing"))
        self.assertIsNone(report["facts"]["docs"])

    def test_keel_init_needs_a_first_commit(self) -> None:
        base = Path(self.tmp.name) / "new"
        base.mkdir()
        self.repo = Repo.create(base)
        self.repo.write("go.mod", "module github.com/acme/widget\n\ngo 1.25\n")
        status, report = self.audit()
        self.assertEqual(status, 1)
        self.assertFalse(report["facts"]["head"])
        self.assertIn("no commit", self.messages(report, "keel-missing"))
        self.assertIn("the user's to make", self.messages(report, "keel-missing"))

    def test_a_subfolder_audits_the_whole_repository(self) -> None:
        run = self.run_script(str(self.repo.root / "docs"), "--json")
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertEqual(Path(json.loads(run.stdout)["facts"]["root"]).resolve(), self.repo.root.resolve())

    def test_outside_a_repository_is_exit_2(self) -> None:
        outside = Path(self.tmp.name) / "nowhere"
        outside.mkdir()
        env = {**self.repo.env, "GIT_CEILING_DIRECTORIES": self.tmp.name}
        for args in ((str(outside),), (str(outside), "--json"), (str(outside / "missing"), "--json")):
            run = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env)
            self.assertEqual(run.returncode, 2, run.stdout)
        self.assertEqual(json.loads(run.stdout)["error"], "no_repository")

    # -------------------------------------------------------------- origin --

    def test_no_origin(self) -> None:
        self.repo.git("remote", "remove", "origin")
        self.expect(("origin", "no-origin"), (".keel", "keel-remote"))

    def test_an_origin_that_is_not_github(self) -> None:
        self.repo.git("remote", "set-url", "origin", "git@gitlab.com:acme/widget.git")
        report = self.expect(("origin", "origin-not-github"))
        self.assertIsNone(report["facts"]["origin"]["repository"])

    def test_a_credential_in_the_remote_url_is_never_printed(self) -> None:
        self.repo.git("remote", "set-url", "origin", "https://x-access-token:ghs_example0secret@github.com/acme/widget.git")
        run = self.run_script(str(self.repo.root), "--json")
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertNotIn("ghs_example0secret", run.stdout)
        self.assertEqual(json.loads(run.stdout)["facts"]["origin"]["url"], "https://***@github.com/acme/widget.git")
        self.assertNotIn("ghs_example0secret", self.run_script(str(self.repo.root)).stdout)

    def test_every_shape_of_github_url_is_origin(self) -> None:
        for url in ("https://github.com/acme/widget", "https://github.com/acme/widget.git",
                    "ssh://git@github.com/acme/widget.git", "github.com:acme/widget.git"):
            self.repo.git("remote", "set-url", "origin", url)
            status, report = self.audit()
            self.assertEqual((status, report["facts"]["origin"]["repository"]), (0, "acme/widget"), url)

    # --------------------------------------------------------------- .keel --

    def test_a_keel_file_nobody_committed(self) -> None:
        self.repo.git("rm", "-q", "--cached", ".keel")
        report = self.expect((".keel", "untracked"), code=0)
        self.assertEqual(self.levels(report, "untracked"), {"warn"})
        self.expect((".keel", "untracked"), extra=("--strict",))
        # Staged counts: git tracks it from then on.
        self.repo.git("add", ".keel")
        self.expect(code=0, extra=("--strict",))

    def test_a_keel_file_that_is_not_yaml(self) -> None:
        self.repo.write(".keel", 'keel: "0.3.9\n')
        report = self.expect((".keel", "keel-unparseable"))
        self.assertEqual(report["findings"][0]["line"], 1)

    def test_a_keel_file_missing_its_settings(self) -> None:
        self.repo.write(".keel", 'keel: "0.3.9"\n\nproject:\n  name: widget\n  repository: acme/widget\n')
        self.assertIn("release", self.messages(self.expect((".keel", "keel-shape")), "keel-shape"))
        self.repo.write(".keel", KEEL.replace("  version_files: []\n", ""))
        self.assertIn("release.version_files", self.messages(self.expect((".keel", "keel-shape")), "keel-shape"))

    def test_a_keel_file_for_another_repository(self) -> None:
        self.repo.edit(".keel", "repository: acme/widget", "repository: acme/gadget")
        report = self.expect((".keel", "keel-repository"))
        self.assertIn("acme/gadget, but origin is acme/widget", self.messages(report, "keel-repository"))
        self.assertEqual(report["findings"][0]["line"], 8)

    def test_a_keel_file_written_without_a_github_remote(self) -> None:
        self.repo.edit(".keel", "  repository: acme/widget\n", "  # repository: owner/name   (no GitHub remote found)\n")
        self.expect((".keel", "keel-repository"))

    def test_the_repository_is_compared_without_case(self) -> None:
        self.repo.edit(".keel", "repository: acme/widget", "repository: Acme/Widget")
        self.expect(code=0, extra=("--strict",))

    def test_a_project_name_that_is_not_the_repository(self) -> None:
        self.repo.edit(".keel", "name: widget", "name: gadget")
        self.assertEqual(self.levels(self.expect((".keel", "keel-name"), code=0), "keel-name"), {"warn"})

    def test_a_release_remote_that_does_not_exist(self) -> None:
        self.repo.edit(".keel", "remote: origin", "remote: upstream")
        self.assertEqual(self.levels(self.expect((".keel", "keel-remote")), "keel-remote"), {"error"})

    def test_a_release_remote_other_than_origin(self) -> None:
        self.repo.git("remote", "add", "upstream", "git@github.com:acme/widget.git")
        self.repo.edit(".keel", "remote: origin", "remote: upstream")
        self.assertEqual(self.levels(self.expect((".keel", "keel-remote"), code=0), "keel-remote"), {"warn"})

    def test_a_tag_prefix_other_than_v(self) -> None:
        self.repo.edit(".keel", "tag_prefix: v", "tag_prefix: release-")
        self.expect((".keel", "keel-tag-prefix"))

    def test_a_version_file_that_is_not_there(self) -> None:
        self.repo.edit(".keel", "  version_files: []\n", "  version_files:\n    - VERSION\n")
        report = self.expect((".keel", "keel-version-file"))
        self.assertEqual(self.levels(report, "keel-version-file"), {"error", "warn"})

    def test_a_go_module_listing_a_version_file(self) -> None:
        self.repo.write("package.json", '{"name": "tools", "private": true, "version": "0.0.0"}\n')
        self.repo.edit(".keel", "  version_files: []\n", "  version_files:\n    - package.json\n")
        report = self.expect((".keel", "keel-version-file"), code=0)
        self.assertIn("a Go module's version is its tag", self.messages(report, "keel-version-file"))

    def test_a_rust_crate_lists_its_manifest_quietly(self) -> None:
        self.repo.remove("go.mod")
        self.repo.write("Cargo.toml", '[package]\nname = "widget"\nversion = "0.1.0"\n')
        self.repo.edit(".keel", "  version_files: []\n", "  version_files:\n    - Cargo.toml\n")
        self.repo.commit()
        status, report = self.audit("--strict")
        self.assertEqual((status, report["findings"]), (0, []))
        self.assertEqual(report["facts"]["kind"], ["rust"])

    def test_a_branch_keel_init_took_from_a_feature_branch(self) -> None:
        self.repo.git("update-ref", "refs/remotes/origin/trunk", "HEAD")
        self.repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
        report = self.expect((".keel", "keel-branch"), code=0)
        self.assertIn("default branch is trunk", self.messages(report, "keel-branch"))

    def test_a_branch_that_exists_nowhere(self) -> None:
        self.repo.edit(".keel", "branch: main", "branch: release")
        report = self.expect((".keel", "keel-branch"), code=0)
        self.assertIn("not a branch here or on origin", self.messages(report, "keel-branch"))

    # ---------------------------------------------------- release workflow --

    def test_no_release_workflow(self) -> None:
        self.repo.remove(WORKFLOW)
        report = self.expect((WORKFLOW, "release-missing"))
        self.assertIsNone(report["facts"]["release_workflow"])

    def test_release_yaml_counts_too(self) -> None:
        (self.repo.root / WORKFLOW).rename(self.repo.root / ".github/workflows/release.yaml")
        self.repo.commit()
        status, report = self.audit("--strict")
        self.assertEqual((status, report["findings"]), (0, []))
        self.assertEqual(report["facts"]["release_workflow"]["path"], ".github/workflows/release.yaml")

    def test_a_workflow_that_is_not_yaml(self) -> None:
        self.repo.write(WORKFLOW, "name: Release\non:\n\tpush: {}\n")
        report = self.expect((WORKFLOW, "release-unparseable"))
        self.assertEqual(report["findings"][0]["line"], 3)

    def test_the_same_workflow_in_another_yaml_style_passes(self) -> None:
        text = self.repo.read(WORKFLOW)
        for old, new in (
            ("name: Release\n", '"name": "Release"  # the same, quoted\n'),
            ("\non:\n", '\n"on":\n'),
            ('    tags: ["v*.*.*"]\n', "    tags:\n      - 'v*.*.*'\n"),
            ("  cancel-in-progress: false\n", '  "cancel-in-progress": "false"\n'),
        ):
            self.assertIn(old, text)
            text = text.replace(old, new, 1)
        before, verify, report = job(text, "verify")[0], job(text, "verify")[1], job(text, "report")[1]
        # verify's checkout as a flow mapping; report's steps as a compact list.
        verify = verify.replace("        with:\n          ref: ${{ inputs.tag || github.ref }}\n",
                                "        with: {ref: '${{ inputs.tag || github.ref }}'}\n")
        head, steps = report.split("    steps:\n", 1)
        steps = "\n".join(line[2:] if line.startswith("      ") else line for line in steps.split("\n"))
        self.repo.write(WORKFLOW, before + verify + head + "    steps:\n" + steps)
        self.assertIn("    - uses: actions/checkout@v7\n", self.repo.read(WORKFLOW))
        status, report = self.audit("--strict")
        self.assertEqual((status, report["findings"]), (0, []), json.dumps(report["findings"], indent=1))
        self.assertFalse(report["facts"]["release_workflow"]["go_template"])
        self.assertTrue(report["facts"]["release_workflow"]["report_job_canonical"])

    def test_a_workflow_that_never_starts_on_a_tag(self) -> None:
        self.repo.edit(WORKFLOW, '  push:\n    tags: ["v*.*.*"]\n', "")
        self.assertIn("does not start on a pushed tag",
                      self.messages(self.expect((WORKFLOW, "release-trigger")), "release-trigger"))

    def test_a_workflow_that_runs_on_every_push(self) -> None:
        self.repo.edit(WORKFLOW, '  push:\n    tags: ["v*.*.*"]\n', "  push:\n")
        self.assertIn("every push", self.messages(self.expect((WORKFLOW, "release-trigger")), "release-trigger"))

    def test_a_workflow_that_runs_on_branches_too(self) -> None:
        self.repo.edit(WORKFLOW, '    tags: ["v*.*.*"]\n', '    tags: ["v*.*.*"]\n    branches: [main]\n')
        self.assertIn("also runs on branch pushes",
                      self.messages(self.expect((WORKFLOW, "release-trigger")), "release-trigger"))

    def test_a_workflow_that_runs_on_pull_requests(self) -> None:
        self.repo.edit(WORKFLOW, "  workflow_dispatch:\n", "  pull_request:\n  workflow_dispatch:\n")
        self.assertIn("pull_request", self.messages(self.expect((WORKFLOW, "release-trigger")), "release-trigger"))

    def test_a_broader_tag_pattern_only_warns(self) -> None:
        self.repo.edit(WORKFLOW, 'tags: ["v*.*.*"]', 'tags: ["v*"]')
        self.assertEqual(self.levels(self.expect((WORKFLOW, "release-trigger"), code=0), "release-trigger"), {"warn"})

    def test_a_tag_pattern_keel_never_matches(self) -> None:
        self.repo.edit(WORKFLOW, 'tags: ["v*.*.*"]', 'tags: ["release-*"]')
        self.assertEqual(self.levels(self.expect((WORKFLOW, "release-trigger")), "release-trigger"), {"error"})

    def test_no_manual_run(self) -> None:
        text = self.repo.read(WORKFLOW)
        start = text.index("  # Reports a tag again")
        end = text.index("\npermissions:")
        self.repo.write(WORKFLOW, text[:start] + text[end:])
        self.expect((WORKFLOW, "release-dispatch"))

    def test_a_manual_run_without_a_tag(self) -> None:
        text = self.repo.read(WORKFLOW)
        start = text.index("    inputs:\n")
        end = text.index("\npermissions:")
        self.repo.write(WORKFLOW, text[:start] + text[end:])
        self.assertIn("no tag input", self.messages(self.expect((WORKFLOW, "release-dispatch")), "release-dispatch"))

    def test_an_optional_tag_input_warns(self) -> None:
        self.repo.edit(WORKFLOW, "        required: true\n", "        required: false\n")
        self.assertEqual(self.levels(self.expect((WORKFLOW, "release-dispatch"), code=0), "release-dispatch"), {"warn"})

    def test_no_concurrency(self) -> None:
        text = self.repo.read(WORKFLOW)
        start = text.index("# One run per tag.")
        end = text.index("\njobs:")
        self.repo.write(WORKFLOW, text[:start] + text[end + 1 :])
        self.expect((WORKFLOW, "release-concurrency"))

    def test_concurrency_that_cancels(self) -> None:
        self.repo.edit(WORKFLOW, "cancel-in-progress: false", "cancel-in-progress: true")
        report = self.expect((WORKFLOW, "release-concurrency"))
        self.assertIn("cancel", self.messages(report, "release-concurrency"))
        self.assertEqual(report["findings"][0]["line"], 35)

    def test_concurrency_decided_by_an_expression_warns(self) -> None:
        self.repo.edit(WORKFLOW, "cancel-in-progress: false", "cancel-in-progress: ${{ github.event_name == 'push' }}")
        self.expect((WORKFLOW, "release-concurrency"), code=0)

    def test_concurrency_that_is_not_per_tag(self) -> None:
        self.repo.edit(WORKFLOW, "group: release-${{ inputs.tag || github.ref }}", "group: release")
        self.assertEqual(self.levels(self.expect((WORKFLOW, "release-concurrency")), "release-concurrency"), {"error"})

    def test_concurrency_that_forgets_the_manual_tag_warns(self) -> None:
        self.repo.edit(WORKFLOW, "group: release-${{ inputs.tag || github.ref }}", "group: release-${{ github.ref }}")
        self.expect((WORKFLOW, "release-concurrency"), code=0)

    def test_no_verify_job(self) -> None:
        self.repo.edit(WORKFLOW, "  verify:\n    name: verify\n", "  checks:\n    name: checks\n")
        self.expect((WORKFLOW, "release-verify"))

    def test_a_verify_job_with_nothing_to_do(self) -> None:
        before, _, after = job(self.repo.read(WORKFLOW), "verify")
        self.repo.write(WORKFLOW, before + "  verify:\n    name: verify\n    runs-on: ubuntu-latest\n\n" + after)
        self.assertIn("no steps", self.messages(self.expect((WORKFLOW, "release-verify")), "release-verify"))

    def test_a_verify_job_that_checks_the_branch_warns(self) -> None:
        self.edit_job("verify", "        with:\n          ref: ${{ inputs.tag || github.ref }}\n", "")
        self.expect((WORKFLOW, "release-verify"), code=0)

    def test_an_adapted_verify_job_is_fine(self) -> None:
        self.edit_job("verify", "      - uses: actions/setup-go@v7\n        with:\n          go-version-file: go.mod\n", "")
        self.edit_job("verify", "run: go build ./...", "run: cargo build --locked")
        status, report = self.audit("--strict")
        self.assertEqual((status, report["findings"]), (0, []))
        self.assertFalse(report["facts"]["release_workflow"]["go_template"])

    def test_no_report_job(self) -> None:
        before, _, after = job(self.repo.read(WORKFLOW), "report")
        self.repo.write(WORKFLOW, before + after)
        report = self.expect((WORKFLOW, "report-job"))
        self.assertFalse(report["facts"]["release_workflow"]["report_job_canonical"])

    def test_a_report_job_that_does_not_wait_for_verify(self) -> None:
        self.edit_job("report", "    needs: verify\n", "")
        self.expect((WORKFLOW, "report-needs"))

    def test_a_report_job_that_only_runs_on_success(self) -> None:
        self.edit_job("report", "    if: ${{ !cancelled() }}\n", "")
        self.assertIn("never reported", self.messages(self.expect((WORKFLOW, "report-if")), "report-if"))

    def test_a_report_job_that_reports_cancelled_runs(self) -> None:
        self.edit_job("report", "if: ${{ !cancelled() }}", "if: ${{ always() }}")
        self.assertIn("always()", self.messages(self.expect((WORKFLOW, "report-if")), "report-if"))

    def test_a_report_job_on_another_condition(self) -> None:
        self.edit_job("report", "if: ${{ !cancelled() }}", "if: ${{ success() }}")
        self.expect((WORKFLOW, "report-if"))

    def test_a_report_job_that_never_runs_the_script(self) -> None:
        self.edit_job("report", "run: bash .github/scripts/report-version.sh", "run: echo skipped")
        self.expect((WORKFLOW, "report-run"))

    def test_a_report_job_without_a_checkout(self) -> None:
        self.edit_job("report", "      - uses: actions/checkout@v7\n        with:\n          ref: ${{ inputs.tag || github.ref }}\n", "")
        self.expect((WORKFLOW, "report-checkout"))

    def test_a_report_job_that_checks_out_the_branch(self) -> None:
        self.edit_job("report", "        with:\n          ref: ${{ inputs.tag || github.ref }}\n", "")
        self.assertIn("inputs.tag", self.messages(self.expect((WORKFLOW, "report-checkout")), "report-checkout"))

    def test_a_report_step_missing_a_variable(self) -> None:
        self.edit_job("report", "          KEEL_CHECKS: ${{ needs.verify.result }}\n", "")
        self.assertIn("KEEL_CHECKS", self.messages(self.expect((WORKFLOW, "report-env")), "report-env"))

    def test_a_status_that_ignores_verify(self) -> None:
        self.edit_job("report", "KEEL_STATUS: ${{ needs.verify.result == 'success' && 'published' || 'failed' }}",
                      "KEEL_STATUS: published")
        self.assertIn("KEEL_STATUS", self.messages(self.expect((WORKFLOW, "report-env")), "report-env"))

    def test_a_tag_that_ignores_the_manual_input(self) -> None:
        self.edit_job("report", "KEEL_TAG: ${{ inputs.tag || github.ref_name }}", "KEEL_TAG: ${{ github.ref_name }}")
        self.assertIn("KEEL_TAG", self.messages(self.expect((WORKFLOW, "report-env")), "report-env"))

    def test_a_credential_written_into_the_workflow(self) -> None:
        token = "klc_0123456789abcdef01234567_notarealsecretatall"
        self.edit_job("report", "KEEL_CI_TOKEN: ${{ secrets.KEEL_CI_TOKEN }}", f"KEEL_CI_TOKEN: {token}")
        report = self.expect((WORKFLOW, "report-secret"))
        self.assertIn("revoke it", self.messages(report, "report-secret"))
        for args in ((str(self.repo.root), "--json"), (str(self.repo.root),)):
            self.assertNotIn("notarealsecret", self.run_script(*args).stdout)

    def test_a_credential_that_is_not_a_secret(self) -> None:
        self.edit_job("report", "KEEL_CI_TOKEN: ${{ secrets.KEEL_CI_TOKEN }}", "KEEL_CI_TOKEN: ${{ vars.KEEL_CI_TOKEN }}")
        self.expect((WORKFLOW, "report-secret"))

    def test_a_working_but_changed_report_job_is_drift(self) -> None:
        self.edit_job("report", "      - name: report the version\n", "      - name: tell keel\n")
        report = self.expect((WORKFLOW, "report-drift"), code=0)
        self.assertEqual(report["findings"][0]["details"]["differences"], ["steps[1].name"])
        self.expect((WORKFLOW, "report-drift"), extra=("--strict",))

    def test_variables_set_on_the_job_still_count(self) -> None:
        self.edit_job("report", "          KEEL_CHECKS: ${{ needs.verify.result }}\n", "")
        self.edit_job("report", "    timeout-minutes: 10\n",
                      "    timeout-minutes: 10\n    env:\n      KEEL_CHECKS: ${{ needs.verify.result }}\n")
        report = self.expect((WORKFLOW, "report-drift"), code=0)
        self.assertIn("env", " ".join(report["findings"][0]["details"]["differences"]))

    def test_an_untracked_workflow(self) -> None:
        self.repo.git("rm", "-q", "--cached", WORKFLOW)
        self.expect((WORKFLOW, "untracked"), code=0)

    # ------------------------------------------------------ report script --

    def test_no_report_script(self) -> None:
        self.repo.remove(REPORTER)
        report = self.expect((REPORTER, "script-missing"))
        self.assertIsNone(report["facts"]["report_script"])

    def test_an_edited_report_script_is_drift(self) -> None:
        self.repo.edit(REPORTER, "attempts=${KEEL_ATTEMPTS:-6}", "attempts=${KEEL_ATTEMPTS:-3}")
        report = self.expect((REPORTER, "script-drift"))
        finding = report["findings"][0]
        self.assertIn("1 line differs, the first at line 213", finding["message"])
        bundled = hashlib.sha256((ASSETS / "report-version.sh").read_bytes()).hexdigest()
        self.assertEqual(finding["details"]["canonical_sha256"], bundled)
        self.assertEqual(finding["details"]["sha256"],
                         hashlib.sha256((self.repo.root / REPORTER).read_bytes()).hexdigest())
        self.assertIn("+attempts=${KEEL_ATTEMPTS:-3}", finding["details"]["diff"])
        self.assertFalse(report["facts"]["report_script"]["identical"])

    def test_drift_against_the_bundled_copy_points_at_keel_api(self) -> None:
        self.repo.edit(REPORTER, "attempts=${KEEL_ATTEMPTS:-6}", "attempts=${KEEL_ATTEMPTS:-3}")
        self.assertIn("audit again with --canonical",
                      self.messages(self.expect((REPORTER, "script-drift")), "script-drift"))
        canonical = Path(self.tmp.name) / "canonical.sh"
        shutil.copyfile(ASSETS / "report-version.sh", canonical)
        report = self.expect((REPORTER, "script-drift"), extra=("--canonical", str(canonical)))
        self.assertNotIn("--canonical", self.messages(report, "script-drift"))
        self.assertIn(str(canonical), self.messages(report, "script-drift"))

    def test_windows_line_endings_are_named(self) -> None:
        self.repo.write(REPORTER, (ASSETS / "report-version.sh").read_bytes().replace(b"\n", b"\r\n"), mode=0o755)
        self.assertIn("CRLF", self.messages(self.expect((REPORTER, "script-drift")), "script-drift"))

    def test_whitespace_only_drift_is_named(self) -> None:
        self.repo.edit(REPORTER, "set -euo pipefail\n", "set -euo pipefail  \n")
        self.assertIn("only whitespace", self.messages(self.expect((REPORTER, "script-drift")), "script-drift"))

    def test_a_script_that_is_not_executable(self) -> None:
        (self.repo.root / REPORTER).chmod(0o644)
        report = self.expect((REPORTER, "script-not-executable"))
        self.assertIn("chmod 755", self.messages(report, "script-not-executable"))

    def test_a_script_git_records_as_not_executable(self) -> None:
        self.repo.git("update-index", "--chmod=-x", REPORTER)
        report = self.expect((REPORTER, "script-not-executable"))
        self.assertIn("100644", self.messages(report, "script-not-executable"))
        self.assertIn("git update-index --chmod=+x", self.messages(report, "script-not-executable"))

    def test_an_untracked_script(self) -> None:
        self.repo.git("rm", "-q", "--cached", REPORTER)
        report = self.expect((REPORTER, "untracked"), code=0)
        self.assertIsNone(report["facts"]["report_script"]["index_mode"])

    def test_a_fresher_canonical_script_shows_both_drifts(self) -> None:
        fresher = Path(self.tmp.name) / "canonical.sh"
        fresher.write_bytes((ASSETS / "report-version.sh").read_bytes() + b"# keel-api moved on\n")
        report = self.expect((REPORTER, "script-drift"), (str(ASSETS / "report-version.sh"), "bundled-stale"),
                             extra=("--canonical", str(fresher)))
        self.assertEqual(self.levels(report, "bundled-stale"), {"warn"})
        self.assertEqual(report["facts"]["canonical"], str(fresher))

    def test_a_repository_already_on_the_fresher_canonical(self) -> None:
        fresher = Path(self.tmp.name) / "canonical.sh"
        fresher.write_bytes((ASSETS / "report-version.sh").read_bytes() + b"# keel-api moved on\n")
        self.repo.write(REPORTER, fresher.read_bytes())
        report = self.expect((str(ASSETS / "report-version.sh"), "bundled-stale"), code=0,
                             extra=("--canonical", str(fresher)))
        self.assertTrue(report["facts"]["report_script"]["identical"])

    def test_the_bundled_copy_as_canonical_changes_nothing(self) -> None:
        self.expect(code=0, extra=("--strict", "--canonical", str(ASSETS / "report-version.sh")))

    def test_an_unreadable_canonical_is_exit_2(self) -> None:
        run = self.run_script(str(self.repo.root), "--json", "--canonical", str(Path(self.tmp.name) / "nope.sh"))
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout)["error"], "no_canonical")

    def test_an_edited_bundled_copy_is_caught(self) -> None:
        skill = Path(self.tmp.name) / "keel-setup"
        shutil.copytree(SKILL, skill, ignore=shutil.ignore_patterns("__pycache__"))
        with (skill / "assets/report-version.sh").open("ab") as script:
            script.write(b"# edited\n")
        status, report = self.audit(script=skill / "scripts/check_setup.py")
        self.assertEqual(status, 1)
        self.assertEqual(self.codes(report), {(str((skill / "assets/report-version.sh").resolve()), "bundled-corrupt")})
        self.assertIsNone(report["facts"]["report_script"]["identical"])

    def test_a_missing_bundled_copy_is_caught(self) -> None:
        skill = Path(self.tmp.name) / "keel-setup"
        shutil.copytree(SKILL, skill, ignore=shutil.ignore_patterns("__pycache__"))
        (skill / "assets/report-version.sh").unlink()
        status, report = self.audit(script=skill / "scripts/check_setup.py")
        self.assertEqual(status, 1)
        self.assertEqual({code for _, code in self.codes(report)}, {"bundled-corrupt"})
        # --canonical still works without it: keel-api's copy is all it needs.
        status, report = self.audit("--canonical", str(ASSETS / "report-version.sh"),
                                    script=skill / "scripts/check_setup.py")
        self.assertEqual({code for _, code in self.codes(report)}, {"bundled-stale"})
        self.assertTrue(report["facts"]["report_script"]["identical"])

    # ------------------------------------------------------------------ docs --

    def test_a_repository_without_docs_needs_no_page(self) -> None:
        shutil.rmtree(self.repo.root / "docs")
        self.repo.commit()
        status, report = self.audit("--strict")
        self.assertEqual((status, report["findings"]), (0, []))
        self.assertIsNone(report["facts"]["docs"])

    def test_docs_without_the_releases_page(self) -> None:
        self.repo.remove("docs/releases.md")
        self.expect(("docs/releases.md", "releases-missing"))

    def test_a_releases_page_the_index_never_links(self) -> None:
        self.repo.edit("docs/README.md", "- [Releases and version reporting](releases.md) — cutting a version.\n",
                       "- [Getting started](getting-started.md)\n")
        self.expect(("docs/README.md", "releases-unlisted"))

    def test_a_link_inside_a_code_fence_does_not_count(self) -> None:
        self.repo.edit("docs/README.md", "- [Releases and version reporting](releases.md) — cutting a version.\n",
                       "```markdown\n- [Releases](releases.md)\n```\n")
        self.expect(("docs/README.md", "releases-unlisted"))

    def test_a_releases_page_linked_only_from_prose(self) -> None:
        self.repo.edit("docs/README.md", "- [Releases and version reporting](releases.md) — cutting a version.\n",
                       "Read [how releases work](./releases.md#setup) first.\n")
        report = self.expect(("docs/README.md", "releases-prose-link"), code=0)
        self.assertEqual(self.levels(report, "releases-prose-link"), {"warn"})

    def test_numbered_lists_and_tables_are_the_sidebar(self) -> None:
        for entry in ("7. [Releases and version reporting](releases.md) — cut a version.\n",
                      "| 7 | [Releases](releases.md) | Cut a version. |\n",
                      "- [Architecture](architecture.md) and\n  [releases](releases.md).\n"):
            self.repo.edit("docs/README.md", self.repo.read("docs/README.md").split("## Reference\n\n", 1)[1], entry)
            self.expect(code=0, extra=("--strict",))

    def test_no_index_at_all(self) -> None:
        self.repo.remove("docs/README.md")
        self.expect(("docs/README.md", "releases-unlisted"))

    def test_a_page_left_unrendered(self) -> None:
        self.repo.write("docs/releases.md", (ASSETS / "releases.md").read_text(encoding="utf-8"))
        report = self.expect(("docs/releases.md", "releases-placeholder"))
        for placeholder in ("{{name}}", "{{repository}}", "{{module}}"):
            self.assertIn(placeholder, self.messages(report, "releases-placeholder"))

    def test_a_page_copied_from_another_repository(self) -> None:
        self.repo.write("docs/releases.md", render(repository="fundathyon/fd_http"))
        self.assertIn("fundathyon/fd_http", self.messages(
            self.expect(("docs/releases.md", "releases-other-repository")), "releases-other-repository"))
        self.repo.write("docs/releases.md", render(name="fd_http"))
        self.expect(("docs/releases.md", "releases-library"))

    def test_an_untracked_page(self) -> None:
        self.repo.git("rm", "-q", "--cached", "docs/releases.md")
        self.expect(("docs/releases.md", "untracked"), code=0)

    # ------------------------------------------------------ .gitignore, CI --

    def test_dist_not_ignored(self) -> None:
        self.repo.write(".gitignore", "coverage.out\n")
        report = self.expect((".gitignore", "dist-not-ignored"))
        self.assertFalse(report["facts"]["dist_ignored"])

    def test_every_way_of_ignoring_dist_counts(self) -> None:
        for rule in ("dist\n", "/dist/\n", "dist/**\n"):
            self.repo.write(".gitignore", rule)
            self.expect(code=0, extra=("--strict",))

    def test_no_ci_workflow_warns(self) -> None:
        self.repo.remove(".github/workflows/ci.yml")
        self.expect((".github/workflows", "no-ci"), code=0)
        self.expect((".github/workflows", "no-ci"), extra=("--strict",))

    def test_a_workflow_on_tags_only_is_not_ci(self) -> None:
        self.repo.write(".github/workflows/ci.yml", 'on:\n  push:\n    tags: ["v*"]\njobs: {}\n')
        self.expect((".github/workflows", "no-ci"), code=0)

    def test_a_pull_request_workflow_is_ci(self) -> None:
        self.repo.write(".github/workflows/ci.yml", "on: [pull_request]\njobs: {}\n")
        self.expect(code=0, extra=("--strict",))


class BundledFiles(unittest.TestCase):
    """The assets are copies of real files; these keep them honest."""

    def test_the_script_matches_its_recorded_checksum(self) -> None:
        recorded, name = (ASSETS / "report-version.sh.sha256").read_text(encoding="utf-8").split()
        self.assertEqual(name, "report-version.sh")
        self.assertEqual(hashlib.sha256((ASSETS / "report-version.sh").read_bytes()).hexdigest(), recorded)

    def test_the_script_is_executable(self) -> None:
        self.assertTrue((ASSETS / "report-version.sh").stat().st_mode & 0o111, "keel-api keeps it at 755")

    def test_the_go_template_is_the_workflow_fd_http_and_fd_logging_run(self) -> None:
        self.assertEqual(hashlib.sha256((ASSETS / "release.yml").read_bytes()).hexdigest(), RELEASE_YML_SHA256)

    def test_the_page_template_renders_fd_http_and_fd_logging(self) -> None:
        for name, expected in RELEASES_PAGE_SHA256.items():
            page = render(name, f"fundathyon/{name}", f"github.com/fundathyon/{name}")
            self.assertEqual(hashlib.sha256(page.encode("utf-8")).hexdigest(), expected, name)

    def test_the_page_template_has_three_placeholders(self) -> None:
        text = (ASSETS / "releases.md").read_text(encoding="utf-8")
        self.assertEqual({part.split("}}")[0] for part in text.split("{{")[1:]}, {"name", "repository", "module"})


if __name__ == "__main__":
    unittest.main()
