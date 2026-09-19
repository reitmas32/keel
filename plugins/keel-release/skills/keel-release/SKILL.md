---
name: keel-release
description: Cut a release of a repository with keel — choose the next semantic version from the commits since the last tag, bump the version files `.keel` lists, pass the repository's checks and `keel docs --check --strict`, then tag and push with `keel create-version`, asking before anything leaves the machine. Use when asked to release, publish, ship, tag or version a library, service or CLI; to decide what the next version number should be; to prepare a release commit; or when `keel create-version` refuses to tag. Also use in any repository with a .keel file when the user talks about a new version.
metadata:
  version: "0.1.0"
  owner: fundathyon
---

# keel release

Turn "release this" into a tag GitHub has seen, with nothing forgotten: the
right version, version files that agree with it, checks and docs that pass at
that very commit, and a person saying yes before anything is pushed.

`<skill-dir>` below is the folder that contains this SKILL.md.

## Ground rules

1. **Ask before anything leaves the machine.** `git push` and
   `keel create-version` without `--dry-run` publish. A pushed tag starts the
   release workflow, and a Go module version becomes fetchable by anyone who
   depends on it. Show exactly what will be pushed and wait for an explicit yes.
2. **Never move, delete or re-push a published tag.** A broken release is
   fixed by the next patch. keel's own hint to delete a tag is for a person who
   knows it was a mistake — surface it, do not run it.
3. **The version is proposed, never decided alone.** Show the commits and the
   reasoning; the user picks.
4. **Stop at the first failing check** and report it. Making the code pass is
   a different task, which the user has to ask for.
5. **The repository's own release rules win.** A release script, a Makefile
   `release` target, or a checklist in AGENTS.md, QUALITY.md, CONTRIBUTING or
   docs/ comes first; use this workflow for whatever they do not cover.

## Workflow

### 1. Plan — read-only

Run the planner from anywhere inside the repository:

```sh
python3 <skill-dir>/scripts/release_plan.py --fetch
```

It reports the last release (the highest `vMAJOR.MINOR.PATCH` tag, as
`keel last-version` reads it), the commits since, a proposed version, the
version files `.keel` lists and what each says, the branch state, whether a
release workflow or a Go module is involved — and every problem it found.
`--json` gives the same as one object.

Then read the repository's release rules (ground rule 5).

Resolve every problem before going on:

| Problem | Do |
| --- | --- |
| Uncommitted changes | Ask: commit them, stash them, or stop. Never release work that is not committed |
| Not on the release branch, or detached | Ask before switching branches |
| Behind the upstream | Ask, then `git pull --ff-only` |
| No `.keel` | Suggest `keel init` (it detects the version files), review it, commit it |
| A version file disagrees with the last tag | Find out why before going on — somebody bumped without tagging, or the other way round |
| A Go module going to v2 or later | Stop: the module path must end in `/v2`, and every import changes. That is its own change, not part of a release |

### 2. Choose the version

The planner's proposal follows these rules. Check them against the commits
yourself — especially for breaking changes a commit message did not announce:

| The commits since the last tag contain | From 1.0.0 | Before 1.0.0 |
| --- | --- | --- |
| A breaking change: `!` after the type, or a `BREAKING CHANGE:` footer | major | minor |
| `feat` | minor | patch |
| `fix` or `perf` | patch | patch |
| Only `docs`, `test`, `ci`, `chore`, `refactor`, `style`, `build` | patch, if releasing at all | patch, if releasing at all |

- Before 1.0.0 the minor carries breaking changes and features ship as
  patches — the convention keel-cli itself follows.
- Look past the prefixes. A removed or renamed exported symbol, flag,
  environment variable, endpoint or config field is breaking whatever the
  commit says: `git diff <last tag>..HEAD` over the public surface when in
  doubt.
- **First release** (no version tag): the version the version files already
  carry, or `0.1.0` — `1.0.0` only when the user declares the API stable.
