"""Tests for keel-docs' audit script, run the way an agent runs it."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parent.parent
    / "keel-docs/skills/keel-docs/scripts/audit_docs.py"
)

INDEX = """\
---
title: widget documentation
description: The widget, documented.
library: widget
---

# widget documentation

`widget` does one thing well.

## Guides

| Step | Guide | Use it for |
| --- | --- | --- |
| 1 | [Getting started](getting-started.md) | Install it. |
"""

GUIDE = """\
---
title: Getting started
description: Install widget and make a first call.
library: widget
---

# Getting started

Use `Vec<u8>` freely inside backticks, and <https://example.com> as a link.

## 1. Install

```sh
go get example.com/widget
```

````markdown
```go
<details> inside an example is not HTML
# nor is this a heading
```
````
"""


class AuditDocs(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        (self.root / ".gitignore").write_text("dist/\n")
        self.docs = self.root / "docs"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, rel: str, text: str) -> None:
        path = self.docs / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text))

    def audit(self, *extra: str) -> tuple[int, dict]:
        run = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.docs), "--json", *extra],
            capture_output=True,
            text=True,
        )
        return run.returncode, json.loads(run.stdout)

    def codes(self, report: dict) -> set[tuple[str, str]]:
        return {(finding["path"], finding["code"]) for finding in report["findings"]}

    def test_a_clean_site_passes(self) -> None:
        self.write("README.md", INDEX)
        self.write("getting-started.md", GUIDE)
        code, report = self.audit("--strict")
        self.assertEqual(report["findings"], [])
        self.assertEqual((code, report["pages"]), (0, 2))

    def test_every_house_rule_is_caught(self) -> None:
        self.write("README.md", INDEX)
        self.write("getting-started.md", GUIDE.replace("library: widget", "library: gadget"))
        self.write(
            "Bad_Name.md",
            """\
            ---
            title: Bad page
            description: A page that breaks the rules.
            library: widget
            ---

            ## Before the title

            # Another title

            #### Skipped a level

            ```
            no language
            ```

            <!-- a note -->
            TODO: finish, and see [this](/rooted/path).
            """,
        )
        self.write("orphan.md", "# Orphan\n")
        self.write("guides/README.md", "---\ntitle: Unclosed\n")

        code, report = self.audit()
        self.assertEqual(code, 1)
        expected = {
            ("getting-started.md", "library"),
            ("Bad_Name.md", "file-name"),
            ("Bad_Name.md", "h1-first"),
            ("Bad_Name.md", "h1-title"),
            ("Bad_Name.md", "heading-jump"),
            ("Bad_Name.md", "fence-language"),
            ("Bad_Name.md", "raw-html"),
            ("Bad_Name.md", "placeholder"),
            ("Bad_Name.md", "rooted-link"),
            ("Bad_Name.md", "unlisted"),
            ("orphan.md", "front-matter"),
            ("orphan.md", "unlisted"),
            ("guides/README.md", "front-matter"),
        }
        self.assertEqual(self.codes(report), expected)

    def test_warnings_alone_pass_unless_strict(self) -> None:
        self.write("README.md", INDEX)
        self.write("getting-started.md", GUIDE.replace("```sh", "```"))
        self.assertEqual(self.audit()[0], 0)
        self.assertEqual(self.audit("--strict")[0], 1)

    def test_a_missing_index_is_an_error(self) -> None:
        self.write("getting-started.md", GUIDE)
        code, report = self.audit()
        self.assertEqual(code, 1)
        self.assertIn(("README.md", "no-index"), self.codes(report))

    def test_an_unignored_build_folder_is_flagged(self) -> None:
        (self.root / ".gitignore").write_text("")
        self.write("README.md", INDEX)
        self.write("getting-started.md", GUIDE)
        _, report = self.audit()
        self.assertIn((".gitignore", "dist-ignored"), self.codes(report))

    def test_the_library_name_can_be_required(self) -> None:
        self.write("README.md", INDEX)
        self.write("getting-started.md", GUIDE)
        code, report = self.audit("--library", "gadget")
        self.assertEqual(code, 1)
        self.assertIn(("README.md", "library"), self.codes(report))

    def test_no_docs_folder_is_exit_2(self) -> None:
        run = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root / "nowhere")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(run.returncode, 2)


if __name__ == "__main__":
    unittest.main()
