# tinky-claude-mods

Gael's Claude Code mods: one repository, one folder per mod. The README lists the mods
and how to load them.

- Load the `plugin-authoring` skill before changing a mod. Its types file is the API
  reference for the running build.
- Every mod folder holds `.claude-plugin/plugin.json`, `hooks/hooks.json`, its hooks
  module, `types/index.d.ts` when it keeps `$.state`, and `tests/*.test.ts`.
- A new mod also gets an entry in `.claude-plugin/marketplace.json` and a row in the
  README's table.
- Before calling a change done, run `claude plugin validate`, `claude plugin test`
  and `tsc -p` in the mod's folder.
- Bump a mod's `version` in its `plugin.json` when its behaviour changes.

Gotchas and the reasons behind them: @.claude/rules/knowledge.md
