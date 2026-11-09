# The Release workflow

`assets/release.yml` is the Release workflow of fd_http and fd_logging, byte
for byte. Copied into a Go module it needs no change at all. This page says
what each part is for, what the audit requires of it, how to adapt the
`verify` job to another ecosystem, and how to merge the report into a release
workflow a repository already has.

## What each part does

| Part | In the template | Why |
| --- | --- | --- |
| Tag trigger | `on.push.tags: ["v*.*.*"]` | `keel create-version` pushes `v<major>.<minor>.<patch>`; nothing else should start a report |
| Manual run | `workflow_dispatch` with a required `tag` input | Reports a tag made before the workflow existed, or one whose run can no longer be re-run |
| Permissions | `contents: read` | Checking out is all either job does with GitHub's token; the report uses its own credential |
| Concurrency | `group: release-${{ inputs.tag \|\| github.ref }}`, `cancel-in-progress: false` | One run per tag at a time. A second run of the same tag waits instead of racing the first — both would report, and the order would decide the status — and none is cancelled, since a cancelled run reports nothing |
| `verify` | Checks out `${{ inputs.tag \|\| github.ref }}`; for Go, `go build`, `go vet`, `go test -race` | The checks whose result becomes `published` or `failed` |
| `report` | `needs: verify`, `if: ${{ !cancelled() }}`, checkout, then `bash .github/scripts/report-version.sh` | Runs whether `verify` passed or failed — keel must know a tag failed — but not when the run was cancelled, which concluded nothing |

The report step's environment is the contract with the script:

| Variable | Value | Meaning |
| --- | --- | --- |
| `KEEL_API_URL` | `${{ vars.KEEL_API_URL \|\| '<the default>' }}` | keel-api's base URL; a repository or organization variable overrides the template's default |
| `KEEL_CI_TOKEN` | `${{ secrets.KEEL_CI_TOKEN }}` | The repository's CI credential, `klc_…` |
| `KEEL_TAG` | `${{ inputs.tag \|\| github.ref_name }}` | The tag: the manual run's input, else the pushed tag |
| `KEEL_STATUS` | `${{ needs.verify.result == 'success' && 'published' \|\| 'failed' }}` | What keel-api records |
| `KEEL_CHECKS` | `${{ needs.verify.result }}` | `success`, `failure`… as GitHub words it, kept in the report's metadata |

## What the audit requires

`check_setup.py` reads the workflow and fails on each of these:

- `on.push.tags` holds `v*.*.*` (another pattern that matches `v1.4.0` is a
  warning), and nothing starts it without a tag: no branch filters on push, no
  `pull_request`, `pull_request_target`, `schedule` or `merge_group`.
- `workflow_dispatch` has a `tag` input (a warning when it is not required).
- Workflow-level `concurrency` whose group names the tag — `inputs.tag` or
  `github.ref` — and `cancel-in-progress` that is not true.
- A `verify` job with steps. When it checks the repository out, a manual run
  must check out `inputs.tag` (a warning otherwise).
- A `report` job that needs `verify`; runs on `!cancelled()` — not
  `always()`, not unconditionally; checks the repository out at
  `inputs.tag || github.ref` before a step runs
  `.github/scripts/report-version.sh`; and gives that step all five
  variables, with `KEEL_CI_TOKEN` from a secret, `KEEL_STATUS` from
  `needs.verify.result`, and `KEEL_TAG` from `inputs.tag`.
- Once all of that holds, a `report` job that is not the template's, key for
  key, is a `report-drift` warning. The YAML style may differ; the content
  may not.

## Another ecosystem: adapt `verify`, nothing else

The `report` job does not know what it is reporting: it needs a checkout,
bash, curl, jq and git, and `ubuntu-latest` has all of them. So a Rust crate,
a Node package or a Python project gets the same workflow, with only the
steps of `verify` changed:

```yaml
  verify:
    name: verify
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ inputs.tag || github.ref }}

      # From here: the setup and check steps of the repository's own CI
      # workflow, with the action versions it pins.
```

