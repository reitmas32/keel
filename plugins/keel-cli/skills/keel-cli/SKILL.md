---
name: keel-cli
description: Operate releases and Dokploy with the keel CLI safely — create, promote and deploy versions through the keel server after CI passes, roll back, freeze scopes, read versions, changes, deploys, status and redacted logs, and change anything else on Dokploy (env, Compose, mounts, databases, backups, start/stop) only through expiring plans a person approves one by one. Use when the user wants to deploy, ship, promote or roll back a version, freeze deploys, or see what a deploy would change; asks what runs where, whether a service is up, for logs, or why a deploy failed or waits for CI; wants to change, add or remove an env variable, edit a Compose, add a volume or mount, create a database or a scheduled backup, start, stop or redeploy something on Dokploy; prepare a repo for keel or install agent skills; or when a keel command fails with an error kind such as keel_managed, locked, unauthorized, drift or ci_failed — even if they do not name keel. Never use the Dokploy web UI, curl or another client instead.
metadata:
  version: "0.6.0"
  owner: fundathyon
---

# keel CLI

`keel` is one binary with two halves:

- **keel versions and deploys** go through the keel server: `create-version`,
  `versions`, `deploy`, `promote`, `rollback`, `lock`/`unlock`, `scopes`,
  `deploys`, `changes`, `status`, `logs`. The
  server queues a deploy and only touches Dokploy after the repository's
  GitHub Action reports that CI passed for that tag.
- **Direct Dokploy operation** uses the person's local Dokploy API key: redacted
  reads (`get …`, `env diff`, `api`, `compose diff`) and changes only through plans —
  `plan <kind>` describes the change, a person approves it, `apply` runs that
  exact plan once.

Run it from the repository the conversation is about: the folder decides the
keel app and, through each instance's `paths`, the Dokploy instance.

Words keel uses:

- **app** — a GitHub repository linked to keel (created in the keel admin,
  under `/apps`). Versions, deploys and the CI token belong to an app.
- **scope** — a deploy target inside an app: an alias such as `prod` or `stg`
  that points to one Dokploy application or compose. Every keel command picks
  it with `-s/--scope` (`--service`, the name before keel-cli 0.3.0, still
  works in old scripts).
- **service** — only for things on Dokploy's side: applications, composes and
  databases (`keel get services`, the Dokploy plans). A Dokploy service may or
  may not be a keel scope.

The CLI talks to keel servers before v0.7.0 too: it falls back to their old
routes on its own, and its `--json` keeps the old `service` key next to
`scope`.

Full flags of every command: [references/commands.md](references/commands.md).
Every error kind and what to do: [references/errors.md](references/errors.md).

## Ground rules

1. **Never `apply` without an explicit yes from a person for that exact plan.**
   Show the plan summary and its target first (step 3 of the Dokploy workflow).
   A yes to an earlier plan, to another service or to "do everything" is not a
   yes to this one. One plan, one approval, one apply.
2. **Ask before `create-version`, `deploy`, `promote`, `rollback`, `lock` and
   `unlock`.** They publish a tag, change what is running or who may deploy;
   none of them is a plan, so your question is the only review. Say the
   version, the scope and what runs there now (`keel changes` shows the
   commits), and wait. `-y` skips keel's own confirmation, so it needs the
   person's yes in the chat first.
3. **Application versions go through keel, not Dokploy.** If a Dokploy service
   is a keel scope, deploy it with `keel deploy -s <scope> -v <version>` and
   undo with `keel rollback`. Never work around `keel_managed` (for example by
   changing the tag variable or using `--not-keel-managed` to skip a check you
   could not run), and never work around `locked`: a locked scope was frozen
   by a person on purpose; only they decide to `keel unlock` it.
4. **Secret values never go on the command line and never pass through you.**
   No `--set KEY=value` (it does not exist on purpose), no secrets in
   arguments, no `cat` of env files, instance files or plan files. See
   "Change env variables" below.
5. **No deletes.** The CLI has none on purpose. If a service, database,
   volume, mount or domain has to go, tell the person to do it in the
   Dokploy panel.
6. **One change at a time.** Plan, approve, apply, verify; then the next. No
   loops over services or scopes.
