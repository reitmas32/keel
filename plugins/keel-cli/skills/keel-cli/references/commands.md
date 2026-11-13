# keel command reference

Every command of the `keel` binary, grouped by what it talks to. The
binary's own `keel <command> --help` is authoritative; check it when a flag
here does not work. Commands that change something are marked **changes**.

## Global options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--json` | all | JSON output, errors included. Without a terminal errors are already JSON |
| `--org <github.com:org>` · `KEEL_ORG` | keel | keel organization instead of the active one (`~/.keel/current`) |
| `--target <org/instance>` · `KEEL_TARGET` | Dokploy commands that take it | Dokploy instance. Plain `org` works when it has one instance called `production` |
| `--config <path>` · `KEEL_CONFIG` | Dokploy | Alternative `config.toml` (default `~/.keel/dokploy/config.toml`) |
| `--state-dir <abs path>` | Dokploy | Where plans, env backups and `audit.jsonl` live |
| `KEEL_TOKEN` | keel | Personal token for this command, instead of the one saved by `keel login` |
| `-h`, `--help` · `-V`, `--version` | all | Help; binary version |

keel commands print tables for people and JSON with `--json`. Dokploy
commands print JSON.

Without `--target` the Dokploy instance comes from `KEEL_TARGET`, then from
the working directory (the instance whose `paths` contain it), then from the
instance marked `default = true`, then from a lone instance.

A Dokploy service is named `name`, `environment/name` or
`project/environment/name`.

## Session, configuration, diagnosis

| Command | What it does |
| --- | --- |
| `keel login --org github.com:<org> --api-url <url> [--token <keel_pat_…>]` | Saves a keel organization, its API URL and personal token in `~/.keel/<org>/config.json` (chmod 600) and makes it active. The token is checked before saving (`unauthorized` if rejected); at a terminal it is asked without echo; `--token ""` forgets it; `KEEL_TOKEN` overrides it per command |
| `keel use [org]` | Selects the active organization (asks when omitted, at a terminal) |
| `keel context` (alias `remote`) `[--target …]` | Where this folder points: keel org and app (the repo); Dokploy instance and why it was chosen |
| `keel whoami` | Who keel says you are: name, email, role, grants per app and scope (`app / scope` patterns), the token's role cap and whether the instance requires a token |
| `keel status [--target org/instance]` | App state in one view: each scope with its current version and last deploy, the newest version and its CI, and Dokploy status |
| `keel init [-y] [--scope ALIAS=ID\|URL]… [--tag-variable ALIAS=VAR] [--rotate-token] [--pr] [--check] [--force]` | **changes** (keel, GitHub, repo) Links the repo end to end, idempotently: creates the app in keel (admin; `-y` without a terminal), links scopes, stores the CI token as the `DEPLOY_API_TOKEN` secret through `gh` stdin (never printed), sets `KEEL_API_URL`, writes `.github/workflows/keel-release.yml` (`--force` over a customized one) and with `--pr` opens a PR from `keel/init`. `--rotate-token` replaces token and secret together. Stops before creating anything without `gh`. `--check` only audits (exit 2 if something is missing). Warns when GitHub can't reach the API |
| `keel skills [list]` · `keel skills add <skill>… [-g] [--agent claude,codex,copilot] [--from <path>] [--ref <ref>]` · `keel skills remove <skill>…` · `keel skills update` | **changes** (local) Agent skills from `plugins/*/skills` of reitmas32/keel into `.claude/skills` and `.agents/skills` (or `~` with `-g`). Each copy has `.keel-skill.json`; folders without it are never touched |
| `keel doctor [--target …]` | Checks the keel API (and who the token is) and Dokploy (DNS, panel, key, version, inventory). Exits 0, 10 (network) or 2 (config/key) |
| `keel targets` | Configured Dokploy instances, their folders, approval mode and default |
| `keel config check` | Validates the Dokploy configuration without reading credentials |
| `keel config migrate [--dry-run]` | **changes** (local) Moves dokploy-agent's `~/.config/dokploy-agent` to `~/.keel/dokploy` |
| `keel update [--check]` | **changes** (local) Replaces the binary with the latest GitHub release, verified against `SHA256SUMS`. `--check` only reports |
| `keel completions <bash\|zsh\|fish\|powershell\|elvish>` | Shell completion script |

## Versions and deploys (keel server)

An **app** is a GitHub repo linked to keel; a **scope** is one of its deploy
targets (`prod`, `stg`…), an alias for a Dokploy application or compose.
Every command that picks a scope takes `-s/--scope <SCOPE>`; `--service` is
still accepted as a hidden alias for scripts written before keel-cli 0.3.0.
keel servers before v0.7.0 work too: the CLI falls back to their old
`/services` routes, and `--json` output carries both `scope` and `service`.