- Take the steps from the workflow that checks pull requests (usually
  `.github/workflows/ci.yml`), or from the repository's canonical commands in
  AGENTS.md or its Makefile (`make check`). Never from memory: the checks that
  gate a release are the ones the repository already trusts.
- Keep what makes them strict — `--locked`, `npm ci`, `-D warnings`, `-race` —
  and leave out what only reports, such as coverage uploads.
- A matrix in CI (three operating systems, several versions) may shrink to one
  entry here when the user agrees: the tag's commit already passed CI on
  `main`. Say which one ran.
- keel-cli is a Rust example: its `ci.yml` runs
  `rustup component add rustfmt clippy`, `cargo fmt --all -- --check` and
  `cargo clippy --all-targets --locked -- -D warnings` in one job, and
  `cargo build --locked --verbose` and `cargo test --locked --verbose` on
  three operating systems in another.
- Keep `name: verify` and the job id `verify`: the report job reads
  `needs.verify.result`.

Say in the report that `verify` was adapted, and what it now runs.

## A release workflow already there

A repository that already builds binaries or publishes a package on a tag —
keel-cli's `release.yml` builds, packs and uploads five targets — keeps its
workflow. Do not add a second one that starts on the same tag: two workflows
would report, or check, the same version separately. Add the keel parts to the
one it has, after showing the user the diff (ground rule 4).

keel, and the audit, look for `.github/workflows/release.yml` (or
`release.yaml`). When the existing workflow lives under another name, such as
`publish.yml`, ask which the user prefers: renaming it to `release.yml`, or a
separate `release.yml` whose `verify` runs the CI checks — in which case
`published` means the checks passed, not that the publishing succeeded.

Then, in that workflow:

1. **Triggers.** Most already start on `v*.*.*` tags and many have a manual
   run with a `tag` input. Add what is missing. If it starts on something
   else — a GitHub release being published, a branch — stop and ask: changing
   what starts it changes what it publishes.
2. **Concurrency.** Add the template's block at workflow level. It only makes
   a second run of the same tag wait, so it cannot break the jobs.
3. **verify.** When the workflow's own jobs are the checks — it builds,
   packages, uploads — `verify` is the job that sums them up, so `published`
   means the release actually went out:

   ```yaml
     verify:
       name: verify
       needs: [create-release, build, checksums]
       if: ${{ !cancelled() }}
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - name: every release job passed
           env:
             RESULTS: ${{ join(needs.*.result, ' ') }}
           run: |
             for result in $RESULTS; do
               if [ "$result" != success ]; then
                 echo "::error::a release job ended $result"
                 exit 1
               fi
             done
   ```

   `needs` lists the jobs that must succeed for the version to count as
   published; a job skipped on purpose does not belong there. When the
   workflow has no checks of its own, `verify` runs the repository's CI
   checks instead, as in the section above; making the existing jobs wait for
   it changes when they publish, so that is the user's call.
4. **report.** The template's `report` job, verbatim — only the `needs` of
   `verify` changes, never the report job itself.
5. **Permissions.** Keep the workflow's own, even when broader than
   `contents: read`: its jobs need them, and the report job needs nothing more.

Run the audit afterwards: `release-*` and `report-*` must be clean, and
`report-drift` must not appear.

## What never changes

- The `report` job, key for key, in every repository.
- `if: ${{ !cancelled() }}` on it — `always()` would report cancelled runs as
  failed, and no condition at all would never report a failed tag.
- `cancel-in-progress: false`.
- `KEEL_CI_TOKEN` read from the secret. A credential written into a workflow
  is readable by everyone who can read the repository: it has to be revoked,
  not just moved.
- The checkout of `${{ inputs.tag || github.ref }}` in both jobs. Without it a
  manual run checks and reports the branch it was started from — another
  commit, so another correlation id, and the CLI's report of the tag is never
  confirmed.
