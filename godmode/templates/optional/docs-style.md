# Docs style

How documentation in {{projectName}} is written: READMEs, guides, conventions files, PR
bodies and ticket texts.

## Writing

- Plain, everyday English, in full sentences. Short sentences; one idea each.
- Say the point first, then the detail.
- Define a term the first time it appears, with an example.
- Concrete over abstract: a command, a path, a number, an example output.
- Present tense and active voice: "The worker retries three times", not "Retries will be
  attempted".

## Shape

- Headings a reader can scan. Lists for steps and options; prose for reasons.
- Code, commands and paths in backticks. A command block shows a command that runs as
  written.
- Link to the code (`path:line`) instead of copying long snippets that will go stale.

## Keeping docs true

- A change that makes a doc wrong updates the doc in the same PR.
- A doc nobody can keep up to date is deleted, not left to rot.
- Dates are absolute (`2026-10-16`), never "last week".
