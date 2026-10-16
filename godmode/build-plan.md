# godmode — build plan

Built from `brainstorm-log.md` (D1–D63, session 1, 2026-10-15). Each step names the
decisions it implements. Where the plan and the log disagree, the log wins.

Target: a Claude Code mod in `tinky-claude-mods/godmode/`, independent of dispatch-panel
(D43), self-contained (D2), working on any stack (D1).

---

## Milestones

| Milestone | What works at the end | Steps |
| --- | --- | --- |
| **M0. Spikes** | Every unverified API assumption is checked | 0 |
| **M1. Minimal loop** | On a set-up toy repo: `/godmode`, markdown tickets, dev and reviewer agents, draft PRs on GitHub, fix rounds, the core hooks | 1, 2, 5, 6, 7 (core) |
| **M2. Setup** | `/godmode` on a fresh repo scans, asks, writes or adopts conventions, and leaves a note | 3, 4 |
| **M3. Full loop** | QA, `/godmode try`, Jira and "Other", report, resume, update notice, change-setup | 7 (rest), 8, 9, 10, 11 |
| **M4. Ship** | Tests, dogfooding on two unlike repos, README, marketplace entry | 12 |

M1 comes before setup on purpose: the loop is what the conventions serve, so it is
proven first on a repo set up by hand.

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
  (D59).
- **Conventions** (D3, D30, D31, D32): none → write the preset for the scanned stack;
  solid → adopt as they are and fill missing required pieces; weak → show what would
  change and why in a line or two, wait for yes, improve in place.
- Writes the note (step 2).

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
    done tickets moved to `tickets/done/`; list reads headers only.
  - **Jira**: through the Atlassian connector.
  - **Other**: the mapping found at setup (connector or CLI), saved in the note; if
    unreachable, say what is missing, never fall back silently.
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
  ready for Gael.
- **Fix-round limit**: after 3 on one ticket, stop and ask (D56).
- **Merge**: PRs always drafts; no ready or merge without a clean verdict at the PR's
  current commit; auto-merge off unless Gael says so (D53).
- M1 needs: permissions, thin main thread, dispatch, contention, drafts, review start,
  verdict-at-commit. The rest lands in M3.

## Step 8 — Report, resume, update notice (D44, D57, D60)

- `/godmode report`: setup check, open PRs and their files, tickets ready to build, two
  or three suggested next.
- Resume on `/godmode`: tickets in progress matched with worktrees, branches and PRs;
  one line per resumed ticket.
- Update notice from the note's version (step 2).

## Step 9 — `/godmode try` (D49)

- Starts the ticket's worktree with the project's start command on a free port and
  gives the link; skipped when the project has nothing to run.

## Step 10 — context7 (D41)

- Shipped as a connection the plugin sets up (pending spike 0.1).

## Step 11 — Change-setup mode (D21, D22)

- `/godmode setup` opens a conversation; the main thread applies the change (e.g. adding
  Jira after two months) to settings and conventions, then updates the note.

## Step 12 — Ship

- `claude plugin validate`, `claude plugin test`, `tsc`, per the repo's `CLAUDE.md`.
- Dogfood on two unlike repos: a small non-web project (e.g. a Python CLI) and a web
  app. Then a repo with existing conventions, to exercise adopt and improve-in-place.
- README section, marketplace entry, version 1.0.0. The README recommends installing
  dispatch-panel too (D43).

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
