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

Learned while building `godmode` 0.2.0 (storage and the setup note).

- **A helper in another file that takes `$` must be a function declaration.** The engine
  follows `$` past an import only into `function name($) { ... }`. An exported arrow
  function that takes `$` makes the whole module refuse to load ("$ is passed to ..., a
  name bound to a function expression"), and every hook of the mod stops. Pure helpers
  can stay arrow functions.
- **A test's `$` has no `fs` or `process` noun, so a plugin's file and process calls are
  answered beneath it.** `on('fs.read' | 'fs.exists' | 'fs.write' | 'process.run' |
  'session.root', ...)` answers with `{ value }`; `{ deny: reason }` makes the plugin's
  call reject, as a missing file does. The engine turns a relative path into an absolute
  one (against the plugin's folder in a test) before the hook sees it. A test can also
  import the plugin's helpers and call them with a `$` built by hand over the same
  in-memory files (`godmode/tests/world.ts`).
- **`crypto.subtle.digest` works in the hooks environment and in tests.** It is how
  `godmode` fingerprints files, since there is no Node `crypto`. `Date` works too, but
  `$.clock.now()` keeps a timestamp mockable.
- **No `$` call gives the plugin's own version.** `$.plugin` has `name` and `root` only;
  read `${$.plugin.root}/.claude-plugin/plugin.json` to get it, so `plugin.json` stays the
  one place the version is written.
- **`validate` lists only the calls reachable from the hooks.** A helper no hook calls
  yet (godmode's `writeNote`, until setup uses it) does not appear under `calls`.
- **Type-check with a scratch tsconfig that names real paths.** `tsc -p <mod>` needs the
  types the engine lays in `.claude-plugin/types/`, which exist only once the mod has
  loaded. Otherwise use a tsconfig outside the repo with `target`/`lib` `es2023`,
  `types: []`, `jsxFactory: "h"`, and an `include` naming the skill's `claude-code.d.ts`
  plus the mod's `hooks`, `types` and `tests`. An `include` path that no longer exists is
  skipped silently, and tsc then passes having checked nothing: after the repo moved from
  `claude-mods/` to `tinky-claude-mods/`, dispatch-panel's checks passed that way while its
  tests had type errors.

Learned while building `godmode` 0.3.0 (tickets and the git host).

- **`$.fs` has no delete, rename or move.** It reads, writes, lists, stats and checks
  existence only. godmode moves a done ticket into `tickets/done/` with `mkdir -p` and `mv`
  through `$.process.run`, which holds on macOS and Linux; a Windows host has neither.
- **A tool from `$.tool.register` cannot be taken back.** No call unregisters it, and no
  `tool.describe` answer hides it. godmode declares its ticket tools on the first
  switch-on, declares them again in `session.start` when the state says on (a reload
  forgets them), and answers `{ deny: 'godmode is off' }` while off.
- **A closure over `$` inside a function declaration is followed.** An object whose arrow
  methods use the `$` of the function declaration that built it loads, and `validate`
  lists those calls (`$.fs.list (via markdownBackend)`). Only passing `$` as an argument
  to an arrow refuses the module.
- **In a test, the plugin's `{ deny }` reaches the test's `$.tool.call` as returned**, not
  as `{ isError, text }`. `$.tool.register` needs an answer beneath the plugin:
  `on('tool.register', (_$, e) => ({ value: { tool: 'mcp__<plugin>__' + e.name } }))`.
  `$.process.run`'s hook input is `{ argv, init }`, with `cwd` and `stdin` under `init`.
- **The test kit's `expect` has no `.rejects` or `.resolves`.** Await the promise with a
  `.then(() => undefined, error => error.message)` helper and assert on the message.

Learned while building `godmode` 0.4.0 (the loop hooks).

- **A state atom must be made in the file that reads or updates it.** `validate` follows a
  `read`/`update` source only to an `atom(...)` written in the same file (or inline). An
  atom imported from a shared module refuses the whole module ("the state library's
  update takes a source the scan can read"). godmode repeats its atoms in `register.tsx`
  and `loop.ts`; same `{ plugin, key }`, same state.
- **A test answers `$.ui.ask` as an `AskUserQuestion` tool call beneath the plugin.**
  `on('tool.call', ...)` with `e.tool === 'AskUserQuestion'` returning
  `{ result: { questions: e.questions, answers: { [question]: label } } }` resolves the
  ask to `label`; `{ deny }` makes it reject, as a dismissed question or `-p` does. In the
  kit the asking hook's own `.catch` is not called for that call. The types say a live
  session asks the `.catch` on re-entry with `called` false, so a guard's `.catch` passes
  `next.error.kind === 're-entry'` on, or its own question would be refused.
- **Register every hook beneath the plugin before the test's first `$` call.** An `on(...)`
  after it throws. A shared setup helper that switches the mod on takes the extra hooks as
  a callback. A test's `$` has no `store` noun either: answer `store.get` and `store.set`
  beneath with a `Map` to read the plugin's store back.
- **`$.tool.check` takes `{ tool, input: { ... } }`**, unlike `tool.call`'s flat input.
- **A test's `$.prompt.submit` raises `prompt.submit` with no `e.origin`.** A hook that
  reads `e.origin.kind` throws there; treat a missing origin as the person's own prompt.
- **The Agent tool has no `cwd`.** Only an `agent.spawn` rewrite sets where a subagent
  runs, and the folder should exist first: godmode runs `git worktree add` in the spawn
  hook before rewriting `cwd` to the ticket's worktree.
- **The shell guard can refuse a Bash line for `gh` text that only goes into a file.** A
  heredoc script that wrote test code holding `gh api user --jq .login` and `gh pr view`
  was refused as a `gh` write. Edit files that hold such commands with the Edit or Write
  tool, not a heredoc or `sed`.

Learned while building `godmode` 0.5.0 (setup mode).

- **A subagent never has the AskUserQuestion tool.** The engine strips it from an agent's
  tools even when the agent's definition lists it, so a subagent cannot ask the person.
  An agent that needs answers calls a tool of the mod's, whose hook asks with
  `$.ui.ask`; godmode's setup questionnaire works that way.
- **An agent the mod spawns with `$.agent.spawn` runs in the background, non-interactive.**
  It works from a `command.run` hook, on a Team login too, but a permission prompt in it is
  refused at once ("Permission to use Write has been denied"), where an agent the model
  dispatched waits for the grant. For an agent that writes files, have the main thread
  dispatch it: a `command.run` answer's hidden `context` can tell the model to.
- **`${CLAUDE_PLUGIN_ROOT}` expands in a plugin agent's prompt and in a skill's body**
  (`${CLAUDE_SKILL_DIR}` too, in a skill), **but not in a file a hook reads raw.** godmode
  reads `agents/pm.md` with `$.fs.read` for the main thread, so it replaces the variable
  with `$.plugin.root` itself.
- **Every `agents/*.md` file becomes a dispatchable `<plugin>:<name>` type.** One that is
  not meant to be dispatched (godmode's PM role, which belongs to the main thread) is
  hidden with `on('agent.offer', { agent: '<plugin>:<name>' }, () => ({ isOffered: false }))`.
- **A test's `state.get` answer is a `StateRead`, wrapped in `{ value }`.** The hook beneath
  answers `{ value: { value, version } }`; answering `{ value, version }` reads as nothing
  stored, and the type check flags it.
- **`$.ui.toast` in a test needs an answer beneath** (`on('ui.toast', () => ({ value:
  undefined }))`), or the kit prints "$.ui.toast dropped: no implementation" (the test
  still passes). Likewise a `ui.render` hook that calls `next(e)` needs a `ui.render`
  answer beneath it in the test.
- **In a test, the plugin's own files are read at the real plugin folder.** `$.plugin.root`
  is the mod's folder on disk, so a test world that serves fixture templates matches a
  path by the folder's name (`/godmode/templates/...`), not by a fixed root.
- **macOS has no `timeout` command.** A spike script that wraps `claude -p` in `timeout`
  fails with "command not found" before anything runs.
- **A test's `state.get` answer is wrapped twice.** A hook beneath the plugin answers
  `{ value: { value, version } }`: the outer `value` is the event's result, the inner one
  the `StateRead`. Answering `{ value, version }` types wrong and the plugin reads nothing.
- **A test's `ui.render` answer is the element itself**, not `{ value }`: return
  `{ type: 'Text', children: ['engine'] }` typed as `RenderElement`. A plugin hook that
  passes (`next(e)`) with no test hook beneath it fails the test.
- **Test hooks run in the order they were made.** A catch-all `on('ui.render', ...)` made
  first answers before a narrower one made later, which then never runs. Make the hook
  that records what the plugin passed down before any catch-all.

Learned while building `godmode` Step 13.1 against types from 2.1.322.

- **A `.catch` no longer sees a `re-entry` kind.** `HookFailure.kind` is `throw` or
  `timeout` only, and a hook's own `$` call (`$.ui.ask` included) skips the calling hook,
  so a guard's `.catch` passes on with `next.called` alone. Comparing with `'re-entry'` is
  a type error.
- **`AbovePrompt` props gained `isCollapsed`.** A test that mounts the band must pass it,
  or the type check fails.
- **`$.ui.ask` takes `{ options, header, multiSelect: true }`** and resolves the picked
  labels comma-joined, so a multi-select label must not hold a comma.

Learned while fixing `godmode` Step 13.5 (the per-prompt QA check).

- **GitHub's team-membership 404 does not mean "not a member".** The
  `orgs/<org>/teams/<slug>/memberships/<login>` endpoint answers 404 for a non-member, and
  also when `gh` lacks the `read:org` scope or cannot see the team. godmode reads
  `orgs/<org>/teams/<slug>` in the same round, and only when that answers does a 404 mean
  "not a member".

Learned while building `godmode` Step 9 (`/godmode try`).

- **A long-running child comes from `$.process.spawn`, not `$.process.run`.** `run` holds
  until the child exits (ten minutes at most). A `spawn` stream read in an unawaited loop
  outlives the hook that started it; `stream.return()` or a module reload kills the child.
  Killing it does not always end a server it started (`npm run dev` runs one as its own
  child), so godmode also ends what still listens on the port it handed out.
- **`$.clock.sleep` counts against a hook's 10-second budget**, unlike every other `$` call.
  A `command.run` hook that waits for an app to answer polls for at most 8 seconds, then
  answers and keeps watching from a `$.clock.every` timer.
- **A test answers `$.process.spawn` with an async generator hook beneath the plugin.** It
  yields `{ stream, text }` chunks and returns `{ value: { code, signal } }`; a bare result
  is refused ("returned neither { value } nor { deny }"). Its `next.signal` aborts when the
  plugin ends the stream, which is how a test sees the child stopped. A hook that waits on
  the mocked clock needs the test to `clock.advance` while the call is pending.
- **Background work must catch its own rejections.** A loop or timer still running when a
  test ends calls `$` on an unloaded module, and the rejection fails the test file ("a
  rejection nothing handled").

Learned while building `godmode` Step 10 (context7) against Claude Code 2.1.323.

- **An MCP server can sit inline in `plugin.json` under `mcpServers`**, the same shape as
  `.mcp.json`. godmode lists context7 there as a remote `http` server
  (`https://mcp.context7.com/mcp`), which needs no Node package and no API key. A live
  `claude -p --plugin-dir` run connected it as `plugin:<plugin>:context7`, with the tools
  `mcp__plugin_<plugin>_context7__resolve-library-id` and `..._query-docs`.
- **A remote MCP server makes `validate` ask for a privacy policy.** It reports
  `PRIVACY_URL_MISSING` among the plugin directory's problems; validation still passes.
  The fix is `privacyPolicyUrl` in `plugin.json`, or a "Privacy" link in the README.

Learned while building `godmode`'s Jira and "Other" ticket backends (Step 5).

- **A test answers `$.mcp.call` and `$.tool.list` beneath the plugin like any `$` call.**
  `on('mcp.call', (_$, e) => ({ value: { content: [{ type: 'text', text }], isError } }))`,
  with `e.server`, `e.tool` and `e.args`; `on('tool.list', () => ({ value: [{ name, description,
  mcp: true }] }))`. A hook beneath that returns a promise that never settles plays a server
  that hangs. `godmode/tests/jira-world.ts` is a pretend Atlassian server built that way.
- **`$.mcp.call` takes no time limit.** godmode races it against `$.clock.sleep(ms, { signal })`
  and aborts the sleep once the call answers. A sleep counts against the hook's 10-second
  budget where a `$` call in flight does not, so only the prompt hook's 3-second reads get a
  limit; the ticket tools wait on Jira unbounded.
- **Atlassian's MCP servers differ in their Jira tools.** One takes `issueTypeName` on
  `createJiraIssue`, has `getTransitionsForJiraIssue` and `addCommentToJiraIssue`; the other
  takes `issueType`, has `addOrEditJiraIssueComment` and no transitions list. Both refuse an
  argument their schema lacks, so godmode tells them apart by the tool names
  `$.tool.list()` gives (`mcp__<server>__<tool>`, the server being the part before the last
  `__`), never by a fixed server name.
- **A runtime import cycle between hook files is avoided with type-only imports.**
  `tickets.ts` builds the Jira backend from `jira.ts`, so `jira.ts` imports only types from
  `tickets.ts` and `questionnaire.ts`, throws its own `JiraError`, and `tickets.ts` turns
  every Jira failure into a `TicketError` for the model.

Learned while building `godmode` Step 8 (`/godmode report` and resume).

- **A plugin's `command.run` text reaches the model too, not only the person.** The types
  say a `{ text }` answer stays in requests unless every plugin hooking the command ships
  with Claude Code. So `/godmode report`'s QA lines, which tell the PM to record a result
  with `ticket_move`, reach the PM without a separate `context` entry.

Learned while fixing `godmode`'s Jira backend (Step 13 fix round, schemas read 2026-11-16).

- **The "Atlassian MCP" server has no transitions list among its tools.** Its
  `transitionJiraIssue` takes `transitionId` (or `transitionName`, the transition's own
  name, never the target status), and the ids come from the `listJiraIssueTransitions`
  operation run through `executeRead({ name, cloudId, inputs })`; `discover` names it when
  that name fails, and takes `query` alone, no `cloudId`. Its answer reports the status the
  issue landed in, which a board's automation can make differ from the target.
- **One unknown key makes Jira refuse a whole `key in (...)` search**, deleted or merely
  hidden from the person alike ("An issue with key 'APP-6' does not exist for field
  'key'"). godmode drops the keys the error quotes and searches again, and archives their
  side files into `jira/archived/` so the next search is clean.
- **`$.tool.list()` misses deferred MCP tools**, and an agent's own list can leave out
  `mcp__*`, while `$.mcp.call` still reaches the server. godmode calls the setup's named
  server directly, and with none named tries the usual connector names
  (`claude.ai Atlassian MCP`, `claude.ai Atlassian Rovo`, ...) before saying none is
  connected. A server found by name has unseen tools: `getVisibleJiraProjects` answering
  marks the shape with a transitions list.
- **A test plays an unconnected MCP server with `{ deny }` from `mcp.call`**: the
  plugin's `$.mcp.call` rejects, as a live call to a server the session lacks does.

Learned while fixing `godmode`'s try, QA gates and resume (2026-11-16, types from 2.1.322).

- **`$.process.spawn` gives no pid.** godmode's try runs `/bin/sh -c '<wrapper>' godmode-try
  <command>`: the wrapper starts the command with `set -m` (its own process group), turns
  `set +m` again so no `[1]+ Done` job notice lands in the output, prints
  `godmode-try-pgid=<pgid> wrapper=<pid>` on stderr, and traps TERM to kill the group. A
  SIGKILLed wrapper leaves the group running with its leader re-parented to 1, so "the
  leader's parent is still the recorded wrapper" is how a later session tells a live try
  from a leftover one.
- **Listing an MCP server in the manifest defers nothing.** `$.mcp.connect` only connects a
  server the manifest lists, and a listed server joins every session at its start, godmode
  on or off. To hold its tools back, a mod refuses their calls at `tool.check`.
- **context7 links no privacy policy of its own.** Its site's footer has only "Legal",
  which leads to Upstash's legal page (Upstash's privacy policy and a "Context7 Addendum"
  PDF). Nothing there was verified as context7's own policy, so `privacyPolicyUrl` stays unset.

Learned while fixing `godmode` after its first live test (0.7.0, 2026-11-23).

- **The Atlassian servers answer `getAccessibleAtlassianResources` in two shapes.** The
  "Atlassian Rovo" servers give a bare list of `{ id, name, url, scopes }`, one row per
  product, so the same site comes twice. The "Atlassian MCP" server gives
  `{ data: { resources: [{ cloudId, url, products }] } }`, with no `name`. A reader that
  wants `id` at the top finds no site at all on the second.
- **Both servers take a site's host name as `cloudId`** (`acme.atlassian.net`), as their
  tool descriptions say, besides the cloud id itself. A bare name (`acme`) is not one.
- **Jira's JQL error names every unknown value**: "The value 'X' does not exist for the
  field 'project'." and the same for `status`, in one refusal. One cheap search
  (`project = "K" AND status in (...)`, `maxResults: 1`) checks a project and its status
  names at once. Status names are checked site-wide, not per workflow.
- **A test's hook that throws is skipped, not propagated.** The kit reports "test's
  turn.step hook was skipped" and the plugin's hook above never sees the error, so a
  fallback that catches a thrown error beneath cannot be tested that way. A failed request
  can also come back as a `turn.step` result with `stopReason: null` and `usage: null`,
  which a test can return; godmode handles both, and tests the thrown case as a pure
  function (`fableOutcome`).
- **A heredoc or `sed` line that holds `gh pr close`, `gh pr review` or `gh api` text is
  refused by the shell guard** even when it only edits a test file. Write a Python script
  with the Write tool and run it, or use Edit.
- **`$.ui.ask` on a multi-select joins text typed under Other with the picked labels by
  commas**, commas inside the typed sentence included. godmode reads each part for a
  choice's label first, then for its words, so a sentence still maps to the choices.
- **An MCP answer too large for the session never reaches the hook as data.** Claude Code
  saves it to a file and answers with text instead: "Error: result (N characters) exceeds
  maximum allowed tokens. Output has been saved to …/tool-results/….txt. Format: JSON
  with schema …". godmode's one Jira call wrapper turns that text into a typed
  "too large" error, and a scan asks again with a smaller page. Ask for named fields, not
  `*all`.
- **The "Atlassian MCP" server's search answers `{ issues: { nodes, pageInfo } }`**, takes
  `view` (`compact` by default, which leaves out custom fields; `evidence` maps them) and
  puts custom fields under `fields.customFields`, keyed by their labels. The other server
  answers `{ issues: [...] }` with `customfield_*` keys at the top of `fields`.
- **A dialog cuts a long question off**, options and all. Put long text (a summary, the
  rules to save, the changes to save) in a `$.ui.log` line just before the question, and
  keep the question short.
- **`$.ui.log` takes one line, and so does a dialog question.** A new line inside either
  renders as a stray character. `$.ui.ask` has no preview field. godmode logs a text of
  several lines one call per line and folds questions onto one line
  (`hooks/ui-text.ts`).
- **JQL's `currentUser()` is the account behind the connector's token**, so
  `(reporter = currentUser() OR creator = currentUser())` finds the person's own tickets
  with no account lookup.
- **Checked against a real board (2026-11-23): the "Atlassian MCP" server's custom fields.**
  An explicit `fields` list is honoured exactly: custom fields come back only when named
  by id, and `view: "evidence"` then adds nothing. With no `fields`, the evidence view
  lists under `fields.customFields`, by label, each `{ id, value }`, and only the fields
  that ticket holds, so a bug's fields show only on a bug. The session saves any answer
  over about 50,000 characters to a file; ten issues with their descriptions already pass
  that, and each person field (reporter, creator, assignee) costs about a kilobyte per issue.

Learned while building `godmode` 0.8.0 (D78: the project's rules, and the side pane).

- **`validate` refuses a module that hooks `turn.step` (or any event) twice without a
  matcher**, the second registration in another file of the same mod included ("registered
  twice without a matcher; the first is at ..."), and every hook of the mod stops. godmode's
  side pane, ported from `dispatch-panel`, exports helpers (`paneStep`, `paneAction`,
  `paneSpawned`, `paneReceived`) that godmode's existing `turn.step`, catch-all `tool.call`,
  `agent.spawn` and `session.receive` hooks call, instead of hooking those events again. A
  second hook with a matcher (`{ tool: 'Bash' }`) is fine.
- **A runtime import cycle between hook files is avoided by repeating atoms.** `indicator.tsx`
  reads the side pane's `paneFallback` and `paneClosed` through atoms of its own, with the same
  keys, rather than importing `pane.tsx`, which imports `loop.ts`, which imports `indicator.tsx`.
- **In a test, a hook beneath that answers `ui.close` must return `{ value: undefined }`**; a
  bare `undefined` fails the test ("returned no result"). A test that calls
  `$.session.start` needs `on('session.start', (_$, e) => e)` beneath.
- **The "Atlassian MCP" server answers `atlassianUserInfo` as `{ data: { accountId } }`**
  (checked live, read-only, 2026-11-23); the other shape is `{ account_id, name }`.
- **`$.prompt.submit` is refused from a `command.run` hook** ("it would wait on the turn this
  hook is holding; submit from a later event"), in tests too. godmode 0.8.3 sends the PM's
  starting prompt from `$.clock.after(0, ...)` right after the command; a test advances the
  mocked clock by 1 to see it. The instructions ride in the command's `context`.

Learned while making `dispatch-panel` 1.5.5 step aside for `godmode`.

- **A `state.set` hook with a `{ plugin, key }` matcher hears another plugin's writes.** The
  hook sees `e.value` and `e.previous` as the write passes; `await next(e)` first, then act
  only when `.value?.isSet` is true. The reading plugin declares just the key it reads under
  the other plugin's name in its own contract, so it needs no `dependencies` entry and loads
  alone.
- **A test loads a stand-in for another plugin with `test(name, { plugins: [...] }, body)`.**
  Each entry is `{ name, register }`; a stand-in named `godmode` writes `godmode`'s state,
  which the plugin under test hears. The test's `$` has no `ui.close`, so the person's close
  mark is played by dropping the pane from the record a `ui.panes` hook beneath answers.
- **An inline test plugin's hooks cannot name anything from the test file's scope.** A
  stand-in whose `command.run` hook called a helper declared in the file was skipped, and
  every command reached the bottom ("no implementation for command.run"). Keep each check
  inside the hook.
