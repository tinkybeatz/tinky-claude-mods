# godmode — Step 0 spike results

Run on 2026-10-15 with the `claude` CLI 2.1.299. The API types came from the
`plugin-authoring` skill for build 2.1.295. Line references (`d.ts:N`) point into that
skill's `types/claude-code.d.ts`.

Method: grep the types first. Where they did not settle a question, a throwaway mod
outside the repo was checked with `claude plugin validate`, `claude plugin test` and
headless `claude -p --plugin-dir <mod> --model haiku` runs in a scratch git repo, with
the hooks writing a log file and `--debug-file` capturing the engine's side.

The plan said to record answers in `.claude/rules/knowledge.md`. The non-obvious facts
are there; this file holds the full record. `brainstorm-log.md` and `build-plan.md` are
unchanged. The changes they need are listed at the end.

---

## 1. Can a plugin ship `skills/`, `agents/` and `.mcp.json` next to its hooks module?

**Question.** Do they load together (D2, D40, D41)?

**Answer: yes.** All three loaded alongside the hooks module in one plugin folder:

- `skills/<name>/SKILL.md` becomes the skill `<plugin>:<name>`. The model invoked
  `spike:hello` and read its text.
- `agents/<name>.md` becomes the agent type `<plugin>:<name>`, with frontmatter `model`
  and `tools` honoured. The model dispatched `spike:helper`.
- `.mcp.json` (`{ "mcpServers": { ... } }`) starts its servers when the plugin loads.
  `${CLAUDE_PLUGIN_ROOT}` expands in `args`. The tool appeared as
  `mcp__plugin_<plugin>_<server>__<tool>` and answered.

**Evidence.** Live run: the model reported the skill's codeword, the helper agent's
reply, and `PONG-FROM-SPIKE-MCP` from `mcp__plugin_spike_spikemcp__ping`. Debug log:
`Loaded 1 agents from plugin spike default directory`, `Loaded 1 skills ...`,
`MCP server "plugin:spike:spikemcp": Successfully connected (transport: stdio)`.
`claude plugin validate` reports none of the three, so the debug log is the check.

**Limits.** A `CLAUDE.md` at the plugin root is not loaded as context: `validate` warns
about `godmode/CLAUDE.md` and says to ship context as a skill instead. That file is the
brainstorm's own guide, so the warning is expected for now.

**Consequence.** D2, D40 and D41 hold as planned. Role prompts can be `agents/*.md` or
`$.agent.register` calls; context7 can be one `.mcp.json` entry (Step 10).

## 2. `$.agent.register(spec)`: fields, and the model per dispatch

**Question.** Which fields does an agent type take, and can a dispatch set its own model
(D39, D62)?

