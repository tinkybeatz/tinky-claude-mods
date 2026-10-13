# tinky-claude-mods

Claude Code mods: plugins that change Claude Code's own interface or behaviour through
function hooks. This repository holds several mods, one folder each.

| Mod | What it does |
| --- | --- |
| [`dispatch-panel`](dispatch-panel/) | A side panel listing dispatched agents and background shells, with their purpose, input and output tokens and duration, in Active and Finished tabs, colour-coded by kind of work. |

## Using a mod

### From this folder, in every session

Add the mod's folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`. Separate several folders with `:`.

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/Documents/GAEL/AI/tinky-claude-mods/dispatch-panel"
}
```

New sessions load the mod, and a session reloads it when its files change. A session
that was already running when the setting changed does not pick it up.

### For one session

```sh
claude --plugin-dir ~/Documents/GAEL/AI/tinky-claude-mods/dispatch-panel
```

### From GitHub

The repository is a marketplace (`.claude-plugin/marketplace.json`), so a mod installs
with one line typed at a Claude Code prompt:

```
/plugin install dispatch-panel --marketplace tinkybeatz/tinky-claude-mods
```

## dispatch-panel

The panel opens by itself in a terminal at least 144 columns wide, docked on the right in
the fullscreen layout. Elsewhere, open it with `/dispatches`.

| Command | Effect |
| --- | --- |
| `/dispatches` | Opens the panel. |
| `/dispatches active` / `finished` | Opens the panel on that tab. |
| `/dispatches clear` | Drops finished rows. |
| `/dispatches width <columns>` | Sets the panel's width, remembered across sessions. |

While the panel has focus, `a` and `f` switch tabs.

Each row shows the agent type (or `bash` for a shell), its purpose, how long it has run, and
for agents `in` (the input tokens of its latest request, so its context now, cache included)
and `out` (all the output tokens it has generated).

Colours come from a fixed table in
[`dispatch-panel/hooks/kinds.ts`](dispatch-panel/hooks/kinds.ts): each agent type belongs
to a group, and each group has one colour. A type missing from the table is drawn white;
add a line to `AGENT_GROUPS` to give it a group.

| Group | Colour | Agent types |
| --- | --- | --- |
| code | blue | `claude`, `general-purpose`, `dev` |
| review | red | `test` |
| explore | yellow | `Explore` |
| plan | green | `Plan` |
| helper | purple | `claude-code-guide`, `statusline-setup` |
| shell | orange | background Bash |
| unknown | white | anything not in the table |

A failed row keeps its group's border and shows a red `✗`.

Known limits: a background shell that exits with an error is still marked done, not
failed, and workflow agents are not listed.

## Developing

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json`, its hooks
module and, when it keeps state, a `types/index.d.ts` contract. From a mod's folder:

```sh
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc -p .` needs the type declarations the engine lays in `.claude-plugin/types/` when it
loads the mod; they are generated, so they are not committed.
