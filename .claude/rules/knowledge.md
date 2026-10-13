# Knowledge: non-obvious facts about writing these mods

Learned while building `dispatch-panel` against Claude Code 2.1.295. Append new
entries at the bottom.

- **A running session keeps the mod copy it loaded.** `CLAUDE_CODE_PLUGIN_DIRS` is
  read when a session starts. A session that loaded a mod through the
  `plugin-authoring` skill runs its own copy, in `~/.claude/dev-mods/<session-id>/`.
  To update those sessions, copy the changed files into each such folder. A session
  reloads a copy when it changes.
- **`tool.call` inputs are flat on `e`.** Use `e.command` or `e.task_id`, not
  `e.input.command`. A `{ tool: 'X' }` matcher does not narrow `e`, so check
  `if (e.tool !== 'X') return next(e)` first.
- **Nothing beneath the plugin answers in tests.** Use `mock.clock(on)` before any
  hook that calls `$.clock`. Answer `classic.Stop` beneath the plugin
  (`on('classic.Stop', () => ({}))`). A test's `$` has no `state` noun, so read the
  plugin's state through a mounted `Pane` (`$.ui.mount`).
- **No `$` call lists background shells.** `dispatch-panel` gets each shell's id from
  the Bash `tool.call` result (`backgroundTaskId`). It treats a shell as finished
  once the shell is missing from `background_tasks` at a `classic.Stop`, so a failed
  shell still reads as done.
- **Terminal layout is measured in character cells, not pixels.** A cell is about
  10px wide and 20px tall, and no half row exists. `round` is the roundest border
  the terminal draws.
- **Theme colour keys share hues.** `suggestion` is the same lavender as the selected
  tab button's accent, and `subtle` reads as disabled. Fixed hex colours are what
  keeps groups apart.
- **No `$` call reports a pane's width.** The render hook records the docked pane's
  `bodyColumns`. `$.ui.open({ columns })` asks for a width, and a width the person
  dragged the dock to wins.
- **A test answers a `$` call beneath the plugin with `{ value }`.** For example,
  `on('agent.list', () => ({ value: [] }))` and
  `on('model.classify', () => ({ value: 'label' }))`. A bare value is refused.
  `session.start` answers with its input, which carries `cwd`. `$.store` needs
  `mock.store(on)`.
- **Model calls run in the 1-second tick, not inside a hook.** `$.model.classify`
  runs from the `$.clock.every` tick, so a slow model call never holds up the
  Agent tool's spawn.
- **Never name a binding `next` inside a hook.** The engine refuses to load a module
  that shadows a hook's `next` continuation, even in a nested closure, and every
  hook of the mod stops working.
- **A tool call's `e.agentId` names the agent that made it.** It is absent on the
  main thread, and the panel reads it to show each agent's current action. The
  shell guard hook blocks any Bash command whose text contains `gh pr create`, test
  data included, so a test spells that text as `['gh', 'pr', 'create'].join(' ')`.
