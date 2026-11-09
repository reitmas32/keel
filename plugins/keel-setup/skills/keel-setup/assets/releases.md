---
title: Releases and version reporting
description: How a version of {{name}} is tagged, checked and recorded in keel.
library: {{name}}
---

# Releases and version reporting

A version of `{{name}}` is a semantic-version tag, such as `v1.4.0`, on a
commit of `main`. Consumers fetch it with
`go get {{module}}@v1.4.0`; there is no other artifact to
publish. Every version is also recorded in keel, the organization's register
of releases, by two independent reports.

## Cutting a version

From an up-to-date `main`:

```sh
keel create-version 1.4.0
```

`keel create-version` checks the repository — on a branch, in sync with the
remote, the tag unused — creates and pushes the tag, and reports the version
to keel-api at once. That first report is fast, but it comes from a laptop: when
keel-api cannot be reached, keel keeps the report and sends it later, and the
release goes ahead regardless.

## What the Release workflow does

Pushing the tag starts [`release.yml`](../.github/workflows/release.yml):

1. **verify** builds, vets and tests the tagged commit, with the race detector.
2. **report to keel-api** runs
   [`report-version.sh`](../.github/scripts/report-version.sh), which reports
   the same version with this repository's CI credential: `published` when
   verify passed, `failed` when it did not.

Both reports carry the same correlation id — a hash of repository, package,
version and commit — so keel-api joins them into one record of the version.
The workflow's report is the confirmation. A version the CLI reported and the
workflow did not confirm within the configured time (30 minutes by default)
is shown in keel's admin as **pending confirmation**.

The report is retried when keel-api is unreachable or answers with a
temporary error: six tries, over two to five minutes, always with the same
event, which keel-api stores once. A refusal — a wrong or revoked credential,
a malformed event — is not retried, because it would only be refused again.
When the report fails, the job fails: re-run it from the Actions tab. Each run
is recorded as another report of the same version, never as a second version.

## Setup

| Where | Name | Value |
| --- | --- | --- |
| Repository secret | `KEEL_CI_TOKEN` | A CI credential for `{{repository}}`, which starts with `klc_`. A keel administrator creates it in the admin, under **CI credentials**; it is shown once. |
| Repository or organization variable (optional) | `KEEL_API_URL` | keel-api's address. Without it the workflow uses `https://keel.foundathyon.dev`. |

```sh
gh secret set KEEL_CI_TOKEN --repo {{repository}}
```

The credential can report this repository's versions and nothing else, and it
expires after a year: the admin shows when. Rotate it by creating a new one,
replacing the secret, and revoking the old one.

Never put a personal keel token here. It would report as that person, stop
working with their session, and could not confirm the version anyway: keel-api
only counts a report as the CI's when the repository's CI credential sent it.

## Reporting a tag again

In the Actions tab, run **Release** with the tag, such as `v1.4.0`. It checks
the tagged commit again and reports it. Use it for a tag made before this
workflow existed, or for one whose run can no longer be re-run.

## Keeping the script current

`report-version.sh` is a copy of `scripts/ci/report-version.sh` in keel-api,
where it is tested against the API. Update it by copying that file again, not
by editing this copy.
