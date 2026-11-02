# Security rules

Rules every change to {{projectName}} keeps. A reviewer treats a broken rule as a
must-fix finding.

## Secrets

- No secret, token, key or password in code, tests, fixtures, logs, commits or PR texts.
  Secrets come from the environment or the project's secret store.
- A secret that reached a commit is rotated, not just deleted from the next commit.

## Input

- Everything from outside is untrusted: user input, files, request bodies and headers,
  responses from other services, environment variables a user controls.
- It is validated at the boundary, against what is allowed, before use.
- Queries are parameterised. No string-built SQL, shell commands or file paths from
  untrusted input. No evaluation of untrusted text as code.

## Data

- Personal data is collected only when needed, never logged, and never sent to a third
  party the project has not chosen.
- Errors shown to users carry no stack traces, internal paths or other users' data.

## Access

- Every action that reads or changes someone's data checks that the caller may do it, on
  the server side.
- Defaults are closed: a new endpoint, permission or file is private until made public
  on purpose.

## Dependencies

- A new dependency is maintained, widely used, and pinned by the lockfile.
- A known vulnerability in a dependency the change touches is reported in the PR body.

## Project-specific

- <rules for this project's own risks: payments, uploads, multi-tenancy, and so on>
