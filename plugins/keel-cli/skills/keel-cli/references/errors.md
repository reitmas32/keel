# keel errors

With `--json`, or whenever stdout is not a terminal, a failure prints one
JSON object and the process exits with the kind's code:

```json
{"ok": false, "error": {"kind": "service_ambiguous", "exit_code": 5,
  "message": "…", "details": {"candidates": ["shop/staging/api", "shop/production/api"]}}}
```

Branch on `kind`. `message` is for people (often in Spanish); `details` is
structured and may be absent.

## By kind

### `error` (1)

Anything without a more specific kind. Report the message.

### `config` (2)

The keel org is not logged in, the active org is missing, the Dokploy
configuration is invalid, or there is no Dokploy key (then `get`, `plan`,
`apply` and `backup` fail; the rest of keel works). Point the person to
`keel login`, `keel config check` or `keel config migrate`. Never ask for a
key in the chat or read instance files.

### `target_unmapped`, `target_ambiguous`, `target_unknown` (3)

No single Dokploy instance for this folder or these options.
`target_unmapped`: show the instances and their folders from `details` and
ask which one applies. `target_ambiguous`: two instances claim the folder;
show `details.candidates`. `target_unknown`: `--target`/`KEEL_TARGET` names
no configured instance; `keel targets` lists them. Pass `--target` only after
the person chooses.

### `service_not_found` (4)

No Dokploy service matches: run `keel get services <part of the name>` and
propose the closest names. For a keel scope that does not exist (`keel logs
-s`, `promote`), `keel scopes` lists the app's scopes. The kind keeps its
name for scripts.

### `service_ambiguous` (5)

`details.candidates` lists the matches. Ask which one, or use the full
`project/environment/name` when the conversation settles it. For `get logs`
or `keel logs` on a Compose, the candidates are its containers: pass
`--container <name>`.

### `network` (10)

DNS, connection or timeout. Run `keel doctor` once. A private panel or keel
server that does not resolve usually means the VPN is down: tell the person.
Do not retry in a loop.

### `auth` (11)

Dokploy or keel rejected the credential. The person renews it in their
instance file or with `keel login`. Never ask them to paste it.

### `api` (12)

Dokploy answered with another error. Report status and message. A 404 on a
procedure usually means this Dokploy version does not have it; `keel api`
lists what it answers.

### `refused` (20)

Policy said no: a destructive operation, a procedure outside the allowlist,
an operation the service type does not support, `--unset` of a missing key,
several `--set` without `$KEEL_SET_<KEY>` values, an empty value. Explain why; do not look for another
way to do the same thing.

### `terminal_approval_required` (21)

This instance requires a person to approve at a real terminal (they retype
the plan's short id). Give them the exact command:

```sh
keel apply --plan <plan_id> --approve <approval_token_sha256>
```

### `approval_mismatch` (22)

The token is not this plan's. `keel plan show <plan_id>` and use its
`approval_token_sha256`. Never swap in another plan's token.

### `plan_unavailable` (23)

Expired, already applied, or unknown. Create a new plan and ask again — the
earlier approval does not carry over.

### `drift` (24)

The remote env or Compose changed after the plan was made. Read it again,
rebuild the change on the new state, plan again, and ask again.

### `keel_managed` (25)

The Dokploy service is a keel scope of this app (`details.repo`,
`details.scope`, and for env plans `details.tag_variable`).

- `plan deploy`/`plan redeploy` → `keel deploy -s <scope> -v <version>` (ask
  first) or `keel rollback -s <scope>`.
- An env plan touched the tag variable → drop that key from the plan; the
  version only changes with `keel deploy`.

Do not retry with `--not-keel-managed`: it does not lift this refusal and
using it to dodge the rule defeats it.

### `keel_unreachable` (26)

In a keel app's repo, keel could not be asked whether the Dokploy service is
one of its scopes (the server is down, unreachable, or older than v0.5.0). Report it and run
`keel doctor`. Only if the person confirms the service is not a keel scope,
repeat the plan with `--not-keel-managed`; the summary records it.

### `git_state` (27)

`create-version` will not tag: the origin is not the active org's, the
branch is ahead of, behind or diverged from its remote (or was never
pushed), the tag already exists, or the version is not `v`-prefixed semver.
Report which. Pushing, pulling or choosing another number is the person's
decision.

### `ci_failed` (28)

A deploy followed with `--wait` ended in `ci_failed`, `deploy_failed` or
`expired`. The message names the deploy id. Diagnose:

```sh
keel deploys <id> --log
keel versions --json          # the CI run link for ci_failed
keel logs -s <scope> --since 15m
```

With `--rollback-on-failure`, `details.deploy` is the failed deploy and
`details.rollback` the redeploy of the previous version (`deployed` when it
worked). The scope runs the old version again; the new one still failed.

### `unauthorized` (29)

keel rejected the personal token (revoked, mistyped) or the server requires
one (`KEEL_API_AUTH=required`) and none was sent. The person creates a token
in the keel admin, «Tokens de API», and runs `keel login --token` (or
exports `KEEL_TOKEN`) in their own terminal. Never ask them to paste it.

### `cancelled` (30)

A person answered no to a confirmation, or waiting was interrupted. After an
interrupted `--wait` the deploy keeps going on the server: check
`keel deploys <id>`.

## Exit codes of `doctor`

`keel doctor` exits 0 when everything answers, 10 when the network fails and
2 when configuration or a key is missing.

### `locked` (31)

The scope was frozen with `keel lock`, or a scheduled freeze window of the
app or the organization is active; the message says which, until when and
why. Report it and stop. Unlocking (`keel unlock -s <scope>`) or forcing a
window (`keel deploy --force-freeze <reason>`) is the person's decision,
never a workaround.

### `forbidden` (33)

keel knows who you are, but your role doesn't allow that action on that app
or scope (roles: viewer < publisher < deployer < maintainer < admin, and they
can differ per app and scope). `keel whoami` shows the role and the grants
per app and scope.
Report it and stop: a keel admin grants access, never retry with another
token or scope.

### `missing_input` (32)

keel needed a value it would ask at a terminal and there is none: `-s`
(`--scope`),
`-v`/`-r`/`-l`, `-y`, `-m`, `--org`… Add the flag; ask the person for its
value if the conversation does not give it.
