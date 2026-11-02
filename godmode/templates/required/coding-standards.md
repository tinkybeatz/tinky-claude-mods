# Coding standards

How code is written in {{projectName}}. Formatting and the rules a linter can check are
left to `{{formatCommand}}` and `{{lintCommand}}`; this file holds what tools cannot
check.

## Design

- **Reuse first.** Before writing a helper, component or pattern, look for the one the
  project already has, and use it the way the surrounding code does.
- **Fit the structure.** Keep the project's layers, module boundaries and interfaces. A
  change that needs a new structure is a decision for the decisions log, not a side
  effect of a ticket.
- **No speculative code.** No option, parameter, abstraction or extension point without a
  current use. One implementation needs no interface.
- **One job per function or module.** Split by job, never by line count.
- **Dependencies are a decision.** Never add one for what a few lines or the standard
  library can do. A new dependency is named in the PR body with why.

## Correctness

- **Validate at trust boundaries**: user input, files, network responses, environment.
  Inside the boundary, trust your own types.
- **Handle errors where you can act on them.** Never swallow one silently. An error that
  reaches the user says what happened and what to do.
- **No data loss.** Writes that must happen together happen together; nothing is
  deleted or overwritten without the caller knowing.
- **Edge cases are part of the job**: empty, zero, one, many, the last item, time zones,
  encodings, concurrent calls.
- **Fix bugs at the root**, in the shared code, once, not in one caller.

## Readability

- Names say what a thing is or does, in the project's domain words (see the glossary
  when there is one). No abbreviations a newcomer would have to decode.
- Prefer plain, direct code over clever code. A one-liner that needs decoding is not
  short.
- Comments explain only what the code cannot say: why, a constraint, a known limit. A
  shortcut with a known limit says so: `shortcut: <the limit>, <when to upgrade>`.
- No commented-out code, no debugging output, no stray files.

## Language notes

{{languageNotes}}
