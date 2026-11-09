# The CI credential

The Release workflow's report counts as the CI's only because of the
credential it is sent with: a CI credential issued for that one repository,
stored as its `KEEL_CI_TOKEN` secret. This page is what to tell the user, who
is the one to act on it.

## Two witnesses, one record

| Witness | Sends | With | Reports |
| --- | --- | --- | --- |
| The CLI | `keel create-version`, the moment the tag exists | The person's `keel login` token, `klt_…` | `pending` (the tag is pushed) or `unpublished` (it stayed local) |
| The CI | The Release workflow's `report` job, once `verify` has run | The repository's CI credential, `klc_…` | `published` (verify passed) or `failed` |

Both reports carry the same correlation id — the SHA-256 of repository,
package, version and commit — and keel-api folds them into one record of the
version, whichever arrives first and however often. The CI's report is the
confirmation:

| Confirmation | When |
| --- | --- |
| `confirmed` | The CI reported the version |
| `awaiting_ci` | The CLI reported it, the repository has a CI credential, and the deadline has not passed |
| `pending_confirmation` | The CLI reported it and the CI did not within the deadline — 30 minutes from the tag by default. Somebody should look |
| `not_expected` | The CLI reported it, and the repository had no valid CI credential then: there was nothing to wait for |

keel-api expects a CI report only from a repository that has a valid CI
credential when the CLI reports. So the order matters: merge the workflow and
the script, store the secret, then cut the next version. A credential issued
long before the workflow reaches `main` turns every version in between into
`pending_confirmation`.

## Creating it

A keel administrator does, in keel's admin under **CI credentials**: the
repository `owner/name`, and a name such as "GitHub Actions".

- It looks like `klc_<id>_<secret>`. keel-api keeps only a hash of the
  secret, so it is shown **once**, with a `gh secret set` command ready to
  copy, and never again. A lost one is revoked and replaced.
- It reports that repository's versions and nothing else: sent from another
  repository, keel-api answers `403 audit.record.repository_not_allowed`. That
  is why it is a repository secret, never an organization one shared by many.
- It expires after a year (keel-api's `CI_TOKEN_TTL_SECONDS`). The admin shows
  when, and marks the ones expiring within 30 days.
- To rotate: create a new one, replace the secret, revoke the old one. A
  revoked credential is refused from its next report on.

## Storing it

```sh
gh secret set KEEL_CI_TOKEN --repo owner/name
```

- gh prompts for the value and does not echo it; it is encrypted on the
  machine before it is sent. That prompt is the only way the value should
  travel: not `--body` (the process list, shell history), not `echo … |`
  (history), not a file (disk), not an environment variable in a shell the
  agent drives, and not the conversation.
- Where a command runs without a terminal, gh does not prompt: it reads the
  value from standard input, which nobody can fill without the token passing
  through them. So an agent runs this only after the user says so, and only in
  a terminal the user can type into; otherwise it gives the user the command.
- Setting a secret needs admin rights on the repository.

To check it is there, without reading it — nobody can:

```sh
gh secret list --repo owner/name
```

## KEEL_API_URL

The workflow reports to `vars.KEEL_API_URL`, or to the address written in the
template when that is unset. It is a variable, not a secret — an address, not
a credential — and it is only needed when keel-api lives elsewhere:

```sh
gh variable set KEEL_API_URL --repo owner/name --body https://keel.example.com
gh variable set KEEL_API_URL --org <organization> --body https://keel.example.com
```

An organization variable serves every repository at once. Ask before setting
either: it changes where every future report goes.

## When the report fails

The job fails with a `::error::` annotation that says which of these it is:

| The job says | Cause | Fix |
| --- | --- | --- |
| `KEEL_CI_TOKEN is not set` | No Actions secret by that name — an environment or a Dependabot secret does not reach this job | Store it as above |
| `KEEL_CI_TOKEN is not a CI credential` | A personal `klt_` token, or anything else | Ask an admin for a CI credential |
| `keel-api refused the CI credential (401 …)` | Mistyped, revoked or expired | A new credential, then `gh secret set` again |
| `403 … audit.record.repository_not_allowed` | The credential of another repository | The credential for this one |
| `answered 404` | `KEEL_API_URL` points at the wrong place, or at a keel-api too old for CI reports | Fix the variable |
| `gave up after 6 attempts` | keel-api unreachable or unwell the whole time | Re-run the job once it is back |
| `KEEL_STATUS must be published or failed` or `there is no tag to report` | The report job's environment was changed | Copy the report job from the template again |

Re-running the job, or running Release by hand with the tag, reports the
version again. That sends a report to keel-api, so it is the user's to start.

## The CLI side

- `keel login` signs this machine in; without it the CLI's report waits in a
  queue on disk.
- `keel hooks status` shows the `version.created` hook, where reports go and
  as whom, and what is still queued; `keel hooks retry` sends the queue.
- keel 0.3.9 sends its report in the event's first format, without a
  correlation id; keel-api still accepts it from the CLI, computes the id
  itself, and joins it with the CI's report. Newer keel sends the second
  format, with the id.
