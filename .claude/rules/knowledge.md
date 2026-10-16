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
  the Bash `tool.call` result (`backgroundTaskId`). Its end comes from the
  `<task-notification>` row (`<task-id>`, `<status>`) appended to the owner's
  conversation, which `session.append` sees for subagents too. A shell a subagent
  started can stay in `classic.Stop`'s `background_tasks` long after it ended, so
  that list alone left rows active forever.
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
- **Each agent and shell knows who started it.** `agent.spawn` carries
  `parentAgentId`, `$.agent.list()` gives `parentId`, and a Bash `tool.call` carries
  the caller's `agentId`. Each is absent when the main thread started the work.
  `dispatch-panel` uses them to list a dispatched agent's own agents and shells
  inside its card.
- **A finished shell's notice is queued before it is a row.** Between the person's
  turns, the main thread's task notifications wait in the queue
  (`queue-operation` in the transcript) until the next turn. Some are folded into
  that turn without a row of their own, so `session.append` alone misses them.
  `session.receive` sees a delivery as it is queued. A shell whose owning agent has
  ended sends its notice to a queue nobody reads, so `dispatch-panel` ends such a
  shell together with its owner.

Learned while spiking `godmode` against Claude Code 2.1.299 (types from 2.1.295).

- **On a Team-plan login, some events skip the person's own plugins.** The
  organisation's security plugin (`cc-plugin-sec-default`) sits outermost and passes
  `prompt.compose` and `skill.prompt` over every user-tier plugin, `--plugin-dir` ones
  included; `session.append` and `classic.Stop` were passed over too, which
  `dispatch-panel` relies on. The only sign is a debug-log line,
  `<plugin>: <event> bypassed by cc-plugin-sec-default (tier user); beneath runs`.
  `claude plugin validate` warns for `prompt.compose` and `skill.prompt`.
  `prompt.submit`, `command.run`, `tool.call`, `tool.check` and `agent.spawn` still run.
- **A hook adds model-only text through `prompt.submit` or `command.run`, not only
  `prompt.compose`.** `next({ ...e, context: [...] })` at `prompt.submit` attaches
  hidden blocks to each prompt the person sends, which reaches only the main thread. A
  `command.run` answer's `context` is one hidden message recorded after the command.
- **"Ask the person" is a `tool.check` verdict, not a `tool.call` answer.** `tool.call`
  can only answer, rewrite or `{ deny }`. `tool.check` returns
  `{ decision: 'ask', reason }`, and the dialog shows the reason. The mode settles an
  ask: in `auto` mode the classifier answered it and the command ran unasked.
  `bypassPermissions` did not override it. With nobody to ask (`-p`, a background
  subagent) an ask is a denial. To ask the person in every mode, a `tool.call` hook
  awaits `$.ui.ask(question, options)` (the AskUserQuestion dialog), then calls
  `next(e)` or denies. It rejects under `-p`.
- **`tool.check` carries `agentId` too.** A subagent's Bash call raised `tool.call` and
  then `tool.check`, both with the same `agentId`; both lack it on the main thread.
- **A plugin folder ships `skills/`, `agents/` and `.mcp.json` beside its hooks.** They
  load together. The skill is `<plugin>:<name>`, the agent type `<plugin>:<name>`, and an
  MCP tool `mcp__plugin_<plugin>_<server>__<tool>`. `${CLAUDE_PLUGIN_ROOT}` expands in
  `.mcp.json`. `claude plugin validate` does not list them; the debug log does.
- **A tool from `$.tool.register` never meets the permission check.** Its `tool.call`
  hook answers without `next`, so no `tool.check` and no dialog run for it.
- **`agent.spawn` rewrites the brief, the model and the folder.** `next({ ...e, prompt,
  model, cwd })` changes what the subagent gets. `e.model` is the Agent call's own
  parameter, often `undefined`. `e.parentAgentId` is absent when the main thread
  dispatched.
- **`$.process.run(argv, { cwd, env, stdin, timeoutMs })` runs a host command with no
  shell.** It resolves `{ exitCode, stdout, stderr }` for any exit code. The timeout is
  30 seconds by default and ten minutes at most, and each stream is cut at 4 MiB. Git runs
  with the repo's hooks off. `git` and `gh` both ran from a hooks module.
- **A plugin whose `dependencies` are not installed does not load at all.** The debug log
  says `dependency-unsatisfied` and suggests `claude plugin install <dep>`.
  `claude plugin validate` passes it.
- **A test sees the plugin's state through a `state.set` hook.** The test's own
  `on('state.set', (_$, e, next) => ...)` sits beneath the plugin and receives every
  write (`e.key`, `e.value`), so a module without a pane can still be tested. In a test,
  `$.tool.call` does not raise `tool.check`, so a check is tested with `$.tool.check`.
- **`validate` reads a command as the module's own only when its name is a literal.**
  With `name: 'godmode'` in `$.command.register` and `{ command: 'godmode' }` in the
  matcher, it reports `answers its own command`. Through a constant, it reports a gating
  hook without `.catch`.
- **A types contract may not hold `export {}`.** Every top-level `export` must be a type
  or an interface, or `validate` fails.
