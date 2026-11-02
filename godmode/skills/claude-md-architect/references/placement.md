# Where a rule belongs

## Placement matrix

| Content | Home | Why |
| --- | --- | --- |
| A short rule that always applies | `AGENTS.md` | Read by every agent, every session |
| A Claude Code-only instruction | `CLAUDE.md`, under the `@AGENTS.md` import | Other agents do not need it |
| A rule for one part of the tree | A nested `AGENTS.md`, or a `.claude/rules/` file with `paths:` | Loaded only where it applies |
| A longer convention with examples | A conventions doc, pointed to from `AGENTS.md` | Read when the task needs it |
| A procedure of three or more steps | A skill, or a doc pointed to | Not loaded every session |
| A rule that must never be broken | A hook, a CI check, branch protection, or the tool's settings | Enforced, not hoped for |
| Formatting and lint rules | The formatter's and linter's config | Deterministic |
| A personal preference | `CLAUDE.local.md` or `~/.claude/CLAUDE.md` | Not imposed on the team |
| A fact learned the hard way | The project's knowledge file | Kept out of the always-loaded rules |
| A decision and its reason | The decisions log or an ADR | History, not instruction |
| A code example | A `path:line` pointer | The code stays the source |
| Tool permissions, environment, models | Settings files | Not natural language |

## Anti-patterns

1. **Too long.** Over 200 lines: rules in the middle get ignored and every session pays
   for them. Keep an index of 60 lines or so; move the rest out.
2. **Procedures in the rules file.** Numbered steps belong in a skill or a doc.
3. **Linter territory.** "Two-space indent", "single quotes": replace with the command
   that enforces them.
4. **Long code blocks.** They go stale; point to the file and line instead.
5. **Vague directives.** "Write good code" tells the agent nothing. Rewrite as something
   checkable, or delete.
6. **Narrative paragraphs.** Agents act on bullets. Turn prose into facts and rules.
7. **The same rule in several files.** One copy will drift. Keep the one highest in the
   cascade that covers the scope.
8. **Critical rules buried.** Put never-rules near the top or in a short final section.
9. **Personal preferences in shared files.** Move them to personal files.
10. **Two sources of truth.** `AGENTS.md` and `CLAUDE.md` both holding rules, and
    disagreeing. Make `AGENTS.md` the source and import it.
11. **Hard-coded versions.** "Use Node 20.11" goes stale; point to `.nvmrc`,
    `.tool-versions`, `rust-toolchain.toml` or the manifest instead.
12. **Commands that do not run.** A listed command that fails teaches the agent to
    distrust the file. Check each one.
