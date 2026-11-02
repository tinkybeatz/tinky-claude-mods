# {{projectName}}

{{projectSummary}}

- Stack: {{stack}}
- Base branch: `{{baseBranch}}`. Pull requests on {{gitHost}}; tickets in {{tracker}}.

## Commands

- Install: `{{installCommand}}`
- Build: `{{buildCommand}}`
- Run locally: `{{startCommand}}`
- All tests: `{{testCommand}}`
- One test: `{{singleTestCommand}}`
- Lint: `{{lintCommand}}`
- Format: `{{formatCommand}}`
- Type-check: `{{typecheckCommand}}`

## Conventions

Read the ones your task touches before you start. They win over your habits.

- Coding standards: `{{conventionsDir}}/coding-standards.md`
- Testing rules: `{{conventionsDir}}/testing-rules.md`
- Quality gates, the definition of done: `{{conventionsDir}}/quality-gates.md`
- Git workflow: `{{conventionsDir}}/git-workflow.md`
- Review checklist: `{{conventionsDir}}/review-checklist.md`
- Decisions already made: `{{decisionsLog}}`

## How to work here

- **Say what you assume.** When a request can mean two things, or the code contradicts
  it, stop and ask instead of picking one silently.
- **Read before you write.** Find the code your change touches, its callers and its
  tests, and what the project already has that you can reuse.
- **Make the smallest change that fully does the job.** No option, layer or "for later"
  code nobody asked for. Finish every caller, test and fixture the change reaches.
- **Touch only what the task needs.** No drive-by refactors, renames or reformatting of
  code you were not asked to change. Mention what you noticed instead.
- **Prove it works.** Decide how you will know the task is done before you start, then
  show it: a test seen failing and then passing, a command's real output.
- **Report honestly.** Say what you did not do, did not check, or are unsure of.

## Rules that always hold

- Never commit to `{{baseBranch}}` directly. Every change goes through a pull request.
- Every new test is shown failing without the change first.
- The quality gates pass before a change is called done.
- Comments say only what the code cannot: the reason, a constraint, a known limit. No
  ticket keys, no change history, no TODOs; those belong in the PR or a ticket.
- Never put secrets, tokens or personal data in code, logs, commits or tests.
- {{attributionPolicy}}
