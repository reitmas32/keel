---
name: keel-setup
description: Prepare a repository for keel's release pipeline, or audit one that has it — `.keel` from `keel init`, a Release workflow whose report job confirms every tagged version to keel-api, keel-api's canonical `report-version.sh`, `docs/releases.md`, `dist/` git-ignored, and the `KEEL_CI_TOKEN` CI credential, the wiring fd_http and fd_logging carry. Use when asked to make a repository, library or service keel-compatible or keel-ready; to wire a new fd_* library for keel releases; to add or fix the Release workflow, report-version.sh or the CI credential; when a Release run fails to report or keel-api shows versions as pending confirmation; or when a repository about to be released has no `.keel` or Release workflow. Also use to check that an existing setup has not drifted from the canonical files.
metadata:
  version: "0.1.0"
  owner: fundathyon
---

# keel setup

Give a repository the wiring keel's release pipeline expects — the same files
fd_http and fd_logging carry — or check that it still has it. The setup is
done when `check_setup.py --strict` passes with the new files staged, and
the `KEEL_CI_TOKEN` secret exists: the script checks the first, and
`gh secret list` the second.

`<skill-dir>` below is the folder that contains this SKILL.md.

## What keel needs from a repository

Every version keel releases has two witnesses. `keel create-version` reports
it the moment the tag exists, from the machine that made it: fast, but only a
laptop. The repository's Release workflow reports it again once it has
checked the tagged commit, with the repository's own CI credential — and that
report is the one that confirms it. keel-api joins the two by a correlation
id (repository, package, version, commit). A version the CLI reported and no
pipeline confirmed within the deadline shows in keel's admin as **pending
confirmation**. This is the repository's half:

| What | Where | From |
| --- | --- | --- |
| Project settings: the GitHub repository, the release remote, branch and tag prefix, the version files | `.keel` | `keel init` |
| `verify` checks the tagged commit; `report` tells keel-api `published` or `failed` | `.github/workflows/release.yml` | [assets/release.yml](assets/release.yml) |
| The CI reporter, mode 755, never edited | `.github/scripts/report-version.sh` | keel-api's `scripts/ci/report-version.sh`, verbatim |
| How a version is cut, checked and recorded | `docs/releases.md`, listed in `docs/README.md` | [assets/releases.md](assets/releases.md) |
| The site `keel docs` builds stays out of git | `dist/` in `.gitignore` | — |
| The repository's CI credential, `klc_…` | Repository secret `KEEL_CI_TOKEN` | A keel admin creates it; the user stores it |

## Ground rules

1. **Never push, tag or create a version.** Setting up ends with staged files
   in the working tree. `git push`, `git tag`, `keel create-version` — even to try
   the workflow — and `gh workflow run release.yml`, which reports a version
   to keel-api, are releasing: that is `keel-release`'s job, with the user's
   yes.
2. **Never weaken an existing workflow.** Add to it. Never remove a job, a
   check, a trigger or a permission it relies on, and never relax a check to
   make something pass. The `verify` job is at least as strict as the
   repository's CI.
3. **The repository's own rules win.** AGENTS.md, CONTRIBUTING, QUALITY.md,
   CODEOWNERS or a release checklist come first; where they disagree with this
   workflow, follow them and say so.
4. **Ask before changing the CI of an existing repository.** When `.github/`
   already holds workflows, show exactly what will be added or changed — the
   new files, and the diff of any existing one — and wait for a yes.
5. **Tokens never pass through you.** Never print, echo, log, store or commit a
   credential, and never put one on a command line. `gh secret set` runs only
   after the user says so, and only where gh can ask the user for the value
   itself (step 7). A token pasted into the conversation is exposed: say so,
   and recommend revoking it.
6. **Verbatim means verbatim.** `report-version.sh` and the `report` job are
   the same in every repository. A change either of them needs belongs in
   keel-api or in this marketplace, never in one copy.
7. **Commit only when the user says so.** Stage what you added, propose the
   commit, and leave it at that until the user says yes.

## Workflow

### 1. Preflight — read-only

- **keel**: `keel --version`. 0.3.9 or newer has everything used here:
  `keel init` writing a YAML `.keel` (0.3.1), `keel docs --check` (0.3.7),
  `keel hooks` (0.3.9). An older one: suggest `keel update`. None: say so —
  the user installs it, keel-cli's README has the command — and go on with
  the steps that do not run keel.
- **Repository**: `git rev-parse --show-toplevel`. Not a repository: stop and
  ask, `git init` is the user's call. Whether it has a commit yet —
  `git rev-parse --verify -q HEAD` — matters in step 3.