| Command | What it does |
| --- | --- |
| `keel create-version <vX.Y.Z> [-d <scope> [--wait]]` | **changes** Validates the repo, creates and pushes the tag, registers it in keel. With `-d` also requests the deploy of that same version to the scope; `--wait` follows it |
| `keel versions [-n <limit>]` | Versions with branch, author and CI result (20 by default, 200 max). Failed CI shows the run link |
| `keel deploy -s <scope> (-v <tag> \| -r \| -l) [--wait] [--rollback-on-failure]` | **changes** Requests a deploy; the server waits for CI. `-v` exact version, `-r`/`--latest-ready` highest with CI passed, `-l`/`--latest` highest tag regardless of CI. `--wait` exits 28 on failure. `--rollback-on-failure` (implies `--wait`) deploys the previous version again if Dokploy fails |
| `keel promote --from <scope> --to <scope> [-y] [--wait] [--rollback-on-failure] [--force]` | **changes** Deploys to `--to` the tag and commit `--from` runs. Refuses if `--from` has nothing deployed, `--to` is locked, or already runs it (unless `--force`). `-y` required without a terminal |
| `keel changes -s <scope> [-v <tag>]` | Commits between what the scope runs and a version (newest semver tag by default), with PR numbers; `removed` lists commits a rollback would take out. Fetches tags first |
| `keel lock -s <scope> -m <reason>` · `keel unlock -s <scope>` | **changes** Freezes or unfreezes deploys of a scope; while locked keel answers deploys with `locked` (31) |
| `keel rollback -s <scope> [--to <tag>] -y [--wait]` | **changes** Redeploys the previous version that reached `deployed` in that scope (or `--to`, one deployed there before). `-y` is required without a terminal. Refuses while a deploy of that scope is in progress |
| `keel scopes` | Scopes of the app: the Dokploy application or compose each points to, type, current version, last deploy, and 🔒 with the reason when locked. `--json` prints the list as the server sends it (each deploy with `scope` and `service`) |
| `keel deploys [id] [-s <scope>] [-n <limit>] [--log]` | Deploys of the app, newest first (column `SCOPE`). With an id (or its prefix): detail and timeline; `--log` adds Dokploy's deploy log, redacted (needs the Dokploy key) |
| `keel logs -s <scope> [--container <c>] [-f] [--tail 200] [--since all\|30s\|10m\|1h\|2d] [--search <text>] [--target org/instance]` | Redacted container logs of a scope by its keel name. `-f` follows until Ctrl-C |

Deploy states: `waiting_ci → ci_passed → deploying → deployed`, ending
otherwise in `ci_failed`, `deploy_failed` or `expired` (CI did not report in
time).

What keel does on `deployed` depends on what the scope points to: an Application
gets its Docker image set to `…:<tag>`; a Compose gets its tag variable
(`DOCKER_TAG` unless the scope names another) set in its Environment and is
redeployed.

`create-version` refuses (`git_state`) when the origin is not the active
org's, the local branch and its remote point to different commits, the tag
already exists or the version is not `v`-prefixed semver; a `-d` scope the
app does not have is refused (`error`) before the tag is created.

## Read Dokploy (no plan, no approval)

| Command | What it shows |
| --- | --- |
| `keel get projects` | Projects with their number of services |
| `keel get services [filter]` | Every app, Compose and database with environment and status |
| `keel get service <svc> [--raw]` | Server, source, image, env keys, domains; keel scope and version when managed; for databases host, port, database, user, image, limits (password redacted). `--raw` = full redacted API response |
| `keel get env <svc> [--write-to /abs/new]` | Env keys and value lengths, never values. `--write-to` saves the real block to a new owner-only file |
| `keel env diff <svcA> <svcB> [--key KEY]… [--target-b org/instance]` | Whether two services' envs are equal (`equal`), and the keys only in A, only in B, with a different value, with the same value (and, with `--key`, in neither). Values are compared as hashes in memory and never printed. `--key` compares only those keys; `--target-b` reads B from another Dokploy |
| `keel get env-backups [svc]` | Env backups saved before each env-set, env-patch or env-restore (local, no values) |
| `keel get compose (--service <svc> \| --id <id>) [--show-compose] [--write-to /abs/new]` | Compose data; `--show-compose` adds the definition without environment or secret blocks; `--write-to` saves the original (secrets included) to a new owner-only file |
| `keel compose diff <svc> --file <path>` | Sanitized diff between the remote Compose and a local file |
| `keel get mounts <svc>` | Volumes, bind mounts and file mounts |
| `keel get destinations` | Backup destinations (S3 and compatible), without credentials |
| `keel get backups <db>` | Scheduled backups of a database |
| `keel get domains <svc>` | Domains in Dokploy's registry (Traefik-label routes are not listed) |
| `keel get deployments <svc> [--limit 15]` | Dokploy's latest deployments of an app or Compose |
| `keel get logs <svc> [--container <c>] [-f] [--tail 200] [--since …] [--search <text>]` | Last container lines, redacted. `--container` is required for a multi-container Compose. `--search` matches locally after redaction |
| `keel get deploy-log <svc> [--deployment <id>] [--tail 200] [--search <text>]` | Build and deploy log, redacted (latest deployment when omitted). For a database it falls back to the service's logs |
| `keel get servers` · `keel get server --id <id>` · `keel get server-services --id <id>` | Servers, one server, services on a server |
| `keel get containers [--server-id <id>]` | Docker containers the panel sees |
| `keel get raw <procedure> [--param k=v]…` | Any read procedure, redacted. `*.readLogs` is refused: use `get logs` |
| `keel api [filter]` | Read procedures this panel answers and mutations the CLI can plan |

