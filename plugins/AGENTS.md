# keel plugins agent guide

`plugins/` is the single source of Foundathyon's agent skills. Every skill
here is installed into Claude Code, Codex and GitHub Copilot, by `keel skills`
or by each agent's own plugin marketplace — so a skill has to work in all of
them, and a broken manifest breaks installs for everyone.

## Canonical commands

Run from the repository root:

```sh
python3 plugins/scripts/validate.py  # every manifest and skill rule
python3 -m unittest discover -s plugins/tests  # the skills' own scripts
claude plugin validate . --strict    # Claude Code's view of the marketplace
```

To try a skill for real before merging, install it from this checkout into a
scratch repository:

```sh
keel skills add <skill> --from /path/to/keel
```

## Adding a skill

1. **Pick the plugin.** A plugin is the unit an agent's marketplace installs.
   Give a skill its own plugin unless it belongs with an existing one.
2. **Create the folders.**

   ```text
   plugins/<plugin>/plugin.json
   plugins/<plugin>/.claude-plugin/plugin.json
   plugins/<plugin>/skills/<skill>/SKILL.md
   ```

3. **Write the frontmatter** — only standard fields, so every agent reads it:

   ```yaml
   ---
   name: <skill>          # = its folder: a-z, 0-9, single hyphens, up to 64
   description: <what it does, then "Use when …" — up to 1024 characters>
   metadata:
     version: "0.1.0"
   ---
   ```

   The description is all an agent sees before choosing a skill: say what it
   does and every situation that should trigger it. Prefix names with the area
   (`keel-…`) so they never collide with somebody else's skill.
4. **Write the manifests.** `plugin.json` follows Agent Plugins 1.0 — keep its
   `$schema` exactly as in `plugins/keel-docs/plugin.json`. Both manifests carry
   the same `name`, `version` and `description`.
5. **List the plugin** in `.claude-plugin/marketplace.json`, with a relative
   string `source` (`"./plugins/<plugin>"`), a `category` and the `version`.
   Codex skips any other kind of source.
6. **Validate**, then add the skill to the table in README.md.

## Writing skills that work in every agent

- SKILL.md stays under 500 lines: the steps and the rules. Detail goes in
  `references/`, linked from SKILL.md with a relative path.
- Name bundled files relative to the skill's folder (`<skill-dir>/scripts/x.py`)
  — each agent installs skills somewhere different.
- Scripts use the standard library only (Python 3 or POSIX sh), take `--json`
  when an agent will parse their output, and exit non-zero on failure.
- No agent-specific frontmatter (`allowed-tools`, `context`, `model`…) unless
  the skill truly needs it: other agents ignore it or read it differently.
- No secrets, internal URLs or personal data in a skill: it is copied into many
  repositories.

## Changing a skill

- Bump the version — semantic versioning — in SKILL.md, both plugin manifests
  and the marketplace entry. The validator fails when they disagree.
- A skill's name is its identity everywhere it is installed; renaming one is a
  new skill plus the removal of the old one.
- Keep changes to a skill and its tests in the same pull request.