7. **Agents pass flags; prompts are for people.** Without a terminal keel does
   not ask and fails with `missing_input` (32): always pass `-s` and `-v` (or
   `-r`), `-y` for an approved rollback or promote, `-m` for `lock`, `--org`
   and `--api-url` for `login`. Add `--json` whenever you parse output.
   Never pass a personal token (`--token`) yourself: the person runs
   `keel login` in their own terminal.
8. **Report what happened, not what you expected.** A queued deploy is not a
   deployed one until keel says `deployed`; an applied plan is not a working
   service until you read its deployments and logs.
9. **No other channel.** If keel cannot do something, say so. Do not fall back
   to the Dokploy UI, `curl` against its API, SSH, or the old `dokploy-agent`
   binary.

## keel or Dokploy?

Start every session with:

```sh
keel context --json      # keel org and app (this repo); Dokploy instance and why it was chosen
```

| The person wants… | Use |
| --- | --- |
| A new version, deploying it | `keel create-version`, `keel deploy` |
| What a deploy would bring (commits, PRs) | `keel changes -s <scope> [-v <tag>]` |
| Promote what staging runs to production | `keel promote --from stg --to prod` |
| To undo a deploy of a version | `keel rollback` (or `--rollback-on-failure` on deploy/promote) |
| Freeze or unfreeze deploys of a scope | `keel lock -s <scope> -m <reason>`, `keel unlock -s <scope>` |
| Compare env variables of two services (names only), or check some keys are equal | `keel env diff <svcA> <svcB> [--key KEY]` |
| Prepare a repo for keel (workflow, app, secrets), or audit it | `keel init`, `keel init --check` |
| Install these skills in a repo | `keel skills add keel-cli` |
| What runs where, is it up, what CI says | `keel status`, `keel scopes`, `keel versions` |
| Deploy history of the app, why one failed | `keel deploys`, `keel deploys <id> --log` |
| Logs of a scope | `keel logs -s <scope>` |
| Logs or deploy log of any Dokploy service | `keel get logs`, `keel get deploy-log` |
| Env variables, Compose, mounts, databases, backups, start/stop | `keel plan …` → `keel apply` |
| Redeploy a service that is **not** a keel scope | `keel plan redeploy` → `keel apply` |
| Redeploy a keel scope at the version it already runs | `keel deploy -s <scope> -v <current version>` |

`keel deploys` lists deploys that went through keel; `keel get deployments`
lists Dokploy's own deployments of a service, including any made outside keel.

## Workflow: release and deploy a version

1. Read the state: `keel status --json` and `keel versions --json -n 5`.
2. Choose the version. If the `keel-release` skill is installed, use it to
   pick the number and prepare the version files; otherwise propose the next
   semantic version (`vMAJOR.MINOR.PATCH`) and let the person decide.
3. Ask, naming everything that will happen:

   > **Release:** `v1.4.0` from branch `main` at `<sha>` (pushes the tag; CI starts)
   > **Deploy:** to scope `stg` (Dokploy `shop/staging/api`, runs `v1.3.2` now)
   >
   > Go ahead?

4. On yes, create and deploy in one command, so nobody else's version can
   slip in between:

   ```sh
   keel create-version v1.4.0 -d stg --wait --json
   ```

   `create-version` refuses with `git_state` (27) when the origin is not the
   active org's, the branch is not in sync with its remote, the tag exists or
   the version is not `v`-prefixed semver. Report the reason; do not push,
   rebase or delete tags to get past it unless the person asks.
5. `--wait` follows the deploy: `waiting_ci → ci_passed → deploying →
   deployed`. It exits 0 on `deployed` and 28 (`ci_failed`) on `ci_failed`,
   `deploy_failed` or `expired`. CI can take minutes; that is normal.
6. To move what one scope runs to another (promotion), show what changes,
   ask, then:

   ```sh
   keel changes -s prod -v v1.4.0 --json          # commits and PRs prod would get
   keel promote --from stg --to prod -y --rollback-on-failure --json
   ```

   `promote` deploys the exact tag and commit the source scope runs; it
   refuses (`refused`) when the source has nothing deployed or the target
   already runs it (`--force` redeploys it). `--rollback-on-failure` (also on
   `deploy`) waits and, if Dokploy fails (`deploy_failed`), deploys again what
   the scope ran before; it still exits 28 and the error's `details` carry
   both `deploy` and `rollback`. Report both. To deploy a specific version
   instead: `keel deploy -s prod -v v1.4.0 --wait --json`.

   Prefer `-v` (exact) for production. `-r` takes the highest version whose CI
   passed. Avoid `-l` (highest tag whatever its CI) outside staging: without a
   terminal it deploys someone else's newer version with only a warning.

