# Project map

Where things are in {{projectName}}, and what its words mean. Agents read this to find
their way before they search. Keep it to what a newcomer needs on day one; update it in
the same PR as a change that moves things.

## Layout

| Path | What lives there |
| --- | --- |
| `<path>/` | <one line: what it holds, and what does not belong there> |

## Entry points

- <where the app starts, where requests or commands come in, where jobs run>

## How data flows

<Three to six lines: where data comes from, where it is stored, where it goes out. Name
the files that do each step.>

## Boundaries

- <modules that must not depend on each other, generated code that is never edited by
  hand, vendored code, and the like>

## Glossary

The project's own words, so code, tickets and conversation use the same ones.

| Term | Meaning | In the code |
| --- | --- | --- |
| <term> | <one line> | `<type, module or table name>` |