## Change Dokploy (plan → approval → apply)

`plan` validates, resolves names to ids and stores a plan that expires,
printing `plan_id`, `operation`, `changes`, `target`, `keel` (the keel-rule
note), any `warnings`, `expires_at` and `approval_token_sha256`. A person
approves; `apply` runs it once against the instance stored in the plan.

| Command | What it plans |
| --- | --- |
| `keel plan env-patch <svc> [--set KEY]… [--set-from-file KEY=/abs/path]… [--unset KEY]… [--redeploy] [--not-keel-managed]` | Change only some keys. `--set` values come from `$KEEL_SET_<KEY>`, a hidden prompt (terminal) or stdin (single `--set` only) — never from the command line. Summary shows keys added, changed or removed and value lengths |
| `keel plan env-set <svc> --file <new.env> [--redeploy] [--not-keel-managed]` | Replace the whole env with a dotenv file |
| `keel plan env-copy --from <svc> --to <svc> --key KEY[:DEST]… [--from-target org/instance] [--overwrite] [--redeploy] [--not-keel-managed]` | Copy keys from one service's env to another's, each value exactly as written — it goes from Dokploy to the plan file and back, never through stdout, argv or you. A destination key with another value needs `--overwrite`; one with the same value is left alone. Summary: `copied_from`, keys added/changed and lengths |
| `keel plan env-restore <svc> --backup <timestamp or prefix> [--redeploy] [--not-keel-managed]` | Put back an env from `get env-backups` (full replace) |
| `keel plan compose-update (--service <svc> \| --compose-id <id>) --file <path> [--redeploy] [--not-keel-managed]` | Replace the Compose file; summary includes the sanitized diff |
| `keel plan compose-create --environment <id or project/env> --name <n> --file <path> [--server <id or name>] [--description …]` | Create a raw Compose |
| `keel plan compose-settings <svc> [--source-type raw\|github\|gitlab\|bitbucket\|gitea\|git] [--name …] [--description …]` | Change a Compose's source type, name or description |
| `keel plan mount-create <svc> --type volume\|bind\|file --mount-path <path> [--volume-name … \| --host-path /abs \| --file <local>] [--redeploy]` | Add a mount; applies on the next deploy, or now with `--redeploy` |
| `keel plan postgres-create --environment-id <id> --name <n> --database-name <db> --database-user <u> --password-env <VAR> [--docker-image …] [--server-id …]` | New Postgres; password read from `$VAR` at apply time only |
| `keel plan mongo-create --environment <id or project/env> --name <n> --database-user <u> --password-env <VAR> --docker-image mongo:8 [--server …] [--memory-limit-bytes N] [--description …]` | New Mongo; then `plan deploy` it |
| `keel plan backup-create <db> --database <name> --destination <id or name> --schedule "<5-field cron>" --prefix <path/> --keep-latest-count <n>` | Scheduled database backup (`get destinations` lists destinations) |
| `keel plan deploy\|redeploy\|start\|stop <svc> [--not-keel-managed]` | Service actions. `deploy`/`redeploy` on a keel scope are refused with `keel_managed` |
| `keel plan raw-post <procedure> --body-file body.json` | POST to a procedure in `security.raw_post_allowlist`; deletes are always refused |
| `keel plan list` | Pending plans with target and expiry |
| `keel plan show <plan_id>` | A pending plan again, with its approval token |
| `keel plan prune [--all [-y]]` | **changes** (local) Removes expired plans; `--all` also pending ones (asks; `-y` skips). Backups and audit are kept |
| `keel apply --plan <plan_id> --approve <approval_token_sha256>` | **changes** Runs that plan once. Instances with terminal approval also require a person to retype the short id at a terminal |

`--not-keel-managed` lets a plan through when keel cannot be asked whether
the service is a keel scope. It is noted in the plan summary. It does not
lift `keel_managed`.

## Local backups

| Command | What it does |
| --- | --- |
| `keel backup compose --compose-id <id> --version <label> [--commit]` | **changes** (local) Saves a Compose into an existing local checkout after checking its origin and branch; `--commit` also commits. Never pushes. Not for Composes with secrets written in the file |

## Files on disk

```text
~/.keel/
├── current                         active keel org
├── <org>/config.json               { "org", "apiUrl", "token"? } chmod 600
└── dokploy/                        chmod 700, optional
    ├── config.toml                 [security]: allow_http, log_tail_max, raw_post_allowlist, plan_ttl_seconds
    └── instances/<org>.env         chmod 600: DOKPLOY_URL, DOKPLOY_API_KEY, DOKPLOY_PATHS, DOKPLOY_APPROVAL…
```

Plans, env backups and `audit.jsonl` live in the state directory
(`--state-dir`), owner-only. Do not read instance or plan files: they hold
credentials and env values.
