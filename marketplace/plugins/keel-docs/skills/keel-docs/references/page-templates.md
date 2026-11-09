# Page templates

Copy the template, replace every `<placeholder>`, delete the sections that do
not apply. Each one already satisfies keel and the audit script: front matter,
one H1 equal to the title, `##`/`###` only, languages on every fence.

## docs/README.md — the index

````markdown
---
title: <library> documentation
description: <What it is and who it is for, in one sentence.>
library: <library>
---

# <library> documentation

`<library>` is <what it does> for <who uses it>. <Where it fits in
Foundathyon.> These guides are versioned with the code; the snippets are
backed by <the executable examples or tests> in
[`<example file>`](../<example file>).

## Guides

| Step | Guide | Use it for |
| --- | --- | --- |
| 1 | [Getting started](getting-started.md) | <Install, configure, first result.> |
| 2 | [Configuration](configuration.md) | <Every option and its default.> |
| 3 | [<Task>](<task>.md) | <What the reader achieves.> |
| 4 | [Errors](errors.md) | <How failures surface and what to do.> |
| 5 | [Testing](testing.md) | <Testing code that uses this.> |

## Reference

- [API quick reference](reference.md) — <everything at a glance>.

## Maintainers

- [Architecture](architecture.md) — <boundaries and invariants>.
- [Agent guide](../AGENTS.md) — <canonical commands and rules for changes>.
````

## getting-started.md — a tutorial

````markdown
---
title: Getting started
description: <Install <library>, configure it, and <first result>.>
library: <library>
---

# Getting started

This tutorial <what the reader builds>. <One sentence on the one thing to get
right, e.g. create the client once at start-up.>

## 1. Install

```sh
<install command>
```

<How to import or run it; for a private Go module, GOPRIVATE and insteadOf.>

## 2. Configure

```<language>
<minimal configuration, with error handling>
```

<The two or three options that matter first, and their defaults.>

## 3. <First real result>

```<language>
<a complete, runnable snippet>
```

<What happened, and the ownership rule the reader must follow.>

## Next steps

- [Configuration](configuration.md) — <what the reader tunes next>.
- [<Most common task>](<task>.md) — <why>.
````

## A task guide

````markdown
---
title: <Verb phrase: Send JSON and form bodies>
description: <What the reader can do after this page.>
library: <library>
---

# <Verb phrase: Send JSON and form bodies>

Use this when <situation>. <The rule that makes it safe or correct.>

## <First approach>

```<language>
<snippet>
```

<Why it works; what the library does and does not do for you.>

## <Second approach or variation>

| Option | Use when | Default |
| --- | --- | --- |
| `<Name>` | <case> | `<value>` |

> **Warning:** <the mistake people make, and its consequence>.

## See also

- [<Related page>](<related>.md) — <why it is related>.
````

## errors.md

````markdown
---
title: Errors
description: <Tell failures apart and handle each one.>
library: <library>
---

# Errors

<How errors are returned, and the one decision the caller makes.>

## <Error kind>

| Situation | You get | Check with |
| --- | --- | --- |
| <case> | `<Type or code>` | `<errors.As / status / exit code>` |

```<language>
<handling snippet>
```

## What errors never contain

<Secrets, tokens and query values are never rendered — say so, if true.>
````

## reference.md

````markdown
---
title: API quick reference
description: <Configuration, calls, responses and errors at a glance.>
library: <library>
---

# API quick reference

<One sentence: this page summarises; the doc comments in the code are the
full reference (`go doc <module>`).>

## Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `<Field>` | `<type>` | `<default>` | <meaning> |

## <Calls, commands or endpoints>

| <Name> | Does | Returns |
| --- | --- | --- |
| `<Name>` | <what> | <what> |

## Errors

| Error | When |
| --- | --- |
| `<Error>` | <when> |
````

## architecture.md — for maintainers

````markdown
---
title: Architecture
description: The boundaries and invariants behind <library>.
library: <library>
---

# Architecture

<Who this page is for: maintainers changing <library>.>

## Components

| Area | Responsibility |
| --- | --- |
| `<file or package>` | <what it owns> |

## Invariants

- <A rule every change must keep, and why.>

## Decisions

### <Decision>

<Context, the choice, and what it rules out.>
````

## troubleshooting.md

````markdown
---
title: Troubleshooting
description: <Symptoms, their causes, and the fix for each.>
library: <library>
---

# Troubleshooting

## <Symptom as the reader sees it, e.g. "context deadline exceeded">

**Cause:** <why it happens>.

**Fix:** <what to do>.

```sh
<command that confirms or fixes it>
```
````
