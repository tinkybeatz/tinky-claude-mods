# godmode convention templates

The setup agent writes these into a project that has no conventions, and uses them to
fill the gaps of a project that has some. A project with solid conventions keeps its own
files; godmode adapts to them.

- `required/`: every set-up project has these pieces, in its own files or in these.
- `optional/`: setup may skip these. `design-conventions.md` is offered only when the
  project has a user interface.
- `presets/<stack>/`: short per-language notes (`coding.md`, `testing.md`) for the stack
  the scan finds, written next to the conventions in a folder named after the stack and
  pointed to from the coding standards and testing rules. A project with several
  languages gets each one's notes. JavaScript projects use the `typescript` folder.

## Placeholders

Each `{{name}}` is a project fact the setup fills in from its scan or the questionnaire.
When a fact does not exist for the project (no type checker, nothing to start), the
setup removes the line that holds it rather than leaving it blank or writing "n/a".

| Placeholder | What it holds | Example |
| --- | --- | --- |
| `{{projectName}}` | The project's name | `invoice-cli` |
| `{{projectSummary}}` | What it is and who uses it, in one or two sentences | A CLI that turns timesheets into invoices, for freelancers. |
| `{{stack}}` | Languages, frameworks and runtime | Python 3.12, Typer, SQLite |
| `{{installCommand}}` | Installs dependencies | `uv sync` |
| `{{buildCommand}}` | Builds the project | `cargo build` |
| `{{startCommand}}` | Runs the app locally; `{{port}}` inside it takes a free port | `npm run dev -- --port {{port}}` |
| `{{testCommand}}` | Runs the whole test suite | `go test ./...` |
| `{{singleTestCommand}}` | Runs one test file or one test | `pytest tests/test_invoice.py -k totals` |
| `{{lintCommand}}` | Runs the linter | `ruff check .` |
| `{{formatCommand}}` | Formats, or checks the format | `cargo fmt --check` |
| `{{typecheckCommand}}` | Runs the type checker | `tsc --noEmit` |
| `{{gates}}` | The quality gates, in order, as a numbered list of commands | `1. ruff check .` / `2. pytest` |
| `{{testLocation}}` | Where tests live and how they are named | next to the code, `*.test.ts` |
| `{{baseBranch}}` | The branch PRs merge into | `main` |
| `{{branchPrefix}}` | The start of every ticket branch's name | `godmode/` |
| `{{worktreeFolder}}` | Where ticket worktrees go | `../invoice-cli-worktrees` |
| `{{mergeMethod}}` | How PRs land | squash |
| `{{gitHost}}` | Where PRs live | GitHub; or local branches |
| `{{tracker}}` | Where tickets live | markdown tickets kept by godmode; Jira |
| `{{conventionsDir}}` | Folder of the conventions files | `docs/conventions` |
| `{{decisionsLog}}` | Path of the decisions log | `docs/decisions.md` |
| `{{adrDir}}` | Folder of the architecture decision records | `docs/adr` |
| `{{knowledgeFile}}` | Path of the knowledge file | `docs/knowledge.md` |
| `{{attributionPolicy}}` | The project's attribution choice, as one sentence | Commit messages and PR texts carry no AI attribution. |
| `{{languageNotes}}` | A pointer to each stack's `coding.md` preset as written into the project, or its text inline | See `docs/conventions/python/coding.md`. |
| `{{testingNotes}}` | A pointer to each stack's `testing.md` preset as written into the project, or its text inline | See `docs/conventions/python/testing.md`. |
| `{{date}}` | The day setup wrote the file | `2026-10-16` |

## Where each file lands

Defaults for committed storage; the setup agent adapts the paths to the storage mode the
person chose and to files the project already has.

| Template | Lands at |
| --- | --- |
| `required/AGENTS.md` | `AGENTS.md` |
| `required/CLAUDE.md` | `CLAUDE.md` (it imports `AGENTS.md`) |
| `required/coding-standards.md` | `{{conventionsDir}}/coding-standards.md` |
| `required/git-workflow.md` | `{{conventionsDir}}/git-workflow.md` |
| `required/testing-rules.md` | `{{conventionsDir}}/testing-rules.md` |
| `required/quality-gates.md` | `{{conventionsDir}}/quality-gates.md` |
| `required/review-checklist.md` | `{{conventionsDir}}/review-checklist.md` |
| `required/ticket-template.md` | `{{conventionsDir}}/ticket-template.md` |
| `required/pr-template.md` | `.github/pull_request_template.md` on GitHub, else `{{conventionsDir}}/pr-template.md` |
| `required/decisions-log.md` | `{{decisionsLog}}` |
| `optional/project-map.md` | `{{conventionsDir}}/project-map.md` |
| `optional/security-rules.md` | `{{conventionsDir}}/security-rules.md` |
| `optional/knowledge.md` | `{{knowledgeFile}}` |
| `optional/docs-style.md` | `{{conventionsDir}}/docs-style.md` |
| `optional/design-conventions.md` | `{{conventionsDir}}/design-conventions.md` |

## Writing rules for these files

- Every rule is checkable: someone can tell from the code or a run whether it was kept.
- No rule a linter or formatter already enforces; point to the tool instead.
- Short beats complete. Agents read these files on every ticket.
