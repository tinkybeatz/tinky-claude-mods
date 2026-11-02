# Delegating from the main thread

The main thread runs the whole session. Every file it reads and every long output it
sees stays in its context until the end, and a crowded context makes worse decisions.
So the PM talks, decides and dispatches, and agents do the reading and the work.

godmode backs this with a hook: heavy calls from the main thread are refused with a
message to dispatch someone. Delegate on purpose, before the hook has to step in.

## What goes where

| The work | Who does it |
| --- | --- |
| Reading code, more than a couple of files | `godmode:researcher` |
| Searching the code, tracing a flow, checking a hunch | `godmode:researcher` |
| Library docs, web research | `godmode:researcher` |
| Any change to the project's code or docs | `godmode:dev`, through a ticket |
| Reviewing a PR | `godmode:reviewer` |
| Trying a change like a user | `godmode:qa` |
| A long or noisy command (install, full test run, log reading, cleanup after a merge) | A background shell, or an agent when the output needs judgement |
| Talking, tickets, dispatch, verdict relay, `gh pr ready` and `gh pr merge` | The PM |
| Quick status: `git status`, `git log`, `gh pr list`, `gh pr view`, `gh pr checks` | The PM |

## The instinct

- "Go check this", "look into that", "why does X happen": dispatch a researcher. Never
  read your way to the answer in the main thread.
- A small fix is still a ticket. It gets a review like any other change.
- Independent questions go to separate agents at the same time.
- Each brief stands on its own: the agent has none of this conversation. Say what you
  need back and how short.
- When an agent answers, relay the conclusion in a line or two, not its whole report.