**Answer.** `AgentSpec` (`d.ts:446`) is the settings-JSON agent definition plus `name`:
`name`, `description`, `prompt` (the whole system prompt, replacing the session's),
`tools`, `disallowedTools`, `model` (alias, full id or `inherit`), `effort`,
`permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills` (preloaded), `initialPrompt`,
`memory`, `background`, `omitClaudeMd`, and `isolation: 'worktree' | 'remote'`
(`d.ts:528`). `$.agent.register(spec)` (`d.ts:3213`) resolves `{ agent: '<plugin>:<name>' }`
and must be called once the session has bound (in `session.start`).

**The model per dispatch: yes.** The Agent tool takes a `model` parameter, and an
`agent.spawn` hook can rewrite it: `next({ ...e, model })` (`AgentSpawnInput.model`,
`d.ts:303`). `e.model` is the call's own parameter and was `undefined` in every live
dispatch, so a hook that enforces a minimum reads `undefined` as "the agent's own
default".

**Evidence.** Live: `agent.register -> {"agent":"spike:reg"}`; `spike:reg` answered
"Model: Haiku". Kit test: an `agent.spawn` rewrite of `model` reached the hook beneath.

**Consequence.** D62's minimum model per role is enforceable in an `agent.spawn` hook
(raise `e.model` to the floor). `isolation: 'worktree'` and `omitClaudeMd` are worth
weighing for the dev agent in Step 4.

## 3. `prompt.compose`: the PM's role in the main thread's system prompt, only while on

**Question.** Can godmode add the PM's role to the main thread's system prompt only
while it is on (D12, D63)?

**Answer: not on Gael's current login.** The types support it: a `prompt.compose` hook
answers `next(e)`'s `{ sections }` with one more section, `{ id: 'godmode:pm', text,
scope: 'session' }` (`d.ts:4184`, `PromptComposeSection` `d.ts:8382`). But on a Team-plan
login the organisation's security plugin sits outermost and passes `prompt.compose` over
every user-tier plugin, so the hook never runs.

**Evidence.** Live: the section never reached the model, and the hook never logged.
Debug log: `spike: prompt.compose bypassed by cc-plugin-sec-default (tier user); beneath
runs`, with `cc-plugin-sec-default@builtin seated outermost: the organization is team`.
`claude plugin validate` warns: hooks on `prompt.compose` and `skill.prompt` "do not run
in a plugin a person installs where an organization manages Claude Code".

**What works instead (verified).** A `prompt.submit` hook that attaches hidden context,
`next({ ...e, context: [...(e.context ?? []), text] })` (`PromptSubmitResult.context`,
`d.ts:9118`). Live, the model quoted the attached text and named the hook as its source.
`prompt.submit` fires only for prompts the person sends, so it reaches the main thread
and never a subagent. `command.run`'s answer can also carry `context` (`d.ts:1851`): one
hidden message recorded after `/godmode`'s output.

**Not settled.** Whether `prompt.compose` fires for a subagent's system prompt.
`PromptComposeInput` (`d.ts:8321`) carries no `agentId`, so a hook could not tell the
two apart anyway. This could not be run on this login.

**Consequence: changes the plan.** The PM's role reaches the model in two parts: the
full role as `command.run` `context` when `/godmode` switches on, and a short reminder
attached by `prompt.submit` to each prompt while `isOn`. The reminder is sent again on
every turn, so it survives compaction. `prompt.compose` can be added later for logins
where it runs, but nothing may depend on it.

**Side finding, outside godmode.** The same bypass hits `dispatch-panel`'s
`session.append` and `classic.Stop` hooks in every session on this login (debug log:
`dispatch-panel: session.append bypassed by cc-plugin-sec-default`). Its task-notification
and Stop paths are likely not running. That needs its own look; nothing was changed.

## 4. `tool.call`: telling the main thread from agents, and answering "ask me"

**Question.** Can a hook tell the main thread from a subagent, and can it answer deny
or ask (D18, D63)? Can "ask me" be expressed by a hook, or does it need the engine's own
permission prompt?

**Main thread vs subagent: yes.** `tool.call`'s input carries `agentId`
(`AgentLoop`, `d.ts:194`): absent on the main loop, the subagent's id in a subagent.
`tool.check`'s input carries the same `agentId` (`ToolCheckInput`, `d.ts:12812`). Live: a
subagent's Bash call logged `tool.call tool=Bash agentId=a018580cabdcf7619`, then
`tool.check tool=Bash agentId=a018580cabdcf7619`, and the main thread's calls logged no
`agentId`.

**Deny: yes**, from either event. `tool.call` returns `{ deny: reason }`
(`ToolCallResult`, `d.ts:12701`) and the model reads the reason as the tool's error.
`tool.check` returns `{ decision: 'deny', reason }`.

**Ask: yes, in two ways that behave differently.**

1. **`tool.check` → `{ decision: 'ask', reason }`** (`ToolCheckDecision`, `d.ts:12802`;
   `ToolCheckResult`, `d.ts:12859`). `tool.call` itself has no ask: it can only answer,
   rewrite or deny. The ask goes to "the mode's decider". Measured:
   - headless main thread, default mode: refused with
     `Bash needs approval (asked by plugins ..., spike: spike asks the person)`, so the
     dialog would show the hook's reason;
   - `--permission-mode bypassPermissions`: the hook's ask still stood (refused headless);
   - `--permission-mode auto`: **the classifier answered the ask and the command ran**,
     with nobody asked;
   - a background subagent, headless: `Permission to use Bash has been denied.`
2. **A `tool.call` hook that asks the person itself**: `await $.ui.ask(question,
   ['Allow', 'Deny'])` (`d.ts:2430`) opens the engine's AskUserQuestion dialog and
   resolves to the label chosen. The hook then calls `next(e)` or returns `{ deny }`. A
   `$` call in flight does not count against the hook's time budget. It rejects under
   `-p`, so the hook must treat a rejection as a deny. Verified in the test kit (both
   answers); not verified in an interactive session.

**Not settled.** How an ask from a subagent shows in an interactive session (the dialog
in the main view, or a denial while the agent runs in the background). This needs one
interactive check during M1.

**Consequence: changes the plan.** The risk in `build-plan.md` ("presets lean on Claude
Code's own permission settings, which godmode would write per project") goes away:
godmode does not need to write permission settings. Each preset action set to "ask me"
(D13) becomes either a `tool.check` ask, which respects the person's mode (in `auto` the
classifier decides), or a `$.ui.ask` from `tool.call`, which always asks the person. The
second matches "ask me" literally. Which one to use, or a setting between them, is a
question for Gael. D63's thin main thread is a `tool.call` deny on calls with no
`agentId`. Every gating hook needs `.catch(($, e, next) => next.called ? next(e) : { deny })`.

## 5. `$.tool.register`: tools the model can call

**Question.** Can the mod give the model the ticket tools (D24)?

**Answer: yes.** `$.tool.register({ name, description, inputSchema, isDeferred })`
(`d.ts:3051`, `ToolSpec` `d.ts:13117`), called in `session.start`. The model calls it as
`mcp__<plugin>__<name>`; the plugin serves it with a `tool.call` hook on
`{ tool: 'mcp__<plugin>__<name>' }` that returns `{ result }`. `isDeferred: false` puts
the schema in the prompt's tool list instead of behind ToolSearch.

**Evidence.** Live: the model called `mcp__spike__echo` and got `ECHO:x`. Kit test: the
hook's `{ result }` came back from `$.tool.call`.

**Limits.** Because the hook answers without `next`, no `tool.check` and no permission
dialog ever run for such a tool. Any gate on ticket writes is the mod's own. A subagent
whose `tools` list is restricted needs these names in it.

**Consequence.** Step 5 as planned: `mcp__godmode__ticket_create`, `_move`, `_list`,
`_comment` (names to fix in Step 5).

## 6. `$.process.run`: `git` and `gh` from the mod's code

**Question.** Can the mod run `git` and `gh` for the contention sweep and verdict checks
(D38, D47)?

**Answer: yes.** `$.process.run(argv, { cwd, env, stdin, timeoutMs })` (`d.ts:3515`,
`ProcessRunInit` `d.ts:7999`) runs one command with no shell and resolves
`{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`
(`ProcessRunResult`, `d.ts:8026`) for any exit code. It rejects only when the command
cannot start or outlives its timeout.

**Evidence.** Live, from `session.start`: `git rev-list --max-parents=0 HEAD` returned
the scratch repo's first commit (the project identity planned for D20), and
`gh --version` returned `gh version 2.98.0`.

**Limits.** CLI hosts only. Default timeout 30 s, ten minutes at most. Each stream is cut
at 4 MiB. Git runs with the repo's own hooks off. Tests have no processes, so a test
answers `process.run` beneath the plugin.

**Consequence.** As planned. Long sweeps belong in a timer or `session.start`, not in a
gating hook.

## 7. `agent.spawn` rewrite: adding held files and the worktree path to a dev brief

**Question.** Can the mod add the held-files list and the worktree path to a dev
agent's brief (D38)?

**Answer: yes.** An `agent.spawn` hook rewrites `prompt` with
`next({ ...e, prompt: e.prompt + heldFiles })` (`AgentSpawnInput`, `d.ts:264`). It can
also rewrite `cwd` (`d.ts:387`: "A rewrite is where the subagent runs"), `model`,
`description`, `subagentType` and `background`. `parentAgentId` (`d.ts:317`) is absent
when the main thread dispatched.

**Evidence.** Kit test: the rewritten prompt reached the hook beneath. Live: the helper
agent echoed the `HELD: hooks/register.ts` line that only the hook had added.

**Limits.** A failing spawn guard lets the agent start unless it has a `.catch` that
denies. A workflow's agents can only be denied, not rewritten.

**Consequence.** As planned, with one addition: setting `cwd` to the ticket's worktree
in the same hook could make "a dev agent cannot edit outside its worktree" simpler to
enforce.

## 8. Does `dependencies` install a dependency automatically?

**Question.** Note only (D43 made godmode independent of dispatch-panel).

**Answer: not when loaded from a folder.** A `--plugin-dir` plugin whose `plugin.json`
lists an uninstalled dependency does not load at all. The debug log says
`dependency-unsatisfied` and `Dependency "<name>" is not installed — run claude plugin
install <name>`. `claude plugin validate` passes it. Whether `claude plugin install`
pulls dependencies from a marketplace was not tested, because it writes the person's
settings.

**Consequence.** None. godmode lists no dependencies.

---

## Changes the build plan needs (not applied)

1. **Spike 3.** Drop `prompt.compose` as the way the PM's role reaches the model. Use
   `command.run` `context` on switch-on plus a `prompt.submit` reminder while on.
   `skill.prompt` is passed over too, so no step may rely on it.
2. **Spike 4.** Remove the risk that godmode must write Claude Code permission settings.
   Decide with Gael whether "ask me" means the mode's decider (`tool.check`, where the
   `auto` classifier may answer) or always the person (`$.ui.ask` from `tool.call`).
3. **Spike 4.** Add one interactive check in M1: how a subagent's ask shows in a live
   session.
4. **Spike 7.** Consider rewriting a dev agent's `cwd` to its worktree in `agent.spawn`.
5. **Outside godmode.** `dispatch-panel`'s `session.append` and `classic.Stop` hooks are
   passed over on a Team-plan login.
