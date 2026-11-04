# godmode — build plan

Built from `brainstorm-log.md` (D1–D63, session 1, 2026-10-15), with later decisions
folded in where they change a step: D64–D68 in session 2, and the QA modes of D69–D73 on
2026-11-04 (Step 13). Each step names the decisions it implements. Where the plan and
the log disagree, the log wins.

Target: a Claude Code mod in `tinky-claude-mods/godmode/`, independent of dispatch-panel
(D43), self-contained (D2), working on any stack (D1).

---

## Milestones

| Milestone | What works at the end | Steps |
| --- | --- | --- |
| **M0. Spikes** | Every unverified API assumption is checked | 0 |
| **M1. Minimal loop** | On a set-up toy repo: `/godmode`, markdown tickets, dev and reviewer agents, draft PRs on GitHub, fix rounds, the core hooks | 1, 2, 5, 6, 7 (core) |
| **M2. Setup** | `/godmode` on a fresh repo scans, asks, writes or adopts conventions, and leaves a note | 3, 4 |
| **M3. Full loop** | QA modes, `/godmode try`, Jira and "Other", report, resume, update notice, change-setup | 7 (rest), 13, 5 (Jira, Other), 8, 9, 10, 11 |
| **M4. Ship** | Tests, dogfooding on two unlike repos, README, marketplace entry | 12 |

M1 comes before setup on purpose: the loop is what the conventions serve, so it is
proven first on a repo set up by hand.

## Status (2026-11-04)

- Built: M0 (`spikes.md`), M1 (0.1.0 to 0.4.0) and M2 (0.5.0). The first live test
  (`LIVE-TEST.md`) has not been reported yet.
- D69–D73 replaced QA on or off with four QA modes. M3 gains Step 13, and some parts
  already built change with it: the setup's QA question, the ticket statuses, the merge
  gate, and the PM's and QA agent's briefs.
- The QA modes leave open questions, listed in the log's entry "QA modes: what they
  change, and open questions (2026-11-04)". Step 13 names the ones each part waits on.

## What comes next (M3 order)

Each item says what it waits on. Tests come with each item, not at the end.

0. **13.0** tell the PM the project's QA mode. It waits on nothing, and goes first because
   it fixes a gap 0.5.0 already has.
1. **Spike 10**: can hook code call the Jira tools. It waits on nothing, and its answer
   shapes 13.6 and the Jira backend.
2. **13.1** setup answers and types, and **13.2** the `qa` ticket status. Neither waits
   on the other.
3. **13.3** loop gating per QA mode, after 13.1 and 13.2.
4. **Step 7's rest**: the stop after too many fix rounds (D56), after 13.3, since a
   human QA fail may count towards it (open).
5. **13.4** the PM and QA agent briefs, after 13.3.
6. **13.5** the prompt-hook check, after 13.2; then **13.6** the signals, after 13.3 and
   13.5.
7. **13.7** the staging fix ticket, after 13.6.
8. **Step 5's Jira and Other backends**, after spike 10 and 13.2: they map the `qa`
   status and read the pass status (D70).
9. **Step 8**: `/godmode report` with the tickets waiting on QA (D70), after 13.6; and
   resume, which must not restart a ticket waiting in `qa`.
10. **Step 9**, `/godmode try`. It waits on nothing; bot QA starts the app the same way.
11. **Step 11**, change-setup, after 13.1, so a project can change its QA mode later.
12. **Step 10**, context7. It waits on nothing.

Then M4 (Step 12).

---

## Step 0 — Spikes (verify before building)

Each is a small throwaway mod or a grep in the API types. Record the answers in
`.claude/rules/knowledge.md`.

1. A plugin can ship `skills/`, `agents/` and `.mcp.json` next to its hooks module, and
   they load together (needed by D2, D40, D41).
2. `$.agent.register(spec)`: which fields an agent type takes (prompt, tools, model), and
   whether a spawn's model can be set per dispatch (D39, D62).