## Workflow: roll back

1. `keel deploys -s <scope> -n 10 --json` — what is deployed now and what was
   before. `rollback` goes back to the previous version that reached
   `deployed` there, skipping failures; `--to <tag>` picks an earlier one that
   was deployed in that scope.
2. Ask: "Roll back `prod` from `v1.4.0` to `v1.3.2`?" Wait for yes.
3. Run it: `keel rollback -s prod -y --json` (or `--to v1.3.2`). It refuses
   while another deploy of that scope is in progress. A second rollback undoes
   the first.
4. Add `--wait` to follow it to a final state, then check the logs.

## Workflow: freeze deploys

During an incident or a release freeze a person may lock a scope:
`keel lock -s prod -m "incidente 4521"`. keel then refuses every deploy,
promote and rollback to it with `locked` (31); `keel scopes` and
`keel status` show who locked it, when and why. Lock or unlock only when the
person asks; on `locked`, report the reason and stop.

Each person has a role in keel — viewer, publisher (create versions),
deployer (deploy, promote, rollback), maintainer (also lock) or admin — that
can change per app and scope (e.g. deployer on `stg`, viewer on `prod`). Check with
`keel whoami` before acting for someone; on `forbidden` (33) report it and
stop.

## Workflow: diagnose a failed or stuck deploy

```sh
keel deploys -s <scope> -n 10 --json      # status, error and id of each deploy
keel deploys <id> --log                   # timeline + Dokploy's deploy log, redacted
keel versions --json                      # did CI pass for that tag? failed runs link to GitHub
keel logs -s <scope> --since 15m          # what the containers print now
keel logs -s <scope> --search error -f    # follow live; stops on Ctrl-C
```

| Status | Meaning | Next step |
| --- | --- | --- |
| `waiting_ci` | Queued; the Action has not reported yet | `keel versions` — is CI running? It expires after the server's CI window |
| `ci_failed` | CI failed for that tag: nothing was deployed | Share the run link from `keel versions`; the fix is a new version |
| `expired` | CI never reported in time | Check that the Release workflow ran and can reach the keel API |
| `deploy_failed` | CI passed, Dokploy failed | `keel deploys <id> --log`, then `keel logs -s <scope>` |
| `deployed` but broken | Running, misbehaving | `keel logs -s <scope> --since 30m --search …`; propose a rollback |

For a Compose with several containers pass `--container web` (or whichever
service). For a service that is not a keel scope, use
`keel get deployments <svc>`, `keel get deploy-log <svc> [--deployment <id>]`
and `keel get logs <svc> [--container …] [-f]`. `get deploy-log` also works
for databases (it falls back to the service's logs). Read logs before
proposing a fix: a redeploy rarely cures a crash.

Logs are redacted on a best-effort basis. If a line still shows something
that looks like a credential, do not repeat it: name the service and the line.

## Workflow: change Dokploy (plan → approval → apply)

### 1. Locate the Dokploy

`keel context --json` names the instance (`organization/instance`) and why it
was chosen: `--target`, `KEEL_TARGET`, the folder (`paths`), `default`, or the
only instance. Check it matches the project being discussed.

- `target_unmapped` / `target_ambiguous`: show `details` (instances and their
  folders, or the candidates) and ask. Pass `--target org/instance` only after
  the person answers — never on a guess.

### 2. Read before proposing

```sh
keel get services [filter]                 # apps, Composes and databases with status
keel get service <svc>                     # source, image, env keys, domains; DB connection details (password redacted)
keel get env <svc>                         # env KEYS and value lengths, never values
keel get compose --service <svc> --show-compose
keel get mounts <svc>  ·  keel get domains <svc>
keel get backups <db>  ·  keel get destinations
keel get env-backups [svc]                 # env saved before each env change (local)
```

A service is `name`, `environment/name` or `project/environment/name`. On
`service_ambiguous` show `details.candidates` and ask, unless the conversation
already makes it clear — then use the full `project/environment/name`.

### 3. Plan, show, stop

Create the plan, then show it in this shape and wait:

> **Change:** `env-patch` on `shop/production/api` — changes `SENTRY_DSN` (61 chars), removes `OLD_FLAG`, then redeploys
> **Dokploy:** `acme/production` — https://dokploy.example.com (selected by folder)
> **keel:** not a keel scope / scope `prod` of `acme/shop` / not verified with keel
> **Warnings:** whatever the plan lists, verbatim
> **Revert:** `plan env-restore shop/production/api --backup <timestamp>`
> **Plan:** `<plan_id>`, expires `<expires_at>`
>
> Apply it?

Take every field from the plan's output (`operation`, `changes`, `target`,
`keel`, `warnings`, `expires_at`), not from what you meant to do.

