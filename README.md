# tinky-claude-mods

Claude Code mods: plugins that change Claude Code's own interface or behaviour through
function hooks. This repository holds several mods, one folder each.

| Mod | What it does |
| --- | --- |
| [`dispatch-panel`](dispatch-panel/) | A side panel listing dispatched agents and background shells, with their purpose, input and output tokens and duration, in Active and Finished tabs, coloured by what each agent is doing. |

`godmode` (an agentic dev loop for any project) is being built in [`godmode/`](godmode/).
It is not in the marketplace yet.

## Installing on a new machine

The repository is a marketplace (`.claude-plugin/marketplace.json`), so the mods install
from GitHub with no clone.

**1. Add the marketplace.** At a Claude Code prompt:

```
/plugin marketplace add tinkybeatz/tinky-claude-mods
```

**2. Install a mod.** Still at the prompt:

```
/plugin install dispatch-panel@tinky-claude-mods
```

Pick the **user** scope so it loads in every project. The mod runs at once, with no
restart.

Use the `<mod>@tinky-claude-mods` form. `/plugin install dispatch-panel --marketplace …`
is ignored by some versions, which then search the default marketplace and answer
`Plugin "dispatch-panel" not found`.

**3. Use the fullscreen layout, so the panel docks on the right.** Claude Code draws a
panel on the right only in its fullscreen layout, in a window at least 110 columns
wide. Otherwise the panel sits above the input bar. The layout is chosen when Claude Code
starts, so a mod cannot change it. In a normal terminal, run once:

```sh
echo 'export CLAUDE_CODE_NO_FLICKER=1' >> ~/.zshrc
```

(`~/.bashrc` for bash.) Then open a new terminal window and start `claude`. Every new
window keeps the setting. Inside tmux, Claude Code uses the other layout by default, so
start it outside tmux. A window narrower than 110 columns puts the panel back above the
input bar until it is widened.

**4. Updating.** An installed mod runs the copy made when it was installed. To get a newer
version:

```sh
claude plugin update dispatch-panel@tinky-claude-mods
```

Then restart Claude Code (or run `/reload-plugins` in an open session). `/plugin` →
**Installed** also has **Update now**.

### When it does not work

| What you see | Why | Fix |
| --- | --- | --- |
| `/plugin` → **Errors**: `Failed to load hooks from …/hooks.json` … `expected record, received undefined` | This machine's Claude Code has mods switched off, so it reads `hooks.json` in the older hooks format | Run `claude -p "Reply with the single word ok." --model haiku` once so Claude Code refreshes its settings, then quit and restart it. If the error stays, the logged-in account does not have mods yet. `claude update` if the version is old. |
| `Plugin "dispatch-panel" not found in … marketplace` | The marketplace was not added, or the `--marketplace` flag was ignored | Steps 1 and 2 above, with the `@tinky-claude-mods` form. |
| Adding the marketplace is refused | An organization's managed settings restrict marketplaces | An admin has to allow it. |
| The panel is above the input bar | Main-screen layout, tmux, or a narrow window | Step 3. |
| Some features never react (on a work login) | Where an organization manages Claude Code, some hooks of plugins a person installs are skipped | An admin lists the plugins in the managed settings. |

### From a local clone (developing)

To run a mod straight from a clone, so every edit is picked up: add its folder to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Separate
several folders with `:`.

```json
"env": {
  "CLAUDE_CODE_PLUGIN_DIRS": "~/Documents/GAEL/AI/tinky-claude-mods/dispatch-panel"
}
```

New sessions load the mod, and a session reloads it when its files change. A session
that was already running when the setting changed does not pick it up.

For one session only:

```sh
claude --plugin-dir ~/Documents/GAEL/AI/tinky-claude-mods/dispatch-panel
```

Do not install the same mod from the marketplace and from a clone at once.

## dispatch-panel

The panel opens by itself in a terminal at least 144 columns wide, docked on the right in
the fullscreen layout (see step 3 above). Elsewhere, open it with `/dispatches`.

| Command | Effect |
| --- | --- |
| `/dispatches` | Opens the panel. |
| `/dispatches active` / `finished` | Opens the panel on that tab. |
| `/dispatches clear` | Drops finished rows. |
| `/dispatches clear all` | Drops every row, active ones included. |
| `/dispatches width <columns>` | Sets the panel's width, remembered across sessions. |

While the panel has focus, `a` and `f` switch tabs.

In each tab, rows are grouped into an **Agents** section and a **Shells** section; click a
section's header to collapse or expand it.

Only work the main thread started gets a card of its own. An agent or shell that a
dispatched agent started is listed inside that agent's card as an indented line (`├` and
`└`, one step deeper per level), with its own status mark, activity tag (`[shell]` for a
shell) and duration. The card stays in Active while anything in it still runs, and its
token line adds `sub in` and `out`, the tokens of every agent listed inside it. An
agent counts as finished once it hands back its result (the engine marks it `idle`),
and returns to Active if a message wakes it again. A teammate that is `idle` is waiting
for a message, not done, so it stays in Active with a `◌` mark.

Each row's title is its purpose (the description the agent or shell was given), followed by
its activity tag and how long it has run. Below it, an agent's type appears only when it is
not a catch-all one (`general-purpose`, `claude`), such as `Explore` or `Plan`. Agents also
show what they have consumed: `in`, the input tokens of all their requests added up
(cache reads and writes included, since each request sends the whole context again), and
`out`, all the output tokens they have generated.

The panel's footer shows the account's usage limits as bars, one per window the last
API response reported (`Session (5h)`, `Week`, or a gateway's spend limit), each with
the percentage used and the time until it resets. A bar is green, then yellow from 70%
and red from 90%. Off a subscription, or before the first response, no window has a
reading and the footer is hidden.

A running agent's card ends with a strip naming what it is doing right now, read from
its latest tool call: `reading register.tsx`, `running tests`, `committing`,
`updating Jira`, and `thinking` between calls. Shell commands are matched against a
list of known ones (git, gh, test runners, linters, …); any other command shows the
description the agent gave it.

Each agent's colour shows what it is doing, not its type: a `general-purpose` agent
writing code and one updating Jira get different colours. When an agent starts, a small
fast model reads its type, description and the start of its prompt, and picks one
activity (one model call per agent). A description that names its activity outright
("Update PROD-4882 in Jira", "Open a PR for the fix") is coloured at once, with no model
call, and the model cannot overrule it. The card shows that activity's short tag in
brackets after the agent's type, such as `general-purpose [research]`, so two agents
share a colour only when they do the same kind of work. The activities, tags and
colours are in [`dispatch-panel/hooks/kinds.ts`](dispatch-panel/hooks/kinds.ts).

| Activity | Tag | Colour |
| --- | --- | --- |
| writing or changing code | `code` | blue |
| reviewing or testing | `review` | red |
| updating tickets (Jira, issues) | `jira` | cyan |
| git, branches or pull requests | `git` | pink |
| searching or researching | `research` | yellow |
| planning or designing | `plan` | green |
| writing docs or text | `docs` | white |
| configuring or setting up | `setup` | purple |
| analysing data | `data` | lime |
| something else | `other` | orange |

Shells, and agents not classified yet (the first second or so), are slate grey and
have no tag.

A failed row keeps its activity's border and shows a red `✗`.

A background shell's row ends when its completion notification arrives, with the status
that notification reports (done, failed or killed), including shells an agent started.

Known limit: workflow agents are not listed.

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
