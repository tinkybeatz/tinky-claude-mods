# Starting points

Each is a shape, not a script: fill it from the project's own files and keep it under
about 60 lines. Remove any line the project has nothing for.

## AGENTS.md: an application

```markdown
# <name>

<What it is and who uses it, in a sentence or two.>

## Stack
- <language and version source, e.g. "Python, version in .python-version">
- <framework, storage, main libraries>
- Layout: `<dir>/` <what>, `<dir>/` <what>

## Why it is built this way
- <the constraint that shapes decisions: compliance, a platform, a budget>

## Commands
- Install: `<command>`
- Run locally: `<command>`
- Tests: `<command>`; one test: `<command>`
- Lint and format: `<command>`
- Type-check: `<command>`

## Conventions
- <checkable convention, e.g. "Database changes only through migrations in `migrations/`">
- More: `<docs path>/coding-standards.md`, `<docs path>/testing-rules.md`

## Always
- <rule that always holds, e.g. "Every change goes through a pull request">
```

## AGENTS.md: a library

```markdown
# <name>

<What it does, for whom, in one line.>

## Stack
- <language>, supports <versions or targets>
- Public API: `<entry file>`; everything else is internal

## Commands
- Build: `<command>`
- Tests: `<command>`
- Docs: `<command>`

## Always
- The public API changes only with a changelog entry and a version bump.
- Every public function has a doc comment with an example.
```

## AGENTS.md: a monorepo

```markdown
# <name>

<What the repository holds.>

## Packages
- `<path>`: <what>. Rules: `<path>/AGENTS.md`

## Commands
- Everything: `<command>`; one package: `<command>`

## Always
- Packages depend on each other only through their public entries.
```

## AGENTS.md: a command-line tool or script collection

```markdown
# <name>

<What it automates.>

## Commands
- Run: `<command>`
- Tests: `<command>`

## Always
- Every command has `--help` text and a non-zero exit code on failure.
- Nothing writes outside the paths given on the command line.
```

## CLAUDE.md

```markdown
# <name>

@AGENTS.md

## Claude Code
- <only what concerns Claude Code: a skill to load, a knowledge file to append to>
```