| Need | Plan |
| --- | --- |
| Change some env variables | `plan env-patch <svc> --set KEY --unset KEY --set-from-file KEY=/abs/path [--redeploy]` |
| Replace the whole env | `plan env-set <svc> --file <new.env> [--redeploy]` |
| Copy a secret from one service to another | `plan env-copy --from <svc> --to <svc> --key KEY[:DEST] [--overwrite] [--redeploy]` |
| Undo an env change | `plan env-restore <svc> --backup <timestamp> [--redeploy]` |
| Change a Compose file | `get compose --write-to` → edit → `compose diff` → `plan compose-update` (below) |
| New Compose | `plan compose-create --environment <project/env> --name <n> --file compose.yaml [--server …]` |
| Compose source, name, description | `plan compose-settings <svc> [--source-type raw] [--name …]` |
| Volume, bind or file mount | `plan mount-create <svc> --type volume\|bind\|file --mount-path /x [--volume-name … \| --host-path … \| --file …] [--redeploy]` |
| New Postgres / Mongo | `plan postgres-create …` / `plan mongo-create …` (password from `--password-env VAR`, read at apply), then `plan deploy` |
| Scheduled DB backup | `plan backup-create <db> --database … --destination … --schedule "30 3 * * *" --prefix … --keep-latest-count N` |
| Deploy, redeploy, start, stop a non-keel service | `plan deploy\|redeploy\|start\|stop <svc>` |

The keel rule, checked when planning:

- `plan deploy|redeploy` on a keel scope of this app → `keel_managed` (25):
  use `keel deploy -s <scope> -v <version>` or `keel rollback -s <scope>`.
- env plans may not change or remove a keel Compose scope's tag variable
  (`DOCKER_TAG` unless the scope names another) → `keel_managed`.
- `compose-update` on a keel scope warns if the image stops using the tag
  variable: keel could no longer deploy it. Treat that warning as a blocker
  to raise with the person.
- In a keel app's repo where the keel server cannot be asked → `keel_unreachable`
  (26). Report it. `--not-keel-managed` exists for a service the person
  confirms is not a keel scope; never add it on your own.
- Outside a keel app's repo the plan only notes "no verificado con keel" (not
  verified with keel) — show that note in the summary.

### 4. Apply exactly that plan

```sh
keel apply --plan <plan_id> --approve <approval_token_sha256>
```

Lost the token after a long conversation? `keel plan show <plan_id>` (or
`keel plan list`). Never re-create an approved plan and apply the new one
without showing it again. On `terminal_approval_required` (21) give the
person the exact `apply` command to run in their own terminal.

### 5. Verify and report

```sh
keel get deployments <svc> --limit 3      # the new deployment and its status
keel get service <svc>                    # status
keel get logs <svc> [--container web] --since 5m
```

Env, Compose and mount changes take effect on the next deploy; with
`--redeploy` that deploy is part of the plan. Report what ran, what it
returned and what you checked.

## Change env variables

Prefer `env-patch` — it touches only the keys named. Values come from, in
order: the environment variable `$KEEL_SET_<KEY>` of the `keel` process (an
explicit prefix, so an inherited `$KEY` is never used), a hidden prompt (only
at a terminal), or stdin when there is exactly one `--set`. Never from an
argument. Empty values are refused (`refused`); remove a key with `--unset`.
The plan summary says where each value came from (`value_sources`).