- **origin**: `git remote get-url origin` must be GitHub
  (`git@github.com:owner/name.git`, `https://github.com/owner/name`). None:
  the user creates the repository on GitHub and adds it. Another host: stop —
  keel tags for GitHub only, and the Release workflow is a GitHub Actions one.
- **Kind**: `go.mod` at the root is a Go module, the case every template here
  is written for. `Cargo.toml`, `package.json`, `pyproject.toml` or
  `composer.json` is another ecosystem: the same files, with only the steps of
  the `verify` job adapted to the repository's own checks — say so in the
  report. keel versions a repository as one package, named after it.
- **Rules**: read AGENTS.md, CLAUDE.md, CONTRIBUTING, QUALITY.md, `.github/`
  (every workflow, CODEOWNERS) and `docs/README.md`.
- **The canonical script**: fetch keel-api's, so everything below compares
  against the real thing rather than the copy bundled here:

  ```sh
  canonical="$(mktemp -d)/report-version.sh"
  gh api repos/fundathyon/keel-api/contents/scripts/ci/report-version.sh \
    -H "Accept: application/vnd.github.raw" > "$canonical"
  ```

  A keel-api checkout the user points you to does too, when it is on `main`,
  clean, and level with `origin/main`. When neither is reachable, use the
  bundled copy, `<skill-dir>/assets/report-version.sh`, and drop
  `--canonical` below — [references/canonical-script.md](references/canonical-script.md)
  says where it came from.
- **Starting state**:

  ```sh
  python3 <skill-dir>/scripts/check_setup.py --canonical "$canonical"
  ```

  It prints what it found — origin, kind, Go module, each file — and every
  gap, and changes nothing. Pass the repository's path when you are not
  inside it; `--json` gives the same as one object. The facts it prints
  (`origin`, `go_module`) are the values steps 3–7 need.

### 2. Decide the job

| Situation | Job |
| --- | --- |
| None of the table above | Set it up: steps 3–8 |
| Part of it — a workflow but no `.keel`, no `dist/` rule | Fill only the gaps the audit lists; leave what passes alone |
| A release workflow that is not keel's: it builds binaries, publishes a package | Merge into it, after the user agrees — [references/release-workflow.md](references/release-workflow.md) |
| Asked for a review or an audit | Step 8, then report; change nothing unless asked |
| The audit is clean | Nothing to set up: confirm the secret (step 7) and report |

### 3. `.keel` — through `keel init`

1. `keel init --dry-run` prints the file without writing it. Check it:
   - `project.repository` is origin's `owner/name`.
   - `release.branch` is the branch releases are cut from —
     `git symbolic-ref --short refs/remotes/origin/HEAD` names the default
     one. keel init records **whichever branch it runs on**, so on a feature
     branch it writes that branch: correct it to the release branch.
   - `release.version_files`: `[]` for a Go module, whose tag is its version.
     Elsewhere, the files that carry the release version — `Cargo.toml`,
     `package.json`, `pyproject.toml`. A file that does not, such as a
     `package.json` holding only tooling in a Go repository, does not belong:
     keel-release would bump it at every release. Ask before dropping one.
   - `release.tag_prefix: v` — keel always tags `v<version>`.
2. `keel init` writes it. When a `.keel` is already there, compare it with the
   dry run: fix what is wrong by hand, keeping the shape keel writes, or
   `keel init --force` with the user's yes — it overwrites.
3. **A repository with no commit yet.** keel init reads HEAD, so there it
   fails — the dry run too — with
   `keel: git rev-parse --abbrev-ref HEAD failed`. Do not make the first
   commit for the user. Tell them, then either wait for it or do steps 4–6
   first and come back. If they ask you to make it, show what it will hold
   first.

### 4. The Release workflow

- **No release workflow**: copy the template.

  ```sh
  mkdir -p .github/workflows
  cp <skill-dir>/assets/release.yml .github/workflows/release.yml
  ```

  For a Go module it stays byte for byte what fd_http and fd_logging run.
  For another ecosystem, replace **only the steps of the `verify` job** with
  the repository's own checks — the ones its CI runs, with the versions it
  pins — keeping the checkout of `ref: ${{ inputs.tag || github.ref }}`.
  Triggers, permissions, concurrency and the `report` job stay exactly as
  they are. [references/release-workflow.md](references/release-workflow.md)
  explains every part and shows the adaptation.
