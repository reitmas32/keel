# Bumping version files

`keel init` records in `.keel` every file that carries the project's version —
`release.version_files`. `keel create-version` checks none of them and changes
none of them, so the release commit has to. For each kind below: what to edit,
and how to bring its lockfile along.

After editing, re-run `scripts/release_plan.py`: every file must show the new
version before the release commit is made.

## Cargo.toml (Rust)

- Edit `version` in `[package]` — the first `version = "…"` line of the file,
  not a dependency's.
- A workspace member that says `version.workspace = true` takes it from
  `[workspace.package]` in the root `Cargo.toml`: edit it there.
- Refresh the lockfile, workspace members only:

  ```sh
  cargo update --workspace
  ```

- keel-cli's own release workflow refuses a tag that does not match
  `Cargo.toml`, and `scripts/release.sh` there does this bump for you — use it
  in that repository.

## package.json (Node)

Let npm write both files, without its own commit or tag — keel tags:

```sh
npm version <version> --no-git-tag-version
```

With pnpm or yarn, edit `"version"` in `package.json` and run the package
manager's install so its lockfile agrees. In a workspace, bump only the
packages being released.

## pyproject.toml (Python)

- `[project]` → `version = "…"` (PEP 621), or `[tool.poetry]` → `version`.
- `dynamic = ["version"]` means a build plugin (setuptools-scm, hatch-vcs…)
  reads the version from the git tag: edit nothing — the tag is the version.
- `uv.lock` records the project's own version: run `uv lock`. `poetry.lock`
  does not.

## composer.json (PHP)

The `version` field is optional and usually absent: Packagist reads the tag.
When it is there, edit it; `composer.lock` does not record the root package's
version.

## VERSION

The whole file is the version: one line, `1.4.0`, and a trailing newline.

## go.mod (Go)

There is no version field: the tag is the version, so a Go library's release
commit usually does not exist and the tag goes on HEAD.

- From v2 on, the module path must end in `/v2` (`/v3`…), and every import of
  the module changes with it. Never fold that into a release — it is its own,
  breaking change.
- Consumers update with `go get <module>@v<version>`. For a private module
  they need `GOPRIVATE=github.com/fundathyon/*` and git access to it.

## Everything else that repeats the version

The version often appears where no tool looks: install snippets in a README
(`KEEL_VERSION=v0.1.0`), Dockerfiles, Helm charts, docs examples. Search for
the old version:

```sh
git grep -n -F "<old version>"
```

Show the user the hits and ask which should change. An example that pins an
older version on purpose is not a mistake.