- **The value is a secret** (token, password, DSN with credentials): it must
  not pass through you. Either give the person the command to run in their
  own terminal, where keel prompts without echo:

  ```sh
  keel plan env-patch shop/production/api --set STRIPE_KEY --redeploy
  ```

  then continue from the `plan_id` they paste back (`keel plan show <id>`);
  or have them write the value to an owner-only file and use
  `--set-from-file STRIPE_KEY=/abs/path` without reading that file.
- **The value is not secret** and the person stated it (`LOG_LEVEL=debug`):
  pass it on stdin for a single `--set`, never as an argument to keel:

  ```sh
  printf '%s' 'debug' | keel plan env-patch shop/production/api --set LOG_LEVEL --json
  ```

- **The value already lives in another service** (the staging API key, an
  RSA key another service uses): copy it, never read it.

  ```sh
  keel plan env-copy --from shop/staging/api --to shop/production/api --key STRIPE_KEY --json
  keel env diff shop/staging/api shop/production/api --key STRIPE_KEY --json   # after apply: equal
  ```

  `--key SRC:DEST` renames it; `--overwrite` is needed when the destination
  already has another value — say so when you show the plan. Never use
  `get env --write-to` plus `env-patch` for this: the value would pass
  through a file you handle.
- `$KEEL_SET_<KEY>` wins over stdin; check `value_sources` in the plan says
  what you expect before showing it for approval.
- `--unset KEY` fails if the key does not exist; `get env <svc>` first.
- Every env plan backs up the current env (`keel get env-backups <svc>`) and
  is refused with `drift` if the env changed after planning.

## Edit a Compose

```sh
keel get compose --service <svc> --write-to /abs/new/compose.yaml   # owner-only file; must not exist yet
# edit the file (it may contain secrets: change only what was asked, never print it)
keel compose diff <svc> --file /abs/new/compose.yaml               # sanitized diff to show the person
keel plan compose-update --service <svc> --file /abs/new/compose.yaml [--redeploy]
```

Show the sanitized diff with the plan summary. On `drift` read the remote
again, redo the edit on the new content, plan again and ask again.

## Errors

With `--json`, or without a terminal, failures print
`{"ok": false, "error": {"kind", "exit_code", "message", "details"}}`.
Branch on `kind`, not on the message:

| kind | exit | What to do |
| --- | --- | --- |
| `error` | 1 | Report the message |
| `config` | 2 | Missing login, org or Dokploy key: point to Setup; never ask for a key in the chat |
| `target_unmapped` / `target_ambiguous` / `target_unknown` | 3 | Show the instances or candidates and ask |
| `service_not_found` | 4 | `keel get services <filter>` and propose the closest names |
| `service_ambiguous` | 5 | Show `details.candidates` and ask (for logs of a Compose: pass `--container`) |
| `network` | 10 | `keel doctor`; a private panel that does not resolve usually means the VPN is off. No retry loops |
| `auth` | 11 | Credential rejected: the person renews it. Never paste keys into the chat |
| `api` | 12 | Report it; `keel api` lists what this panel answers |
| `refused` | 20 | Policy said no. Explain; do not look for a way around it |
| `terminal_approval_required` | 21 | Give the person the `apply` command to run themselves |
| `approval_mismatch` | 22 | `keel plan show <id>` and apply with that plan's token |
| `plan_unavailable` | 23 | Expired, applied or unknown: plan again and ask again |
| `drift` | 24 | Remote changed: read again, plan again, ask again |
| `keel_managed` | 25 | Use `keel deploy -s <details.scope> -v …` / `keel rollback`; never change the tag variable |
| `keel_unreachable` | 26 | Report it; `keel doctor`. `--not-keel-managed` only if the person confirms it is not a scope |
| `git_state` | 27 | Report why the version cannot be created; fixing git is the person's call |
| `ci_failed` | 28 | The deploy ended `ci_failed`, `deploy_failed` or `expired`: diagnose (above). With `--rollback-on-failure`, `details.rollback` says whether the rollback worked |
| `unauthorized` | 29 | keel rejected the personal token or requires one: the person creates one in the admin («Tokens de API») and runs `keel login --token` themselves |
| `cancelled` | 30 | Someone said no, or waiting stopped; the deploy may still be running: `keel deploys <id>` |
| `locked` | 31 | The scope is frozen: report the reason; only the person decides to `keel unlock` |
| `forbidden` | 33 | Your role can't do that on that app/scope (`keel whoami` shows role and grants): report it; a keel admin grants access |
| `missing_input` | 32 | A flag is missing and there is no terminal to ask: add it (ask the person for its value if needed) |

