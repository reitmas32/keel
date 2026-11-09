# docs/releases.md

Every keel-wired repository documents its releases in the same page:
`docs/releases.md`, listed in `docs/README.md`. `assets/releases.md` is
fd_http's page with three names taken out. Rendered with fd_http's values it
is fd_http's page byte for byte, and with fd_logging's, fd_logging's.

## Rendering it

| Placeholder | Value | fd_http's |
| --- | --- | --- |
| `{{name}}` | The repository's name — also the page's `library`, so it must be the name every other page of the site carries | `fd_http` |
| `{{repository}}` | origin's `owner/name` | `fundathyon/fd_http` |
| `{{module}}` | The module path in `go.mod` | `github.com/fundathyon/fd_http` |

`check_setup.py --json` prints all three: `facts.origin.name`,
`facts.origin.repository` and `facts.go_module`.

```sh
sed -e 's|{{name}}|fd_auth|g' \
    -e 's|{{repository}}|fundathyon/fd_auth|g' \
    -e 's|{{module}}|github.com/fundathyon/fd_auth|g' \
    <skill-dir>/assets/releases.md > docs/releases.md
grep -n '{{' docs/releases.md   # prints nothing when every placeholder is filled
```

A page copied from another repository and not re-rendered still names that
repository — in `library`, in the `go get` line and in `gh secret set --repo`.
The audit catches both mistakes: `releases-placeholder` and
`releases-other-repository` / `releases-library`.

## What it says

| Section | Content |
| --- | --- |
| Opening | A version is a `v1.4.0` tag on `main`; consumers `go get` it; every version is recorded in keel by two reports |
| Cutting a version | `keel create-version 1.4.0`, what it checks, and that its report is the fast, laptop-bound one |
| What the Release workflow does | `verify`, then `report to keel-api`; the correlation id; the 30-minute confirmation deadline; retries, refusals, and re-running the job |
| Setup | The `KEEL_CI_TOKEN` secret and the `KEEL_API_URL` variable, the `gh secret set` command, expiry and rotation, and why a personal token never goes there |
| Reporting a tag again | The manual run of Release, with a tag |
| Keeping the script current | The copy is keel-api's; update it by copying again, never by editing |

## Outside Go

Two passages describe a Go module. Rewrite them for the repository in the
page's own voice, and keep everything else as rendered:

1. **The opening paragraph** says consumers fetch a version with
   `go get {{module}}@v1.4.0` and that "there is no other artifact to
   publish". Say what a consumer does instead — a crate from crates.io, a
   package from npm, binaries attached to the GitHub release — and what the
   tag sets off. Drop `{{module}}` from the sed command.
2. **"What the Release workflow does", item 1** says verify "builds, vets and
   tests the tagged commit, with the race detector". Say what the `verify`
   job actually runs.

The example version, `1.4.0`, stays: it is only an example.

## Listing it

keel's sidebar is built from the lists and tables in `docs/README.md`: add
the page to the one the other pages are in, in the index's own style.

fd_http, a bulleted list under "Reference and maintenance":

```markdown
- [Releases and version reporting](releases.md) — cutting a version with
  `keel create-version`, and how the Release workflow checks it and records it
  in keel.
```

fd_logging, the next step of a numbered list under "Guides":

```markdown
7. [Releases and version reporting](releases.md) — cut a version with
   `keel create-version`, and see how the Release workflow checks it and
   records it in keel.
```

In an index that uses a table (Step · Guide · Use it for), it is a row.

Two more lines fd_http and fd_logging added, where the repository has the
file they go in:

- The root `README.md`, when it lists the guides:
  `- [Releases and version reporting](docs/releases.md)`.
- `QUALITY.md`, when it has a release checklist:

  ```markdown
  - Tag with `keel create-version`. The Release workflow checks the tagged commit
    and reports the version to keel; a red Release run is a release keel does not
    consider confirmed. See [docs/releases.md](docs/releases.md).
  ```

## Checking it

- `keel docs --check --strict` exits 0: the page's links resolve — including
  `../.github/workflows/release.yml` and `../.github/scripts/report-version.sh`,
  which leave `docs/` and so must be files git tracks (staged counts) — and
  the page is listed.
- With the keel-docs skill installed, its audit applies to this page too.