- **A release workflow already there**: do not replace it. Add what the audit
  says is missing — the `v*.*.*` tag trigger, `workflow_dispatch` with a
  `tag` input, per-tag concurrency that cancels nothing, a `verify` job, the
  `report` job verbatim — as the merge section of
  [references/release-workflow.md](references/release-workflow.md) shows.
  Ground rule 4 applies. A `release.yaml` counts too: keep its name.

### 5. `report-version.sh`

- Copy keel-api's canonical script, verbatim and executable:

  ```sh
  mkdir -p .github/scripts
  cp "$canonical" .github/scripts/report-version.sh
  chmod 755 .github/scripts/report-version.sh
  ```

  Without keel-api, check the bundled copy against its recorded SHA-256 —
  `(cd <skill-dir>/assets && shasum -a 256 -c report-version.sh.sha256)` —
  then copy `<skill-dir>/assets/report-version.sh`, and say in the report
  that the copy came from the skill.
- Git has to keep the bit: once the file is added,
  `git ls-files -s .github/scripts/report-version.sh` shows `100755`. If it
  shows `100644` (Windows, or `core.fileMode=false`):
  `git update-index --chmod=+x .github/scripts/report-version.sh`.
- Never edit the copy. When the audit reports `script-drift`, replace it with
  the canonical one; if the repository changed it on purpose, the change
  belongs in keel-api.
- Optional: see the event it would send, sending nothing. The credential is a
  placeholder the script accepts for a dry run — never a real one:

  ```sh
  KEEL_DRY_RUN=1 KEEL_API_URL=https://keel.example.com KEEL_CI_TOKEN=klc_placeholder \
    KEEL_STATUS=published KEEL_TAG=v0.0.0 GITHUB_REPOSITORY=owner/name \
    bash .github/scripts/report-version.sh
  ```

  It needs bash, curl, jq and git, as the runner has them.

### 6. `docs/releases.md` and `dist/`

- With a `docs/` — every Foundathyon library has one — render the page with
  the repository's name, its `owner/name`, and its Go module path:

  ```sh
  sed -e 's|{{name}}|fd_auth|g' \
      -e 's|{{repository}}|fundathyon/fd_auth|g' \
      -e 's|{{module}}|github.com/fundathyon/fd_auth|g' \
      <skill-dir>/assets/releases.md > docs/releases.md
  ```

  With fd_http's values it gives fd_http's page byte for byte. `{{name}}` is
  also the page's `library`, so it must be the name the other pages carry.
  Outside Go, rewrite the two Go-specific passages
  [references/releases-page.md](references/releases-page.md) points out.
- List it in `docs/README.md`, in the list or table the other pages are in,
  in the index's own style — fd_http's entry is
  `- [Releases and version reporting](releases.md) — cutting a version with …`.
  Where the root README lists the guides, or QUALITY.md has a release
  checklist, fd_http and fd_logging added a line there too.
- No `docs/`: skip the page and say so in the report. The keel-docs skill
  starts a `docs/` when the user wants one.
- `dist/`: when `git check-ignore -q dist/docs/index.html` fails, add a
  `dist/` line to `.gitignore`, beside its build-output lines if it has any.
- Stage what this setup added or changed — `git add` those paths, nothing
  else. Staging is not committing, and it is what keel needs: the page links
  `../.github/workflows/release.yml` and `../.github/scripts/report-version.sh`,
  and `keel docs` only accepts a link that leaves `docs/` when git tracks its
  target.
- `keel docs --check --strict` must pass; on a keel without `--check`,
  `keel docs --json --out "$(mktemp -d)/site"`.

### 7. The CI credential

Without it the first tag's report fails — `KEEL_CI_TOKEN is not set` — and
the version waits as pending confirmation. The user acts here; explain, with
[references/ci-credential.md](references/ci-credential.md) for detail:

- A keel admin creates a CI credential for `owner/name` in keel's admin,
  under **CI credentials**. It starts with `klc_`, is shown **once**, reports
  that repository's versions and nothing else, and expires after a year.
- It is stored as the repository secret `KEEL_CI_TOKEN`:

  ```sh
  gh secret set KEEL_CI_TOKEN --repo owner/name
  ```

  gh prompts for the value and hides it. Ask before running this, and run it
  only in a terminal where the user can answer that prompt: where your
  commands have no terminal, gh reads the value from standard input instead,
  and there is no way to give it one without the token passing through you —
  hand the user the command. Never `--body`, `echo`, a file, or a variable
  you set.
- `KEEL_API_URL` — a repository or organization **variable**, not a secret —
  only when keel-api is not at the address the workflow defaults to.