Details and examples: [references/errors.md](references/errors.md).

## Setup (for the person)

Install or update the binary. `keel update` downloads the latest release of
the platform's binary from GitHub Releases (`reitmas32/keel`) and checks it
against the release's `SHA256SUMS`; `keel update --check` only reports. For
a first install, download the asset for the platform from the latest release
and verify it:

| Platform | Asset |
| --- | --- |
| Linux x86_64 / arm64 | `keel-x86_64-unknown-linux-musl` / `keel-aarch64-unknown-linux-musl` |
| macOS Intel / Apple silicon | `keel-x86_64-apple-darwin` / `keel-aarch64-apple-darwin` |
| Windows x86_64 / arm64 | `keel-x86_64-pc-windows-msvc.exe` / `keel-aarch64-pc-windows-msvc.exe` |

```sh
base=https://github.com/reitmas32/keel/releases/latest/download
asset=keel-aarch64-apple-darwin
curl -fsSLO "$base/$asset" && curl -fsSLO "$base/SHA256SUMS"
grep " $asset\$" SHA256SUMS | shasum -a 256 -c -     # sha256sum -c on Linux
install -m 755 "$asset" ~/.local/bin/keel
```

Downloading and installing a binary is the person's decision: offer these
commands, do not run them unasked.

Connect a keel organization (the person runs it; it asks for the personal
token without echo, or reads `KEEL_TOKEN`):

```sh
keel login --org github.com:<org> --api-url https://keel.example.com/api
keel use github.com:<org>          # switch the active org (~/.keel/current)
```

When the server sets `KEEL_API_AUTH=required`, every keel command needs that
token; deploys record who asked for them (`requestedBy`).

Link a repo to keel: `keel init` does it end to end and can be re-run safely.
It creates the app in keel (admin role), links scopes (`--scope prod=<dokploy
id or url>`, repeatable; at a terminal it offers Dokploy's services), stores
the app's CI token as the `DEPLOY_API_TOKEN` secret through `gh` (by stdin —
the token never reaches the terminal, the conversation or the JSON;
`--secret <NAME>` picks another secret), sets the `KEEL_API_URL` variable,
writes `.github/workflows/keel-release.yml`, and with `--pr` opens a PR from
branch `keel/init`. `KEEL_API_URL` is the URL GitHub's runners reach:
`--ci-api-url <url>` sets it (e.g. a public gateway in front of an internal
keel; `keel login --ci-api-url` saves one for the whole org); without the flag
a value the repo already has is kept — never "fix" it to the internal API URL.
A repo whose own release workflow already reports to keel (calls `/ci-result`
or has a `notify-keel` job, e.g. `.github/workflows/main.yml`) gets no
`keel-release.yml`; `--workflow` writes it anyway — don't, unless asked. Without a terminal it needs `-y` to
create the app. `--rotate-token` replaces the CI token and the secret in one
step (confirm with the person first: it invalidates the token the CI uses).
It stops before creating anything if `gh` is missing or logged out; never use
`--no-github --show-token` for someone (that prints the token). `keel init
--check --json` only audits. Report its ▲ warnings: an API host GitHub can't
reach (VPN, `.internal`) means deploys wait for a CI result that never comes.

Install these skills elsewhere: `keel skills add keel-cli` (this repo, for
Claude Code, Codex and Copilot), `-g` for the user, `keel skills update`.

Dokploy access is optional (without it `get`, `plan`, `apply` and `backup`
fail with `config`). One owner-only file per instance in
`~/.keel/dokploy/instances/<org>.env` (chmod 600) with `DOKPLOY_URL`,
`DOKPLOY_API_KEY` and `DOKPLOY_PATHS`. keel still reads an old
`~/.config/dokploy-agent` until `keel config migrate` (`--dry-run` first)
moves it. Check with `keel config check`, `keel targets` and `keel doctor`.
The person edits these files; you never read or print them.