3. `prompt.compose`: adding the PM's role to the main thread's system prompt only while
   godmode is on (D12, D63).
4. `tool.call`: telling the main thread (no `agentId`) from agents, and answering with
   deny or ask (D18, D63). Whether "ask me" can be expressed by a hook or needs the
   engine's own permission prompt.
5. `$.tool.register`: tools the model can call, for the ticket tools (D24).
6. `$.process.run`: running `git` and `gh` from the mod's code, for the contention sweep
   and verdict checks (D38, D47).
7. `agent.spawn` rewrite: adding the held-files list and worktree path to a dev brief
   (D38).
8. Whether `dependencies` installs a dependency automatically (no longer needed since
   D43; note the answer only).
9. (Run during Step 3, see `spikes.md`.) Whether a subagent can ask the person, and how
   an agent the mod spawns runs.
10. (For D73, not run yet.) Whether hook code can call the Jira tools: the Atlassian
    connector's tools from a `prompt.submit` hook, for instance through `$.tool.call`,
    and the same for an "Other" tracker reached through a connector. The answer decides
    whether the prompt hook reads a Jira ticket's status itself or tells the PM to check
    it.

## Step 1 — Skeleton (D12, D27, D44, D45, D46)

- `plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts`.
- Commands: `/godmode` (on; no effect when already on), `/godmode setup`, `/godmode off`,
  `/godmode report`, `/godmode try <ticket>`.
- Session state: `isOn`, `mode` (`setup` | `change-setup` | `coding`).
- Switching on is quiet (D46).
- Tests: each command's effect on state.

## Step 2 — Storage and the setup note (D19, D20, D60, D61, D62)

- Three storage modes: committed, in-repo gitignored, outside the repo (`~/.claude/`).
  Gitignored mode adds its paths to `.gitignore`.
- Project identity, so the note is found in every mode (repo's first commit; folder path
  without git — an implementation detail per D20).
- The note: godmode version, answers, storage mode, conventions files and a fingerprint
  of each.
- On `/godmode`: no note means setup mode; a note means coding mode; an edited
  conventions file is re-checked alone; an older godmode version prints the one-line
  update notice (D60).
- Committed mode splits shared and personal files (D61); the shared part holds minimum
  models per role (D62).
- Tests: each mode reads back its own note; fingerprints catch an edit; the version
  notice.

## Step 3 — Setup mode (D3, D8, D9, D14, D15, D18, D23, D29, D32, D34, D54, D59)

- Runs in a **setup agent** (Opus, D33, D39) so the main thread stays clean.
- **Scan first** (D29): language and stack, build, test and start commands, git and git
  host, existing conventions files (`CLAUDE.md`, `AGENTS.md`, `.claude/rules`, standards,
  ADRs), whether there is a runnable UI.
- No git: refuse and offer `git init`; git with no reachable PR host: local branches
  (D54).
- **Questionnaire** (multiple choice, AskUserQuestion): only the gaps, plus permissions
  preset (D18), storage (D19), tracker None / Jira / Other (D23), attribution (D15), QA
  on or off (default on only with a runnable UI, D34). Never asks about reference repos
  (D59). D69 replaces the QA on or off question with four QA modes (Step 13.1).
- **Conventions** (D3, D30, D31, D32): none → write the preset for the scanned stack;
  solid → adopt as they are and fill missing required pieces; weak → show what would
  change and why in a line or two, wait for yes, improve in place.