- Nothing since the last tag: there is nothing to release. Say so and stop.

Present the last version, the commits grouped by kind, any breaking change,
and the proposed version with its reason. Wait for the user to confirm it or
choose another.

### 3. Prepare the release commit

- Set the new version in every file `release.version_files` lists, and
  refresh its lockfile: [references/version-files.md](references/version-files.md)
  has the exact edit and command per ecosystem. A Go module has none: the tag
  is the version.
- A `CHANGELOG.md` gets an entry in its existing format. Do not start one the
  repository does not have: release notes come from the tag (keel-cli's
  workflow runs `gh release create --generate-notes`).
- Re-run the planner: every version file must now show the new version.
- Commit only those files: `git commit -m "chore(release): v<version>"`.
  Nothing to bump and no changelog means no commit — the tag goes on HEAD.

### 4. Gates — at the commit that will be tagged

1. The repository's own checks: the canonical commands in AGENTS.md, or
   `make check`, `cargo test`, `go test ./...`, `npm test`.
2. `keel docs --check --strict`, when there is a docs/ — the docs travel with
   the tag. If `keel docs --help` does not list `--check`, use
   `keel docs --json --out "$(mktemp -d)/site"` instead.
3. `keel create-version <version> --dry-run`. It runs every check the real run
   will — GitHub remote, upstream, commits pushed, clean tree, tag free — and
   changes nothing. With a release commit not yet pushed it reports `synced`
   as failing (`not_synced` in `--json`): that is the next step, not an error.

Any other failure: stop, report it, ask.

### 5. Publish — only after an explicit yes

Show the plan first: the commit to push to `<remote>/<branch>`, the tag
`v<version>`, and what it sets off — the release workflow if the planner found
one, the module version for Go. Then, with the user's yes:

1. Push the release commit, if there is one: `git push <remote> <branch>`. If
   the branch is protected
   (`gh api repos/<owner>/<repo>/branches/<branch> --jq .protected` says
   `true`), open a pull request instead, and tag its merge commit once merged.
2. `keel create-version <version>` — an annotated `v<version>` tag on HEAD,
   pushed. Do not add `-y`: a dirty tree at this point is a mistake to look
   at, not a question to skip.

### 6. Verify and report

- `keel list-version --remote` marks the tag as pushed.
- A release workflow: `gh run list --workflow release.yml --limit 1`, then
  `gh run watch <id>` — report how it ended.
- A Go module: a consumer can fetch it. Run it outside the repository — Go
  will not look up a version of the module it is standing in:
  `(cd "$(mktemp -d)" && GOPRIVATE=github.com/fundathyon/* go list -m github.com/<owner>/<repo>@v<version>)`.
- Report the version, the release URL `keel create-version` printed, the files
  bumped, the gates that ran, and what consumers do next (for example
  `go get github.com/<owner>/<repo>@v<version>`).

## When `keel create-version` says no

With `--json`, the `error` field names the case.

| `error` | Meaning | Do |
| --- | --- | --- |
| `invalid_version` (exit 2) | Not `MAJOR.MINOR.PATCH` | `1.4.0`; a leading `v` is accepted |
| `remote_not_github`, `no_remote` | keel releases to GitHub only | Tell the user; nothing to fix here |
| `detached_head` | Not on a branch | Check out the release branch — ask first |
| `no_upstream` | The branch tracks nothing | `git push -u <remote> <branch>` — ask first |
| `not_synced` | HEAD has commits the remote has not seen | Step 5.1 — ask first. Behind as well: stop |
| `fetch_failed` | The remote could not be reached | Check network and credentials, retry |
| `tag_exists` | That version is taken | Choose the next version; never delete the tag |
| `declined` (exit 130) | The dirty-tree question was answered no | Nothing changed: commit or stash, rerun |
| `push_failed` | Tagged locally, the push failed | Report it; `git push <remote> v<version>` retries once the cause is fixed |
