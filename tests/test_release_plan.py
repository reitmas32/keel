"""Tests for keel-release's planner, against real throwaway repositories."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "plugins/keel-release/skills/keel-release/scripts/release_plan.py"
)

KEEL = """\
# .keel — project settings for the keel CLI
keel: "0.3.6"

project:
  name: widget
  repository: acme/widget

release:
  remote: origin
  branch: "main"
  tag_prefix: v
  version_files:
    - Cargo.toml
"""

CARGO = """\
[package]
name = "widget"
version = "{version}"

[dependencies]
anyhow = {{ version = "1.0" }}
"""

ENV = {
    **os.environ,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


class Repo:
    """A working repository in `base/work`, with a bare `base/remote.git` it
    can be published to."""

    def __init__(self, base: Path) -> None:
        self.base = base
        self.root = base / "work"
        self.root.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")

    def publish(self) -> None:
        """Push main to a bare remote and track it, as a real clone would."""
        bare = self.base / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True, env=ENV)
        self.git("remote", "add", "origin", str(bare))
        self.git("push", "-q", "-u", "origin", "main")

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True, capture_output=True, text=True, env=ENV,
        ).stdout

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, message: str, rel: str | None = None, text: str | None = None) -> None:
        if rel is not None:
            self.write(rel, text if text is not None else message)
            self.git("add", rel)
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def tag(self, name: str) -> None:
        self.git("tag", "-a", name, "-m", name)


class ReleasePlan(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def plan(self) -> dict:
        run = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.repo.root), "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(run.stdout)

    def rust(self, version: str) -> None:
        """A released Rust crate with .keel committed, tagged at `version`."""
        self.repo.commit("chore: keel", ".keel", KEEL)
        self.repo.commit("chore: crate", "Cargo.toml", CARGO.format(version=version))
        self.repo.tag(f"v{version}")
        self.repo.publish()

    def test_a_first_release_starts_at_0_1_0(self) -> None:
        self.repo.commit("feat: the first thing", "a.txt")
        plan = self.plan()
        self.assertIsNone(plan["last"])
        self.assertEqual(plan["proposal"]["version"], "0.1.0")
        self.assertEqual(plan["proposal"]["bump"], "first")
        self.assertTrue(any("no .keel" in problem for problem in plan["problems"]))

    def test_a_first_release_keeps_the_version_the_files_carry(self) -> None:
        self.repo.commit("chore: keel", ".keel", KEEL)
        self.repo.commit("feat: crate", "Cargo.toml", CARGO.format(version="0.4.0"))
        self.assertEqual(self.plan()["proposal"]["version"], "0.4.0")

    def test_before_1_0_features_ship_as_a_patch(self) -> None:
        self.rust("0.3.6")
        self.repo.commit("feat(cli): something new", "b.txt")
        self.repo.commit("docs: explain it", "c.txt")
        plan = self.plan()
        self.assertEqual(plan["last"], {"tag": "v0.3.6", "version": "0.3.6"})
        self.assertEqual(plan["proposal"]["version"], "0.3.7")
        self.assertEqual(plan["counts"], {"breaking": 0, "feat": 1, "fix": 0, "other": 1})
        self.assertEqual(plan["version_files"][0]["version"], "0.3.6")
        self.assertEqual(plan["problems"], [])

    def test_before_1_0_a_breaking_change_moves_the_minor(self) -> None:
        self.rust("0.3.6")
        self.repo.commit("feat!: rename the flag", "b.txt")
        self.assertEqual(self.plan()["proposal"]["version"], "0.4.0")

    def test_from_1_0_each_kind_moves_its_own_place(self) -> None:
        self.rust("1.2.3")
        self.repo.commit("fix: a bug", "b.txt")
        self.assertEqual(self.plan()["proposal"]["version"], "1.2.4")
        self.repo.commit("feat: a feature", "c.txt")
        self.assertEqual(self.plan()["proposal"]["version"], "1.3.0")
        self.repo.commit("refactor: tidy\n\nBREAKING CHANGE: Config.Timeout is gone", "d.txt")
        plan = self.plan()
        self.assertEqual(plan["proposal"]["version"], "2.0.0")
        self.assertEqual(plan["counts"]["breaking"], 1)

    def test_nothing_since_the_tag_is_nothing_to_release(self) -> None:
        self.rust("0.3.6")
        self.assertIsNone(self.plan()["proposal"])

    def test_a_version_file_already_ahead_is_the_release(self) -> None:
        self.rust("0.3.6")
        self.repo.commit("chore(release): v0.4.0", "Cargo.toml", CARGO.format(version="0.4.0"))
        plan = self.plan()
        self.assertEqual(plan["proposal"]["version"], "0.4.0")
        self.assertEqual(plan["proposal"]["bump"], "already set")
        self.assertEqual(plan["problems"], [])

    def test_the_highest_version_is_the_last_release(self) -> None:
        self.repo.commit("feat: one", "a.txt")
        self.repo.tag("v1.0.0")
        self.repo.commit("fix: backport", "b.txt")
        # Tagged later, but lower: keel's last release is still v1.0.0.
        self.repo.tag("v0.9.1")
        for name in ("latest", "v1.0", "v01.2.3", "release-2"):
            self.repo.tag(name)
        self.assertEqual(self.plan()["last"]["tag"], "v1.0.0")

    def test_a_dirty_tree_and_the_wrong_branch_are_problems(self) -> None:
        self.rust("0.3.6")
        self.repo.git("checkout", "-q", "-b", "feature")
        self.repo.write("untracked.txt", "x")
        problems = " | ".join(self.plan()["problems"])
        self.assertIn("1 uncommitted change —", problems)
        self.assertIn("on feature, but releases come from main", problems)

    def test_a_go_module_going_to_v2_needs_its_path_changed(self) -> None:
        self.repo.commit("feat: go", "go.mod", "module github.com/acme/widget\n\ngo 1.25\n")
        self.repo.tag("v1.4.0")
        self.repo.commit("feat!: drop the old API", "a.go", "package widget\n")
        plan = self.plan()
        self.assertEqual(plan["go"], {"module": "github.com/acme/widget", "major_in_path": None})
        self.assertEqual(plan["proposal"]["version"], "2.0.0")
        self.assertTrue(any("/v2" in problem for problem in plan["problems"]))

    def test_workspace_and_dynamic_versions_are_read_where_they_live(self) -> None:
        self.repo.commit(
            "chore: keel",
            ".keel",
            KEEL.replace("    - Cargo.toml", "    - Cargo.toml\n    - pyproject.toml"),
        )
        self.repo.commit(
            "chore: workspace",
            "Cargo.toml",
            '[workspace.package]\nversion = "0.2.0"\n\n[package]\nname = "w"\nversion.workspace = true\n',
        )
        self.repo.commit(
            "chore: python",
            "pyproject.toml",
            '[project]\nname = "w"\ndynamic = ["version"]\n',
        )
        files = {entry["path"]: entry for entry in self.plan()["version_files"]}
        self.assertEqual(files["Cargo.toml"]["version"], "0.2.0")
        self.assertIsNone(files["pyproject.toml"]["version"])
        self.assertIn("dynamic", files["pyproject.toml"]["note"])

    def test_outside_a_repository_is_exit_2(self) -> None:
        outside = self.repo.base / "nowhere"
        outside.mkdir()
        env = {**ENV, "GIT_CEILING_DIRECTORIES": self.tmp.name}
        run = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(outside)],
            capture_output=True, text=True, env=env,
        )
        self.assertEqual(run.returncode, 2)


if __name__ == "__main__":
    unittest.main()