- Confirm without reading anything secret:
  `gh secret list --repo owner/name` lists `KEEL_CI_TOKEN` by name and date.
- A personal keel token (`klt_…`) never goes there: the script refuses it,
  and keel-api would not count it as the CI's anyway.

### 8. Validate — loop until clean

1. `python3 <skill-dir>/scripts/check_setup.py --canonical "$canonical" --strict`
   exits 0 once everything is staged and clean. A warning the user chose to
   keep — releases cut from a branch that is not the default one, say — fails
   `--strict`: then run without it, which must exit 0, and name the warning
   in the report.
2. `keel docs --check --strict`, when there is a `docs/`.
3. `keel init --dry-run` agrees with `.keel` on repository, remote, branch
   and version files — save a branch you corrected in step 3 — so keel reads
   the repository the way the file says.
4. `keel hooks status` (keel 0.3.9 or newer): the `version.created` hook, the
   keel-api this machine is signed in to, and anything queued. Signed out,
   the CLI's report of the next version waits in the queue — `keel login` is
   the user's to run.
5. For a Go module:
   `cmp <skill-dir>/assets/release.yml .github/workflows/release.yml`.

Repeat until they pass. Do not weaken a check to make it pass.

### 9. Report

- The files created or changed, one line each, and where each came from —
  keel-api's script at which commit, or the bundled copy.
- The kind of repository and, outside Go, what the `verify` job runs; the
  `report` job is unchanged.
- Evidence: the final line of the audit and of `keel docs --check --strict`,
  and what `keel init --dry-run` and `keel hooks status` said.
- What is left for the user: the CI credential and `gh secret set`; the
  commit — propose one, such as
  `ci: report every release to keel-api from a Release workflow`; and the
  next version, through `keel-release`.
- Open questions: anything you could not verify.

## When the audit says no

Every finding carries a code; with `--json`, `findings[].code`.

| Code | Means | Do |
| --- | --- | --- |
| `no-origin`, `origin-not-github` | No GitHub remote named origin | Ask: keel releases GitHub repositories only |
| `keel-missing` | No `.keel` | Step 3 — with no commit yet, the user's first commit comes first |
| `keel-unparseable`, `keel-shape` | Not the file `keel init` writes | Compare with `keel init --dry-run`; fix it, or `--force` with a yes |
| `keel-repository`, `keel-name`, `keel-remote` | `.keel` disagrees with origin | Correct `.keel` to match origin, not the other way round |
| `keel-branch` (warning) | Not origin's default branch | keel init ran on another branch: set the release branch |
| `keel-tag-prefix` | The prefix is not `v` | `tag_prefix: v` |
| `keel-version-file` | A listed file is missing, or a Go module lists one | Step 3's review |
| `release-missing` | No Release workflow | Step 4 |
| `release-unparseable` | YAML the audit cannot read | Fix the line it names — GitHub would reject it too |
| `release-trigger`, `release-dispatch`, `release-concurrency` | It starts without a tag, cannot report an existing tag, or lets two runs of a tag race | Take those parts from the template |
| `release-verify` | No verify job, an empty one, or one checking the branch | Step 4 |
| `report-job`, `report-needs`, `report-if`, `report-run`, `report-checkout`, `report-env` | The report job cannot report correctly | Copy the report job from the template, unchanged |
| `report-secret` | A credential written into the workflow | Tell the user to revoke it now; read it from `secrets.KEEL_CI_TOKEN` |
| `report-drift` (warning) | It works, but it is not the canonical report job | Copy it again from the template |
| `script-missing`, `script-drift` | Missing, or not keel-api's script | Step 5 |
| `script-not-executable` | Not 755 on disk, or 100644 in git | `chmod 755`; `git update-index --chmod=+x` |
| `bundled-stale` (warning) | keel-api's script moved on from the copy in this skill | Use keel-api's; tell the user the skill needs refreshing |
| `bundled-corrupt` | The skill's copy was edited | Reinstall the skill, or pass `--canonical` |
| `releases-missing`, `releases-unlisted`, `releases-prose-link` | The page is missing, or the sidebar cannot reach it | Step 6 |
| `releases-placeholder`, `releases-other-repository`, `releases-library` | A template left unrendered, or copied from another library | Render it again with this repository's values |
| `dist-not-ignored` | `keel docs` output would be committed | `dist/` in `.gitignore` |
| `no-ci` (warning) | Nothing checks pull requests | Offer a CI workflow — fd_http's `ci.yml` for a Go library — with a yes; it is not part of this setup |
| `untracked` (warning) | Git does not track it yet | `git add` it — staged counts |
