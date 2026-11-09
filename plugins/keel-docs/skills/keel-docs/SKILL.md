---
name: keel-docs
description: Write, extend or audit a repository's docs/ folder so it builds cleanly with `keel docs` (formerly `keel docs-gen`), Foundathyon's documentation site generator, and follows the documentation standard shared by every Foundathyon library and service. Use when asked to document a repository, library, service or CLI; to add, reorganize or fix guides; to fix `keel docs` or `keel docs-gen` errors such as broken links, unreadable markdown or a missing docs/README.md; or to review documentation before a release or pull request. Also use whenever you edit files under docs/ in a repository that has a .keel file.
metadata:
  version: "0.1.0"
  owner: fundathyon
---

# keel docs

Produce documentation that `keel docs` builds with no errors and no warnings,
and that reads the same way in every Foundathyon repository. keel is the judge
of compatibility: the docs are not done until `keel docs --check --strict`
passes.

`<skill-dir>` below is the folder that contains this SKILL.md.

## Ground rules

1. **Facts come from the code.** Every name, flag, default, environment
   variable, error, command and example must be verified in the repository —
   read it, grep it, run it. What you cannot verify, leave out and list under
   "Open questions" in your report. Never invent an API.
2. **Examples work.** Prefer snippets that mirror an executable example or a
   test (Go `example_test.go`, Rust doctests, tested TypeScript examples), and
   run them.
3. **Document the public contract.** Internals belong in `architecture.md`,
   written for maintainers, not in the user guides.
4. **One structure everywhere.** Use the standard in
   [references/foundathyon-standard.md](references/foundathyon-standard.md).
   When the repository already has a docs/ that builds, extend it in its own
   voice instead of rewriting it.
5. **Stay in your lane.** Change docs/, plus `.gitignore` and — when asked —
   README.md or examples. Do not refactor code to make it easier to document.

## Workflow

### 1. Preflight

- Repository root: `git rev-parse --show-toplevel`.
- Which keel: run `keel docs --help`.
  - It lists `--check` → use the commands in step 6 as written.
  - It does not → this keel predates checks and source links. Run
    `keel update` if a GitHub token is available. Otherwise validate with
    `keel docs --json --out "$(mktemp -d)/site"`, and keep every link inside
    docs/ — that version rejects any link that leaves it.
  - `keel` is not installed → say so to the user, continue with the audit
    script alone, and state in the report that keel compatibility was not
    verified.
- Read what exists: all of docs/, README.md, AGENTS.md, CLAUDE.md,
  `.github/copilot-instructions.md`, `.keel`, CONTRIBUTING, examples, and the
  public surface (exported symbols, CLI commands, config structs, environment
  variables, HTTP routes).
- Record the starting state: `keel docs --check`.

### 2. Decide the job

| Situation | Job |
| --- | --- |
| No docs/, or only a stub | Create the standard doc set |
| docs/ exists and builds | Extend it: keep its structure and voice, fill gaps, fix drift from the code |
| docs/ exists and fails | Make it build first (links, index, front matter), then improve it |
| Asked for a review | Audit: report findings with `file:line`; change nothing unless asked |

### 3. Build a fact sheet

Before any prose, list the facts each page needs, each with the `file:line`
that proves it: module or package name and install command, entry points,
configuration fields and defaults, errors, ownership and lifecycle rules, the
commands that run tests and examples. Writing from this list is what keeps
invented APIs out.

### 4. Plan the pages

Pick the doc set for the repository's kind (library, service, CLI, app) from
[references/foundathyon-standard.md](references/foundathyon-standard.md). One
page per task or concept, kebab-case file names, and a reading order — it
becomes the sidebar and the previous/next links.

### 5. Write

Start from [references/page-templates.md](references/page-templates.md). These
rules come from how keel reads markdown; the full contract is in
[references/keel-contract.md](references/keel-contract.md).

- **Front matter on every page**: `title`, `description` (one sentence) and
  `library` — the same value on every page, the repository or module name.
- **Exactly one `# H1`, first, identical to `title`.** keel drops the first H1
  and renders the title in its place, so a different H1 is silently lost.
- **`##` for sections, `###` for subsections.** They build the page's "On this
  page" list. Do not skip levels.
- **Every code fence names its language**: `go`, `sh`, `json`, `yaml`, `text`…
- **Links between pages are relative and keep `.md`**: `[Errors](errors.md)`,
  `[Retries](retry-strategies.md#when-to-retry)`.
- **Links to code are relative paths to files git tracks**:
  `[example_test.go](../example_test.go)`. keel turns them into links to the
  file on GitHub at the documented version. Never write `/rooted` paths; use
  full URLs only for other sites.
- **Images live under docs/** (for example `docs/img/`), linked relatively and
  with alt text.
- **No raw HTML and no HTML comments.** keel escapes them, so they reach the
  reader as literal text. Use blockquotes (`> **Note:** …`), lists and tables.
  A `<placeholder>` in prose counts as HTML too (and GitHub hides it): put it
  in backticks.
- **Write docs/README.md last**, so it lists every page: links in a list or a
  table under `##` headings are the sidebar.

### 6. Validate — loop until clean

1. `keel docs --check` must exit 0. Then `keel docs --check --strict` must
   exit 0 too: no unlisted pages, no raw HTML. Add `--json` to parse the
   result; each broken link carries a `reason` (see the table below).
2. `python3 <skill-dir>/scripts/audit_docs.py` checks the house conventions
   keel does not: front matter, H1 = title, code fence languages, heading
   levels, file names, placeholders, and that `dist/` is git-ignored. Fix every
   ERROR; fix every WARN unless you can say why it stays.
3. Run the examples with the repository's own commands (AGENTS.md "canonical
   commands", the Makefile, `go test ./...`, `cargo test`, `npm test`).
4. Optional visual pass: `keel docs --serve`, then open
   http://127.0.0.1:7331.

Repeat until all of them pass. Do not weaken a check to make it pass.

### 7. Report

- Pages created or changed, one line each.
- Evidence: the final line of `keel docs --check --strict` and of the audit.
- Open questions: facts you could not verify, and follow-ups such as a missing
  executable example.

## When keel says no

| keel reports | Fix |
| --- | --- |
| `there is no docs/ here` | Create `docs/README.md`, or pass `--docs <dir>` |
| `docs/README.md is missing` | Write the index |
| `N files unreadable` | Save as UTF-8; close the front matter with `---` |
| `→ target` with no reason | Nothing under docs/ at that path: fix the path or write the page |
| `git does not track it` | `git add` the file, or link to something tracked |
| `no --source-url to link it to` | The remote is not GitHub: pass `--source-url`, or link to a page instead |
| `an image has to live under docs/` | Move or copy the image into `docs/img/` |
| `outside the repository` | Too many `../` |
| `unlisted` | Add the page to a list or table in `docs/README.md` |
| `raw html` | Replace the HTML with markdown |
