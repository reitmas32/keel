# What `keel docs` reads, accepts and rejects

The rules below describe keel's documentation builder (`src/docs/` in
keel-cli). Where a behaviour only exists in newer keel releases it says
"newer keel": check with `keel docs --help` — if `--check` is listed, you have
it.

## Commands

| Command | Does |
| --- | --- |
| `keel docs --check` | Every check, nothing written (newer keel) |
| `keel docs --check --strict` | Also fails on warnings — the gate to pass |
| `keel docs --check --json` | The same, as one JSON object for a script |
| `keel docs` | Build the site into `dist/docs/` |
| `keel docs --serve` | Build, then serve it at http://127.0.0.1:7331 |
| `keel docs --json --out "$(mktemp -d)/site"` | Validation on an older keel, without touching the repository |

`keel docs-gen` is the old name of `keel docs` and still works. keel anchors on
the git root, so it runs from any subdirectory.

## Input

- The source is `docs/` at the repository root (`--docs <dir>` to change it).
- Every `*.md` below it, at any depth, is a page. Names starting with `.` are
  ignored, files and folders alike. Every other file is an attachment, copied
  across as-is — images, PDFs, diagrams.
- Every page must be valid UTF-8.
- `docs/README.md` is required: it is the front page **and** the sidebar.
- Any `README.md` becomes its folder's `index.html`; `x.md` becomes `x.html`.

## Front matter

- Optional. A `---` line on the very first line opens it; a `---` (or `...`)
  line must close it, or the build fails with "opened with --- but never
  closed".
- Only flat `key: value` lines are read, and only three keys matter:

| Key | Used for |
| --- | --- |
| `title` | Page title: the browser tab, the page heading, the breadcrumb |
| `description` | The subtitle under the heading, and the meta description |
| `library` | The label above the title, the badge, and the library name in the version picker |

- Other keys are ignored. An empty value, or a block value (`|`, `>`), counts
  as missing. Matching quotes are stripped: quote a value that contains `: `
  or starts with a special character.
- The title comes from `title`, else from the first `# H1`, else from the file
  name (`getting-started.md` → "Getting started").

## Headings

- **The first `# H1` of every page is removed**, because the page shell prints
  the title as the page's only H1. Put exactly one H1 at the top and make it
  identical to `title`; if they differ, the H1's text is lost.
- `##` and `###` build the "On this page" table of contents. Deeper headings
  render but are not listed.
- Heading ids: lowercase; letters and digits kept (Unicode-aware); every other
  run of characters becomes one `-`; repeats get `-2`, `-3`. So
  "Retry strategies" → `#retry-strategies`, "¿Qué es?" → `#qué-es`.
- GitHub slugs punctuation differently (`C++ & Rust` is `c--rust` there and
  `c-rust` in keel). Keep headings that other pages link to free of
  punctuation, so an anchor works on both.
- `{#custom-id}` after a heading sets its id in keel, but GitHub shows it as
  text — avoid it.

## Markdown that renders

CommonMark plus tables (with column alignment), strikethrough, task lists,
footnotes, block quotes and fenced code.

- A fenced block's first info word becomes its label and `language-*` class:
  ```` ```go ```` is labelled "go". Without one, the card says "code".
- **Raw HTML does not render**: tags and comments are escaped and shown as
  text, unless the build is run with `--allow-html` — which Foundathyon docs
  do not use. Newer keel warns about each fragment (`raw html`). Anything in
  prose that looks like a tag counts: `Vec<u8>` or `<token>` outside backticks
  is HTML to CommonMark, and GitHub drops it entirely. Put it in backticks.
- Math and definition lists are not rendered.

## Sidebar and reading order

- The sidebar is read from `docs/README.md`: links that sit **inside a list
  (bulleted or numbered) or a table** become entries, in the order written.
- `##` and `###` headings in the index start sidebar sections, labelled with
  the heading text. A section with no entries is dropped.
- The entry's label is the link text.
- Prose links in the index do not count — unless the index has no list or
  table links at all, in which case they are used as a fallback.
- A page listed twice appears once, at its first position.
- Links to other sites, or to files that are not pages, are skipped.
- Previous/next links follow: the index, then the sidebar's order, then every
  page the sidebar does not list, alphabetically. Newer keel warns about each
  unlisted page (`unlisted`).

## Links

Relative links resolve from the page's own folder.

| Link | Result |
| --- | --- |
| `other.md`, `guides/install.md`, `../README.md` | Rewritten to the page's `.html`; must exist |
| `guides/`, `guides` | That folder's `README.md`; must exist |
| `name` (no extension) | `name.md`; must exist |
| `img/diagram.png` | An attachment under docs/; must exist |
| `page.md#section`, `page.md?x=1` | The tail is kept as written — the anchor is **not** checked |
| `#section` | Slugified, not checked |
| `https://…`, `http://…`, `mailto:`, `tel:`, `ftp:` | External, opened with `rel="noopener"` |
| `javascript:`, `data:`, `vbscript:`, other schemes | Dropped: the text stays, the link does not |
| `/rooted/path` | Left exactly as written and **not checked** — avoid it |
| `../example_test.go` (leaves docs/) | Newer keel: a link to that file on the repository host, pinned to the documented version. Older keel: broken |

A link that leaves docs/ (newer keel):

- must land on a path git tracks — staged counts, untracked does not;
- goes to `https://github.com/<owner>/<repo>/blob/<ref>/<path>` for a GitHub
  `origin`, or to `--source-url '<pattern with {ref} and {path}>'` for another
  host; `<ref>` is the tag HEAD sits exactly on, else the commit;
- keeps its tail, so `../client.go#L42` opens on line 42;
- may name a folder that holds tracked files (`../cmd/`);
- may not be an image: an image has to ship under docs/.

Any link that cannot be resolved fails the whole build, and **nothing is
written**. With `--json` each broken link has a `reason`:

| `reason` | Meaning | Fix |
| --- | --- | --- |
| `missing` | Inside docs/, nothing there | Fix the path, or write the page |
| `untracked` | Leaves docs/ for a path git does not track | `git add` it, or link elsewhere |
| `no_source_url` | Leaves docs/, but the host is unknown | `--source-url`, or link to a page |
| `image_outside_docs` | An image outside docs/ | Move it under `docs/img/` |
| `outside_repository` | Climbs above the repository root | Fewer `../` |
| `outside_docs` | Leaves docs/ and there is no git repository | Keep it inside docs/ |

## Output

- `dist/docs/` by default (`--out <dir>`), replaced whole on every build; it
  may not sit inside the docs. Keep `dist/` in `.gitignore`.
- Every URL in the site is relative, so it can be served from any prefix.
- The version label and picker come from the repository's version tags
  (`--version`, `--versions`, `--version-url`, `--tag-url`).

## Exit codes and JSON

- `0`: built (or checked). Warnings do not fail unless `--strict`.
- `1`: `no_docs`, `no_index`, `invalid_markdown`, `broken_links`, or
  `warnings` (only with `--strict`). The JSON has `error`, `headline`,
  `message`, `hints`, and the details: `broken_links[]`, `unreadable[]`, or
  `warnings`.
- On success the JSON has `documents`, `sections`, `links`, `source_links`,
  `source_ref`, `written`, `output` and `warnings`
  (`{"unlisted": [...], "raw_html": [{"source", "line", "snippet"}]}`).
