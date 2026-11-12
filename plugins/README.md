# keel plugins

Foundathyon's skills for coding agents. One repository, one copy of each skill,
installable into **Claude Code**, **Codex** and **GitHub Copilot** — and into
anything else that reads the open [Agent Skills](https://agentskills.io) format,
such as Cursor, Gemini CLI or OpenCode.

## Skills

| Skill | What it does | Version |
| --- | --- | --- |
| [`keel-docs`](keel-docs/skills/keel-docs/SKILL.md) | Writes, extends and audits a repository's `docs/` so it builds with `keel docs` and follows the Foundathyon documentation standard | 0.1.0 |
| [`keel-release`](keel-release/skills/keel-release/SKILL.md) | Cuts a release: proposes the next semantic version from the commits, bumps the version files `.keel` lists, runs the checks and `keel docs --check --strict`, and tags with `keel create-version` — asking before anything is pushed | 0.1.0 |
| [`keel-setup`](keel-setup/skills/keel-setup/SKILL.md) | Prepares a repository for keel releases, or audits one: `.keel` from `keel init`, the Release workflow and keel-api's canonical `report-version.sh` that confirm every version to keel-api, `docs/releases.md`, `dist/` ignored, and the `KEEL_CI_TOKEN` credential — asking before CI or secrets change, and never tagging | 0.1.0 |
| [`keel-cli`](keel-cli/skills/keel-cli/SKILL.md) | Uses the `keel` CLI safely: creates versions and deploys them through keel once CI passes, rolls back, reads deploys, status and redacted logs, and changes Dokploy (env, Compose, mounts, databases, backups) only through plans a person approves — keel scopes deploy through keel, never through Dokploy, and secrets never go on the command line | 0.5.0 |

## Install

### With keel — every agent at once

```bash
keel skills                      # what is offered, and what is installed here
keel skills add keel-docs        # into this repository, for every agent
keel skills add keel-docs -g     # for your user, in every repository
keel skills update               # bring what keel installed up to date
keel skills remove keel-docs
```

Installed into a repository, a skill is committed with the code, so teammates
**and cloud agents** — Codex cloud tasks, the Copilot coding agent — get it too.
keel writes at most two copies, because that is all the agents need:

| Agent | In a repository | For your user |
| --- | --- | --- |
| Claude Code | `.claude/skills/<skill>` | `~/.claude/skills/<skill>` |
| Codex | `.agents/skills/<skill>` | `~/.agents/skills/<skill>` |
| Copilot (CLI, VS Code, coding agent) | `.agents/skills/<skill>` | `~/.agents/skills/<skill>` |

`--agent claude,codex` narrows it down. Each copy carries a `.keel-skill.json`
recording where it came from; keel never overwrites or removes a skill that
lacks one, since somebody wrote that by hand.

keel reads this repository through the GitHub API with the same token as
`keel update`: `KEEL_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, then
`gh auth token`. `--from ./path/to/keel` reads a local checkout
instead — the way to try a skill before publishing it.

### As a plugin, with each agent's own marketplace

The catalogue in [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
is the one file Claude Code, Copilot CLI and Codex all read, and each plugin
carries both a Claude manifest and an [Agent Plugins](https://agent-plugins.org)
`plugin.json`. The marketplace is called `keel`.

```bash
# Claude Code
claude plugin marketplace add reitmas32/keel
claude plugin install keel-docs@keel

# Copilot CLI
copilot plugin marketplace add reitmas32/keel
copilot plugin install keel-docs@keel

# Codex
codex plugin marketplace add reitmas32/keel
codex plugin add keel-docs@keel
```

These clone the repository with your own git credentials, so a private
marketplace needs working GitHub access from git — `gh auth setup-git` sets it
up. In Claude Code, a skill installed this way is invoked as
`/keel-docs:keel-docs`; installed by keel it is plain `/keel-docs`.

To offer the marketplace to everybody who opens a repository, commit this to
its `.claude/settings.json`. Claude Code reads it, and so does Copilot — which
also accepts the same keys in `.github/copilot/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "keel": {
      "source": { "source": "github", "repo": "reitmas32/keel" }
    }
  },
  "enabledPlugins": {
    "keel-docs@keel": true
  }
}
```

## Layout

```text
.claude-plugin/marketplace.json     the catalogue: one entry per plugin
plugins/<plugin>/
  plugin.json                       Agent Plugins 1.0 — Codex, Copilot, VS Code, Cursor
  .claude-plugin/plugin.json        Claude Code
  skills/<skill>/
    SKILL.md                        the skill: frontmatter, then instructions
    references/                     read on demand, so SKILL.md stays short
    scripts/                        run by the agent; standard library only
    assets/                         templates and files copied into repositories as-is
plugins/scripts/validate.py         checks every rule below
plugins/tests/                      tests for the skills' scripts
```

## Adding or changing a skill

[AGENTS.md](AGENTS.md) has the rules, for people and for agents. In short:
one folder per skill, a name that matches its folder, a description that says
what it does *and when to use it*, the version bumped everywhere it appears —
and both checks passing:

```bash
python3 plugins/scripts/validate.py
claude plugin validate . --strict
```

CI runs both, plus the tests, on every pull request.
