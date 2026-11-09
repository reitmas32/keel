# The Foundathyon documentation standard

Every Foundathyon repository documents itself the same way, so a reader who
knows one library knows where to look in the next. `fd_http` and `fd_logging`
are the reference implementations.

## Where documentation lives

| What | Where |
| --- | --- |
| Guides, concepts, reference, architecture | `docs/`, built by `keel docs` |
| What the repository is, how to install, one example, a link into docs/ | `README.md` at the root |
| Instructions for coding agents and maintainers | `AGENTS.md` (plus `.github/copilot-instructions.md` pointing at it) |
| Per-symbol API reference | Doc comments in the code (`go doc`, rustdoc, TSDoc) — summarised in `reference.md`, never copied whole |

Documentation is versioned with the code: it changes in the same pull request
as the behaviour it describes, and a release tag carries the docs for that
release.

## The doc set

Pick the column that matches the repository. Every page is optional except the
index and getting started; add a page only when there is something real to say.

| Page | Library | Service / API | CLI | App |
| --- | --- | --- | --- | --- |
| `README.md` — the index | ✔ | ✔ | ✔ | ✔ |
| `getting-started.md` — install and a first working result | ✔ | ✔ run it locally | ✔ install and first command | ✔ dev setup |
| `configuration.md` — every option, default and precedence | ✔ | ✔ env vars | ✔ flags, env, files | ✔ |
| One page per task or concept | ✔ features | ✔ auth, main flows | ✔ one per command group | ✔ main flows |
| `errors.md` — what fails, how to tell, what to do | ✔ | ✔ status codes, error bodies | ✔ exit codes | — |
| `testing.md` — testing code that uses this, running the suite | ✔ | ✔ | ✔ | ✔ |
| `api.md` — endpoints, auth, versioning (or a link to the OpenAPI) | — | ✔ | — | — |
| `operations.md` — deploy, health, observability, runbooks | — | ✔ | — | ✔ |
| `reference.md` — everything at a glance | ✔ | ✔ | ✔ | — |
| `architecture.md` — boundaries and invariants, for maintainers | ✔ | ✔ | ✔ | ✔ |
| `troubleshooting.md` — symptom → cause → fix | when real | when real | when real | when real |

- File names are kebab-case: `retry-strategies.md`, not `RetryStrategies.md`.
- Stay flat. Add a folder only past ~12 pages, and give it a `README.md` so
  `guides/` resolves.
- Name task pages after the task (`post-put-and-bodies.md`), concept pages
  after the concept (`correlation.md`).

## The index: docs/README.md

The index is the front page and the sidebar. Its shape is fixed:

1. Front matter with `title: <library> documentation`.
2. `# <library> documentation`, then two to four sentences: what it is, who
   uses it, where it fits in Foundathyon.
3. `## Guides` — the reading order, as a table (Step · Guide · Use it for) or
   a numbered list. Getting started is always step 1.
4. `## Reference` — reference, errors, configuration reference.
5. `## Maintainers` — architecture, and links to `../AGENTS.md` and
   `../QUALITY.md` or `../CONTRIBUTING.md` when the repository has them.

Every page in docs/ appears in exactly one of those lists. Each entry adds a
few words on what the page is for.

## Every page

- Front matter with `title`, `description` and `library`:
  - `title`: sentence case, short, names the task or concept.
  - `description`: one sentence, under ~140 characters, ending with a period —
    what the reader can do after reading.
  - `library`: the repository or module name, identical on every page
    (`fd_http`, not "HTTP client").
- `# H1` identical to the title, then one to three sentences on when you need
  this page.
- Tutorials number their sections: `## 1. Install the private module`.
- Close with `## See also` only when there are genuinely related pages.

## Writing

- Address the reader as "you"; present tense; active voice.
- Lead with the task, then the explanation. One idea per paragraph.
- State ownership and lifecycle rules explicitly: who closes the body, who owns
  the context, what is safe to reuse, what is safe to retry.
- Name the real thing: `Config.Timeout`, `KEEL_API_URL`, `make check` — in
  backticks, exactly as spelled in the code.
- Show, then explain: a complete snippet, then what it does and why.
- Snippets are complete enough to paste and compile: imports when they are not
  obvious, error handling, no `...` in the middle of logic.
- Prefer tables for options, comparisons and mappings (status → error type).
- Keep secrets out: example tokens look fake (`example-token`), hosts use
  `.internal`, `example.com` or `localhost`.
- Private modules: say how to fetch them (for Go, `GOPRIVATE` and the git
  `insteadOf` rule).
- Callouts are block quotes: `> **Note:** …`, `> **Warning:** …`.
- No raw HTML, no HTML comments, no emoji in headings.

## Keeping it true

- Link to the executable example that backs a snippet
  (`[example_test.go](../example_test.go)`), and run it before finishing.
- When behaviour changes, update the page, the index entry and `reference.md`
  together.
- Say what is not supported as plainly as what is.
