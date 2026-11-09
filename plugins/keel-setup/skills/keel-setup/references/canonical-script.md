# The canonical report-version.sh

The script the `report` job runs. It is the second witness of a version: it
reports the tag the pipeline just checked, with the repository's CI
credential, and keel-api counts that report as the confirmation. Its one
source is keel-api, at `scripts/ci/report-version.sh`, where
`report_version_test.go` runs it against the real audit endpoints. Every
repository carries a verbatim copy at `.github/scripts/report-version.sh`,
mode 755, and never edits it.

## The copy bundled with this skill

`assets/report-version.sh` is there for when keel-api cannot be reached. It
is this file, as of:

| | |
| --- | --- |
| keel-api commit | `fb3c1fc06143939c669b0f2395c15174711bd706` (2026-09-19) |
| Path | `scripts/ci/report-version.sh`, mode `100755`, git blob `0d3193cfc0b22fcd16052ebdea9d49f1e2ebdd97` |
| SHA-256 | `42242849df73623eb4696c41cd6aa3d1af3b7e2d5cbb424ae6665fa2ac8b8bb8` — also in `assets/report-version.sh.sha256` |
| Size | 275 lines, 11140 bytes |

fd_http and fd_logging carry exactly this copy. Check the bundled one before
using it:

```sh
(cd <skill-dir>/assets && shasum -a 256 -c report-version.sh.sha256)
```

`check_setup.py` does the same on every run, and reports `bundled-corrupt`
when the file no longer matches.

## Prefer keel-api's

keel-api is the source; the bundled copy is only as fresh as this skill.

```sh
canonical="$(mktemp -d)/report-version.sh"
gh api repos/fundathyon/keel-api/contents/scripts/ci/report-version.sh \
  -H "Accept: application/vnd.github.raw" > "$canonical"
shasum -a 256 "$canonical"
```

`gh api` reads keel-api's default branch, `main`. A local checkout works as
well when it is on `main`, has no changes under `scripts/ci/`, and is level
with `origin/main` — `git -C <keel-api> status -sb` says all three.

Then audit against it:

```sh
python3 <skill-dir>/scripts/check_setup.py --canonical "$canonical"
```

When keel-api's script differs from the bundled copy, the audit warns
`bundled-stale`: keel-api has moved on. Install keel-api's, and tell the user
the skill needs refreshing (below).

## Drift

`script-drift` means the repository's copy is not the canonical script. The
message says how:

| It says | Cause | Fix |
| --- | --- | --- |
| Windows line endings (CRLF) | An editor or `core.autocrlf` converted it; bash then fails on `\r` | Copy it again; add `*.sh text eol=lf` to `.gitattributes` |
| Only whitespace differs | A formatter or an editor touched it | Copy it again |
| N lines differ, the first at line L | An older copy, or an edit | Copy it again. An edit the repository needs goes to keel-api instead, as a change every repository then copies |

The JSON finding carries both SHA-256s and the start of a unified diff
(`details.diff`), so the difference can be shown to the user as is.

## What the script needs

- **Tools**: bash, curl, jq and git. `ubuntu-latest` has them; a self-hosted
  runner may not.
- **Environment**: `KEEL_API_URL`, `KEEL_CI_TOKEN` and `KEEL_STATUS` are
  required — the workflow sets them, with `KEEL_TAG` and `KEEL_CHECKS`. The
  rest it reads from GitHub Actions and git. `KEEL_COMMIT`, `KEEL_PACKAGE`,
  `KEEL_ENVIRONMENT`, `KEEL_ATTEMPTS`, `KEEL_RETRY_DELAY` and `KEEL_DRY_RUN`
  are optional; the template sets none of them.
- **A credential**: it refuses anything that does not start with `klc_`.

It retries what time can fix — no answer, `408`, `429`, `5xx` — six times,
waiting 5 seconds and doubling up to a minute, always with the same event,
which keel-api stores once. What time cannot fix — `401`, `403`, `404`,
`409`, `413`, `422` — fails at once, with a `::error::` annotation saying what
to correct. Either way a failed report fails the job, so the run goes red
where somebody looks, and re-running the job reports the version again: a new
report of the same version, never a second version. The credential reaches
curl on its standard input, never on its command line or in the log.

## A dry run

`KEEL_DRY_RUN=1` prints the event instead of sending it — the correlation id,
the commit, the Go module — which shows the script works in this repository.
The credential only has to look like one:

```sh
KEEL_DRY_RUN=1 KEEL_API_URL=https://keel.example.com KEEL_CI_TOKEN=klc_placeholder \
  KEEL_STATUS=published KEEL_TAG=v0.0.0 GITHUB_REPOSITORY=owner/name \
  bash .github/scripts/report-version.sh
```

## Refreshing the bundled copy

For whoever maintains this marketplace, when keel-api changes the script:

1. From the marketplace's root:

   ```sh
   assets=plugins/keel-setup/skills/keel-setup/assets
   gh api repos/fundathyon/keel-api/contents/scripts/ci/report-version.sh \
     -H "Accept: application/vnd.github.raw" > "$assets/report-version.sh"
   chmod 755 "$assets/report-version.sh"
   (cd "$assets" && shasum -a 256 report-version.sh > report-version.sh.sha256)
   ```

2. Update the table at the top of this page: the keel-api commit
   (`gh api 'repos/fundathyon/keel-api/commits?path=scripts/ci/report-version.sh&per_page=1' --jq '.[0].sha'`),
   the blob, the SHA-256 and the size.
3. Bump the skill's patch version in SKILL.md, both plugin manifests and the
   marketplace entry.
4. `python3 scripts/validate.py` and `python3 -m unittest discover tests`: the
   tests check that the script, its `.sha256` and its mode agree.

Repositories wired before the refresh keep their older copy until somebody
copies it again; the audit finds them, as `script-drift`.