- Writes the note (step 2).
- **Built in 0.5.0** (see the log's "Step 3, setup mode, as built"): `/godmode` with no
  note tells the PM, through its reply's hidden context, to dispatch `godmode:setup`
  (a mod-spawned agent runs non-interactive, spike 9). The agent works through five
  godmode tools: `setup_scan`, `setup_questionnaire` (asks through `$.ui.ask`, since a
  subagent has no AskUserQuestion), `setup_confirm`, `setup_write_preset`,
  `setup_finish`. The scan is code (`hooks/scan.ts`); the questions are data
  (`hooks/questionnaire.ts`), including `gitHost` when `origin` is not a reachable
  GitHub and the on-indicator (D68). Templates are read by listing `templates/required`,
  `templates/optional` and `templates/presets/<stack>/` at run time; stack notes fill
  `{{languageNotes}}` and `{{testingNotes}}`. The PM's role from `agents/pm.md` reaches
  the main thread as context (D64), and its agent type is hidden.

## Step 4 — Bundled content (D2, D30, D31, D40, D42)

Copied in and generalised; nothing depends on Gael's skills being installed.

- **Role prompts** (`agents/`): PM, dev, reviewer, setup, researcher, QA (D33). From the
  reference loop's agent definitions and PM rules, with every project-specific part
  removed.
- **Convention templates**, required: agent rules (`AGENTS.md` + short `CLAUDE.md`),
  coding standards per language, git workflow (from `multi-claude-workflow.md`), testing
  rules (red-check, extend before adding), quality gates, review checklist (standards +
  spec), ticket template (the reference loop's `write-ticket` shape), PR template, decisions log.
- **Optional templates**: project map and glossary, security rules, knowledge file, docs
  style, design conventions (UI only).
- **Skills** generalised from skills-tinky: `claude-md-architect` (add AGENTS.md support,
  stack-neutral templates), `standard-maker`, `adr-writer`, `change-advisor`;
  `test-writer` made multi-language; the design suite only for UI projects.
- **ponytail** text with its MIT notice; **karpathy-skills** not copied (no licence) —
  godmode's own rules cover the same pitfalls (D42).
- Text rules for judgement work (D38): writing tickets, reviewing, fix-round briefs,
  red-checking, classifying red CI, when to ask Gael, delegating from the main thread.

## Step 5 — Ticket layer (D10, D23, D24, D25, D50)

- Four tools: create, move, list, comment. The PM and agents use only these.
- Backends:
  - **None**: one markdown file per ticket in `tickets/`, ids `T-1`, `T-2`, …, a short
    header (status todo / doing / review / done, blocked by, branch, PR, visible change),
    done tickets moved to `tickets/done/`; list reads headers only. D69 adds a `qa`
    status between review and done (Step 13.2).
  - **Jira**: through the Atlassian connector. It also maps godmode's `qa` status onto
    the board and reads the pass status setup asked for (D70); whether a hook can call
    it is spike 10.
  - **Other**: the mapping found at setup (connector or CLI), saved in the note; if
    unreachable, say what is missing, never fall back silently. The same `qa` status
    and pass status apply.
- Tests: the markdown backend end to end; a fake backend for routing.

## Step 6 — Git host layer (D54, D55)

- PR actions: open draft, review comment, mark ready, merge, list open PRs and their
  files.
- Backends: GitHub through `gh`; Other through the mapping found at setup (`glab`, a
  connector); local branches when no host is reachable (review on the branch, no PR).

## Step 7 — Loop hooks (D35, D36, D37, D38, D47, D48, D53, D56, D58, D62, D63, D66)

Every block says why and what unblocks it; every rule is a setting (D37).

- **Permissions**: the four presets gate tool calls; attribution setting (D15, D18).
  "Ask me" asks the person directly with `$.ui.ask`, never through Claude Code's own
  permission check (D66).
- **Thin main thread** (D63): the PM may talk, use ticket tools, dispatch and run quick
  status checks; heavier work is blocked with "dispatch a researcher or a shell".
- **Dispatch**: only tickets Gael said go for; the PM confirms which it understood
  (D52); agent cap 5 (D58); minimum models (D62).
- **Contention**: the mod lists every open PR's files and adds them to the dev brief
  (D47); an edit to a held file is blocked mid-work (D48); a dev agent cannot edit
  outside its worktree.
- **Flow** (D35): draft PR opened → review starts automatically → fix rounds until
  clean, each re-reviewed at the new commit → QA if the ticket's "visible change" is yes
  → fixes if needed (reviewer re-checks changed lines, QA re-tests what it flagged) →
  ready for Gael. Since D69 this is the `bot` QA mode; the other three modes are in
  Step 13.3.
- **Fix-round limit**: after 3 on one ticket, stop and ask (D56). Whether a human QA
  fail counts is open.
- **Merge**: PRs always drafts; no ready or merge without a clean verdict at the PR's
  current commit; auto-merge off unless Gael says so (D53). In `human-pr`, also no
  ready before QA passes (D69, Step 13.3).
- M1 needs: permissions, thin main thread, dispatch, contention, drafts, review start,
  verdict-at-commit. The rest lands in M3.

## Step 8 — Report, resume, update notice (D44, D57, D60)

- `/godmode report`: setup check, open PRs and their files, tickets ready to build, two
  or three suggested next. Since D70, also the tickets waiting on QA and the latest
  signal for each, read the same way as the prompt-hook check (Step 13.5).
- Resume on `/godmode`: tickets in progress matched with worktrees, branches and PRs;
  one line per resumed ticket. A ticket waiting in `qa` must not restart dev work;
  whether it gets a line, and whether `/godmode` shows QA results at all (D46, D70), is
  open.
- Update notice from the note's version (step 2).

## Step 9 — `/godmode try` (D49)

- Starts the ticket's worktree with the project's start command on a free port and
  gives the link; skipped when the project has nothing to run.
- Bot QA starts the app the same way (the start command, a free port), so the two can
  share that code.

## Step 10 — context7 (D41)

- Shipped as a connection the plugin sets up (pending spike 0.1).

## Step 11 — Change-setup mode (D21, D22)

- `/godmode setup` opens a conversation; the main thread applies the change (e.g. adding
  Jira after two months) to settings and conventions, then updates the note.
- Changing the QA mode or its signals goes through here too (D69). What happens to
  tickets already in `qa` when the mode changes is open.

## Step 12 — Ship

- `claude plugin validate`, `claude plugin test`, `tsc`, per the repo's `CLAUDE.md`.
- Dogfood on two unlike repos: a small non-web project (e.g. a Python CLI) and a web
  app. Then a repo with existing conventions, to exercise adopt and improve-in-place.
  At least one of them runs in a human QA mode, to exercise the wait on QA (D69–D73).
- README section, marketplace entry, version 1.0.0. The README recommends installing
  dispatch-panel too (D43).

## Step 13 — QA modes (D69, D70, D71, D72, D73)

QA is one of four modes per repo, asked at setup: `human-pr`, `human-staging`, `bot` and
`none` (D69). This replaces QA on or off (D34). It is part of M3, in the order under
"What comes next". Each part names the open questions it waits on; they are listed in
the log's entry of 2026-11-04.

0. **Tell the PM the QA mode.** First, and a fix for a gap that exists in 0.5.0: on a
   coding-mode `/godmode` the PM gets `agents/pm.md` but never the project's QA answer,
   so after the setup session it cannot know whether QA is on. Add a "QA mode: X" line
   to the coding-mode context and to the setup report (`register.tsx`, `role.ts`). Until
   13.1 lands, X reads the old on/off answer as `bot` or `none`. Waits on nothing.
1. **Setup answers and types.** Replace the `qa` on/off question with D69's order: human
   QA first, then where the humans test (on the PR or on staging), or else whether a bot
   QA is needed. In the human modes, also ask whether a bot pass runs first (D71) and
   which pass signals to watch besides being told: a ticket moved to the board's pass
   status (its exact name) and a PR approval from named QA people or a team (D70). The
   scan's runnable-UI finding only suggests the defaults. The answers go into the note
   and its types. The mode is shared, since it replaces D61's shared "QA on or off".
   Open: whether the bot pass and the signals are shared or personal.
   **Projects set up before D69 must keep working.** Their note holds `qa: true` or
   `false`; the code reads `true` as `bot` and `false` as `none`, so an update never
   breaks a project, and a test loads a note written by 0.5.0. The update notice (D60)
   then offers the new questions; nothing changes until Gael says yes. Applying them
   needs change-setup (Step 11), so until that is built the notice can only be answered
   by a full setup again.
2. **The `qa` ticket status.** Add `qa` between `review` and `done` in the ticket tools,
   the markdown header and the tools' schemas (D69). A ticket in `qa` stays in
   `tickets/`, not `tickets/done/`, and the default list shows it. Waits on nothing.
3. **Loop gating per mode.** Waits on 1 and 2. After a clean review, and the bot pass
   when it is on:
   - `human-pr`: the ticket moves to `qa`; `gh pr ready` and merge are refused until a
     QA pass is recorded; a fail starts a fix round (D69, D70);
   - `human-staging`: the merge stays allowed on Gael's go (D53), and after it the ticket
     goes to `qa`, not `done` (D69);
   - `bot`: Step 7's flow (D35);
   - `none`: straight to ready.
   Open: how "QA passed" is recorded when Gael says it; whether a pass holds only at the
   PR's commit; whether human QA skips tickets with no visible change; whether a human
   fail counts towards the fix-round limit.
4. **The PM and QA agent briefs.** Waits on 3. `agents/pm.md` gets the flow per mode;
   `agents/qa.md` also covers the pass before the human testers (D71); a text rule says
   what the PM does with the prompt-hook line, including checking Jira itself when the
   hook cannot (D73). Open: whether the bot pass runs again after a human fail.
5. **The prompt-hook check (D73).** Waits on 2. On each prompt, the `prompt.submit` hook
   reads the tickets in `qa` from the ticket store, never from the PM's memory, and adds
   one fresh line per ticket, so compaction cannot lose it. The first version says
   "still waiting" only. Open: which tickets wait when the tracker is Jira or Other (they
   are not on disk), and the cost of a `gh` call per ticket on every prompt.
6. **Signals.** Waits on 3 and 5. Being told by Gael always counts (D70). The hook reads
   what it can reach itself: a PR approval from the named people through `gh`, and a
   markdown ticket's status from disk. A Jira status depends on spike 10: either the
   hook reads it, or its line tells the PM to check (D73). A fail starts a fix round in
   `human-pr`, and part 7 in `human-staging`. Open: how a fail shows through each signal;
   approvals on a draft PR; hosts with no PR approval to read.
7. **The staging fix ticket (D72).** Waits on 2 and 6. A fail after the merge opens a
   new ticket that links the original and carries the tester's reason. Open: whether its
   build starts on its own or waits for Gael's go (D52); whether it goes through QA
   itself; when the original ticket closes.
8. **Tests**, written with each part: the questionnaire for each answer; the `qa` status
   in the markdown backend; the gate per mode (ready refused in `human-pr` without a
   pass, merge allowed in `human-staging`); the prompt line from a ticket store on disk,
   with `gh` answered beneath the plugin; a fail opening a linked ticket.

---

## Risks

- **Hook gaps** (spike 0.4): settled. "Ask me" is expressed by a hook: godmode's
  `tool.call` hook asks the person itself with `$.ui.ask` and never returns a `tool.check`
  "ask", which auto mode could approve without them (D66). godmode writes no Claude Code
  permission settings. Still open: one interactive check of how a subagent's question
  shows in a live session.
- **Content weight**: `senior-dev` is about 39k words; bundle only what the roles read.
- **Stack coverage**: coding standards and test rules need a language-neutral base plus
  per-language notes; start with the languages the dogfood repos use.
- **Thin main thread too strict** (D63): the "couple of files" threshold is a setting to
  tune during dogfooding.
- **A slow prompt** (D73): the QA check runs on every prompt, so each waiting ticket's
  `gh` call adds to the wait before the model answers.
