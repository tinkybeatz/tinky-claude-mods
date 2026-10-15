# godmode — brainstorm log

> **Read this first, before answering anything about this project.**
> This file is the source of truth for the brainstorm, not the conversation you are in.
> It is append-only: add new entries at the bottom, never rewrite or tidy past ones.
> Log every decision together with the reason behind it. Messy is fine; lossy is not.
> Status is still brainstorming — do not start building unless Gael says so.

- Started: 2026-10-15
- Status: brainstorming. Nothing is being built.

---

## Session 1 — 2026-10-15

### Where the idea came from

- A colleague built an agentic development loop for his team's repo (the "reference
  loop" below) and shared everything needed to run it: a setup checklist, a starting
  prompt for the PM chat, his local rules file, a decisions log, and an overview guide.
- Gael likes the loop and wants it as a mod he can switch on in any session: "start the
  mod in a new session, it sets up the whole agentic system, with a master PM that
  dispatches." Switched off, the session is plain Claude Code "if i do some simple dev".
- His goal, in his words: "a proper solid agentic loop that could plug n play to any
  project and code with the same quality no matter the project", "hassle-free agentic
  loops".
- The reference loop is specific to one project. Gael: "you understand here im trying
  to take what [he] did and adapt it for a boilerplate".

### Research done (2026-10-15)

Three reads, summarised here so later sessions need not redo them.

**The reference loop, generic mechanics** (from its PM rules, its `dev` and `test` agent
definitions, its `ticket`, `write-ticket` and `pr` skills, and its overview guide):

- Roles: the PM (the main session) plans, files tickets, dispatches, relays verdicts,
  runs fix rounds and arms merges, and writes no feature code. A `dev` agent (Sonnet)
  builds one ticket in its own git worktree and ends at a draft PR. A `test` agent
  (Opus) reviews read-only and returns `clean-to-merge`, `change-request` or `blocker`.
- Flow: product rulings come only from the human and go to a decisions log; undecided
  topics go to an agenda. Filing a ticket never starts a build. Dispatch happens only
  when the human names a ticket. Every PR is reviewed automatically. Findings go back to
  the same dev agent (a "fix round"), and each fix is re-reviewed at its new commit.
  Merge arming follows a fixed order: clean verdict at that commit, attribution sweep,
  mark ready, wait for CI to start, then auto-merge. After merge: ticket to QA, worktree
  removed.
- Coordination: before each dispatch, a "contention sweep" lists the files every open PR
  touches, so two agents never edit the same file. One agent per hot file, about 5
  agents at most. With two loops in one repo, each acts only on its own PRs and tickets.
- Autonomy contract: the PM asks only product questions, never "shall I do the next
  step"; a question about state is answered, not acted on; the latest instruction wins.
- Ticket shape: Status, Blocked by, The ask (verbatim), Measured (claims with evidence),
  Inferred (hypotheses), Answer this first, Scope in/out, Constraints, Tests (each shown
  failing on main), Refs.
- Never cut: a strong-model review for every PR, a red-check (the test shown failing
  without the change) for every test, the project's quality gate, the attribution sweep.

**What a project has to supply:** models per role, the agent cap, base branch, merge
method, whether draft PRs skip CI, worktree folder, branch pattern and bootstrap command,
the ordered gate commands, the tracker and its states, the user's own login, id ranges
when several loops share a repo, the paths of the decisions/agenda/facts files, the
standards docs the reviewer checks against, and a tool to run the app for behavioural
checks.

**Gael's skills to draw from:** `skills-tinky` (git@github.com:tinkybeatz/skills-tinky.git)
is the source; `agents-skills` is Leo Delpon's French original. Candidates:
`claude-md-architect` (does not handle AGENTS.md; templates lean JS/TS),
`standard-maker`, `adr-writer`, `architecture-conceptor`, `change-advisor`, the
parallel-agents git standard `senior-dev/std/_shared/multi-claude-workflow.md`, the
SessionStart hook `hooks/session-claude-md-check.sh` (a model for detecting an
already-set-up repo), `docs/stds/PROJECT_CONTEXT_SKILL.md` (AI context kept out of the
repo vs committed in it), and the design suite for projects with a UI. Gaps: nothing
writes tickets or PRs, and code review lives inside `senior-dev` (about 39k words).
The reference loop's `write-ticket`, `ticket` and `pr` skills can fill them once
generalised.
`test-writer` is TypeScript/React-only.

### Decisions

- **D1. The mod is generic: any project, any stack.** The reference loop is the reference,
  not the template. Gael: "not only web, just saying! the boilerplate should really be
  created in order to be adaptive of anything."
- **D2. One self-contained bundle.** It must not depend on Gael's personal skills. Gael:
  "this will be a mod on a separate repo, if people wanna use it but dont have my skills
  then how? no it should all be bundled as a 1 thing." Anything taken from skills-tinky
  is copied in and generalised.
- **D3. Conventions are part of setup.** A project with no agent dev rules gets a full
  preset (base conventions for coding with AI, theme conventions, and so on) through a
  process that creates them. A project that has some: read them, check them, and if they
  seem solid, adopt them and adapt the loop to them "without questioning anything".
- **D4. Restarting on a known project is quick.** Gael: "the whole setup can take long on
  a new project, if i wanna re-start the mod on a project i already used it in, i want
  the start to be quick". The mod notices it has been used there before. (How: see
  proposals.)
- **D5. Keep the mod's files out of the repo or in it, as an option.** (How: see
  proposals.)
- **D6. The dispatch panel comes with it when the mod is on.** If bundling is not
  possible, installing both is acceptable: "if not possible its okay i can have both."
- **D7. The mod lives in `tinky-claude-mods`**, next to dispatch-panel. Gael: "yes the
  mod would go in tinky-claude-mods".
- **D8. The project supplies the loop's settings; when it cannot, a very quick setup
  questionnaire asks for them.**
- **D9. Two modes: a setup mode and a coding mode.** Gael: "we really need a whole setup
  mode and a coding mode."
- **D10. The tracker is optional.** Jira is one option, not a requirement: "I don't use
  trackers for personal projects."
- **D11. The mod has permission settings.** What they cover is still open.
- **D12. Switched on or off per session.** Off, the session is plain Claude Code.

### Proposals, not decided

- **Detecting an earlier setup (for D4):** a small record of what setup produced, keyed
  by the repo's first commit (stable across renames and moves), with a fingerprint of
  each conventions file. On restart, nothing changed means straight to the PM in
  seconds; changed files are re-checked alone.
- **In or out of the repo (for D5):** in-repo mode writes conventions and the record into
  the repo; out-of-repo mode keeps them under `~/.claude/` or in gitignored `.local`
  files, like a `CLAUDE.local.md`.

### Open questions

- What the permission settings (D11) cover.

### Permissions (2026-10-15)

- **D13. Permissions are a list of actions, each set to "allowed", "ask me" or
  "never".** An action is something the loop can do without asking first, such as
  commit, push, open a draft PR, post a review comment, mark a PR ready, arm auto-merge.
  Gael: "yeah exacly". This answers the open question on D11.
- **D14. The setup questionnaire offers presets as multiple choice**, not the full list.
  Gael's sketch: "a simple 'free, depends (no git), no freedom' whatever multiple
  choices."
- Proposal, not decided — what each preset holds:
  - **Free:** agents commit, push, open draft PRs, post review verdicts, mark ready and
    arm auto-merge on their own. Force-pushing a reviewed commit, approving a PR, and
    acting on other people's PRs stay "never" or "ask".
  - **Local only** (Gael's "depends (no git)"): agents edit files and run tests freely;
    every git or PR write (commit, push, PR) asks first.
  - **Locked** (Gael's "no freedom"): every write, file edits included, asks first.
  - A floor in every preset: no AI attribution, never act on someone else's PR or ticket.
- Gael rejected the proposed floor ("no and no!"):
  - **D15. AI attribution is a setting, not a fixed rule.** "no ai attribution can be an
    option."
  - **D16. No preset forbids acting on other people's PRs as a fixed rule.** "never act on
    someone else's PR no!"
  - **D17. A fourth preset, "Full freedom": every right, everywhere**, other people's PRs
    included. Gael: "prolly super freedom with all rights all around (4th option)".
- The contents of Free, Local only and Locked above are still a proposal.
- **D18. The four permission presets** (Gael: "yes"):
  - **Full freedom:** every right, everywhere, other people's PRs included.
  - **Free:** agents commit, push, open draft PRs, post review verdicts, mark ready and
    arm auto-merge on their own, on Gael's own PRs only. Approving a PR and force-pushing
    a reviewed commit ask first.
  - **Local only:** agents edit files and run tests freely; every git or PR write asks.
  - **Locked:** every write, file edits included, asks first.
  AI attribution (D15) is a separate setting next to the preset.
- **D19. Three storage choices in the questionnaire** (Gael: "yes all three"), for the
  conventions, loop settings, decisions log and setup record:
  - **Committed:** in the repo, shared with everyone who clones it.
  - **In the repo, gitignored:** on Gael's disk only (like a `CLAUDE.local.md`).
  - **Outside the repo:** under `~/.claude/`, the project folder untouched.
  This settles the "in or out" proposal for D5.

### Quick restart (2026-10-15)

- **D20. Setup leaves a note; a restart reads it first** (Gael: "okay yeah sure"). The
  note is a small file written when setup finishes: project, date, the questionnaire
  answers (permissions, storage, ...) and the conventions files checked. When the mod is
  switched on: note found, setup is skipped and the PM starts right away; no note, full
  setup. A conventions file edited since the note was written is re-checked alone. The
  note lives in the storage chosen in D19. (The first explanation, with "first commit"
  and "fingerprints", was unclear to Gael; the plain version above is what he agreed to.
  How the project is identified and how edits are noticed are implementation details.)
- **D21. Re-setup on demand, full or partial.** Gael: "note that re-setup (full or
  partial) could be possible too!"
- **D22. A partial re-setup is a conversation, not a menu.** Rejected: one command per
  part (`/loop setup permissions`). Gael: "partial would mean we turn setup mode again but
  in 'change setup' mode. then we would simply discuss with the main thread and go from
  there! lets say after 2months of coding with the tool i wana start using Jira, boom add
  Jira and make it work!" So: a "change setup" mode where the main thread discusses the
  change, applies it to the settings and conventions, and updates the note (D20).

### Trackers (2026-10-15)

- Rejected: a fixed list (none, Jira, GitHub Issues, Linear). Gael: "no."
- **D23. The questionnaire offers three tracker choices: None, Jira, Other.** "None"
  means tickets are markdown files kept by the mod. Gael asked: "how does it work with
  md files? can we make that clean and efficient?"
- Proposal, not decided — markdown tickets:
  - One file per ticket in a `tickets/` folder in the chosen storage (D19), e.g.
    `tickets/T-012-export-button.md`. A short header holds id, title, status
    (todo / doing / review / done), blocked by, branch and PR link; the body is the
    ticket shape (the ask, measured, scope, tests).
  - Nobody edits ticket files by hand. The mod gives the PM and agents a few tools
    (create, move, list, comment), so statuses stay consistent and listing reads only the
    headers, not every file.
  - Done tickets move to `tickets/done/`, so the open list stays short.
  - The same tools serve Jira and Other: the PM always says "move T-012 to review" and
    the mod routes it to the file, Jira or the other tracker.
- **D24. Markdown tickets as proposed above** (Gael: "yes, works for me"): one file per
  ticket in `tickets/` with a short header, edited only through the mod's create / move /
  list / comment tools, done tickets moved to `tickets/done/`, and the same four tools
  routed to Jira or Other when one is chosen.
- **D25. "Other" tracker** (Gael: "yes, works for me"): in setup Gael names the tracker;
  the main thread checks how Claude can reach it (a connector already set up, or a
  command-line tool such as `gh`), maps the four ticket tools onto it, and saves the
  mapping in the setup note. If it cannot reach the tracker, it says what is missing and
  never falls back to something else on its own.
- **D26. Guiding principle: modular and adaptive.** Gael: "keep it modular and made to be
  adapting! keep that in mind!" Every part (tracker, gates, conventions, permissions,
  stack) is a swappable piece the setup adapts to the project, never a fixed assumption.

### Command (2026-10-15)

- **D27. The command is `/godmode`.** Gael: "i dont like loop. i want 'godmode'."
  - `/godmode`: switches it on. No setup note means setup mode; a note means coding mode
    with the PM.
  - `/godmode setup`: change-setup mode (D22).
  - `/godmode off`: back to plain Claude Code for the rest of the session.
- **D28. The mod is named `godmode`** (Gael: "yea"). Its folder moved from the working
  name `agentic-loop/` to `godmode/`, and it installs with `/plugin install godmode`.
  (This log's title line was updated to the new name; nothing else above was changed.)

### Setup flow (2026-10-15)

- **D29. Setup scans first, then asks only what the scan cannot tell** (Gael: "yes,
  works for me"). The scan finds the language, the build and test commands (e.g.
  `pnpm test` in `package.json`, `cargo test`), the git host and existing conventions
  files (`CLAUDE.md`, `AGENTS.md`). The questionnaire then asks the gaps plus Gael's own
  choices: permissions (D18), storage (D19), tracker (D23), attribution (D15). On a
  well-set-up repo that can be four questions.

### Conventions preset (2026-10-15)

- **D30. The preset holds every piece discussed; the ones that can be are optional.**
  Gael: "keep all but keep the ones that can as nullable. nullable as long as it doesn't
  hurt the output qulity too much (agent rules are not nullable obvs)". The pieces:
  agent rules (`AGENTS.md` + a short `CLAUDE.md`), coding standards, git workflow,
  testing rules, design conventions (UI only), project map and glossary, decisions log
  (ADRs), security rules, ticket and PR templates, review checklist, quality gates,
  knowledge file, docs style. "Optional" (Gael's "nullable") means setup may skip it.
- Proposal, not decided — which are required:
  - Required, because the loop or output quality depends on them: agent rules, coding
    standards, git workflow, testing rules, quality gates, review checklist, ticket and PR
    templates, decisions log.
  - Optional: project map and glossary, security rules, knowledge file, docs style,
    design conventions (and only offered when the project has a UI).
- **D31. Required vs optional pieces as proposed above** (Gael: "yes, works for me").
  Required: agent rules, coding standards, git workflow, testing rules, quality gates,
  review checklist, ticket and PR templates, decisions log. Optional: project map and
  glossary, security rules, knowledge file, docs style, design conventions (UI only).
- **D32. Weak existing conventions are improved in place, with consent first.** Gael:
  "improve them in place. ask for consent first, justify (not over-justify)." Godmode
  shows what it would change and why in a line or two, waits for a yes, then edits the
  project's own files. Solid conventions are adopted as they are (D3); missing required
  pieces are filled in.

### Roles (2026-10-15)

- The reference loop's three roles: PM (main session), dev (Sonnet), reviewer (read-only,
  Opus). Gael on adding a researcher that reads code before a ticket is written: "i
  don't mind a researcher." He asked whether there could be other roles, and raised one:
  "im thinking bout the setup: we could need a whole setup agent." Not decided yet.
- Reference: the reference loop's written guide. New in it, beyond the research above:
  - Each worktree's app can run on its own port (a run-worktree script), so several can
    be tried side by side.
  - Recommended plugins: Figma (read designs), context7 (current library docs),
    ponytail (smallest change that works), karpathy-skills (guidelines against common
    agent mistakes).
  - A "what you say → what happens" table: "File a ticket for …" files and stops;
    "Dispatch <ticket>" sweeps PRs and starts a dev agent; "Check the reviews" reports
    and stops; findings send a fix round automatically; a clean review says ready to try;
    "Merged" pulls main and cleans the worktree.
  - "Use Opus for root-cause hunts and anything that could lose an author's work."
- **D33. Six roles: PM, dev, reviewer, setup, researcher, QA.** Gael: "all three. the new
  agents need to fitin flawlessly doe". The three new ones:
  - **Setup agent:** does the scan, the questionnaire's legwork and the conventions
    writing in its own context, so the main thread stays clean for the PM.
  - **Researcher:** reads code and docs before a ticket is written, so the PM's context
    stays free of files.
  - **QA:** runs the app and clicks through the change before review (the reference loop's
    "try it" step, done by an agent), for projects with something to run.
  Requirement: the new roles fit into the loop without friction; where each sits in the
  flow is the next point.
- Rejected: QA running alongside the reviewer. Gael: "its a waste. what if review says
  somethings need to be changed. QA comes in after code review."
- Proposal, not decided (Gael's idea, Claude agreed): the order is dev → review → fix
  rounds until clean → QA → fixes if needed → ready for Gael. After a QA fix, the
  reviewer re-checks only the changed lines and QA re-tests only what it flagged.
- How QA works, as explained: it starts the worktree's app on its own port and uses it
  like a person (browser for a web app, real commands for a CLI, requests for an API),
  checks the ticket's ask item by item, and returns pass/fail with evidence (screenshots,
  real outputs). Gael wondered if it was overkill.
- **D34. QA is an optional piece.** Offered at setup, on by default only when the scan
  finds a runnable UI; the PM also skips it for tickets that change nothing visible.
  Gael: "yes, works for me". It needs a driving tool (a browser tool such as
  agent-browser or Playwright) and an app that runs locally.
- **D35. Order: dev → review → fix rounds until clean → QA → fixes if needed → ready for
  Gael.** After a QA fix the reviewer re-checks only the changed lines and QA re-tests
  only what it flagged. Gael: "yes, lock it in."
- Gael asked whether the PM takes decisions in the reference loop or whether everything
  is deterministic. Answer: its PM is a model following written rules (a local rules file
  and a PM workflow doc); it judges process steps within them
  (e.g. adding a browser check for appearance-only work, one review pass for docs-only
  PRs, classifying a CI flake). Only product decisions go to the human. Nothing is
  enforced by code. A mod can make some of it deterministic with hooks.
- **D36. Hard rules in code where it makes sense; model judgement where a rule cannot
  express it.** Gael: "yes where it makes sense." Example: QA runs if and only if the
  ticket's "visible change" field, confirmed with the ticket, says yes.
- Why the reference loop wrote rules as text, and the trade-off (as discussed):
  - The reason is not written down. Its kit is "a handful of files you commit to your
    repo" (agents, skills, a local rules file), which works in any Claude Code without a
    plugin and is easy to edit. That is a guess at the reason.
  - Evidence that text rules get missed: the reference loop's own notes record one merge
    that went through while its verification was still running, and another with 8 of 12
    checks skipped. Both rules existed as text.
  - Cost: text rules are read every session (about 800 lines in the reference loop) and
    take context; a hook runs as code and spends no
    tokens. Hooks are cheaper, not more expensive.
  - Text: flexible, handles edge cases by judgement, editable by anyone, portable. But it
    can be skipped, especially in long sessions or after compaction.
  - Hooks: always enforced, free to run. But rigid (a new edge case needs a code change),
    harder for a user to edit than markdown, tied to the mod API, and a buggy hook can
    block work.
- **D37. Hybrid, with one dividing rule.** Gael delegated the call: "ill let you be the
  judge. please pick the option that fits my case the best". Claude's pick:
  - **A hook** when the rule can be checked from what the mod sees (tool calls, PR state,
    ticket fields) **and** breaking it is costly or hard to undo.
  - **Text** when it needs judgement.
  - Every hook that blocks says why and what unblocks it, and every hook rule is a
    setting (D26), so a project can loosen it.
  - Why: Gael's goal is the same quality on every project with no babysitting; the two
    incidents in the reference loop's notes were exactly checkable, costly rules (merge
    with verification unfinished). Judgement work (tickets, reviews) cannot be coded
    without making it worse.
- Proposal, not decided — the split under D37:
  - Hooks: the permission presets and attribution setting (gate tool calls); dispatch only
    tickets Gael marked ready; review started automatically when a draft PR opens; QA
    started from the "visible change" field; PRs always opened as drafts; no ready or
    auto-merge without a clean verdict recorded at the PR's current commit; the
    contention sweep computed by the mod and put into each dev brief; a dev agent cannot
    edit outside its own worktree; the agent cap.
  - Text: how to write a ticket (measured vs inferred), the review checklist, fix-round
    briefs, how to red-check a test, classifying a red CI run, what small work the PM does
    itself, when to ask Gael.
- **D38. The hook / text split as proposed under D37** (Gael: "ok yeah").

### Models (2026-10-15)

- **D39. Model per role is a setting, with these defaults** (Gael: "yeah sure"): PM = the
  session's model; dev = Sonnet; reviewer = Opus; setup = Opus (its conventions shape
  every later ticket); researcher = Sonnet; QA = Sonnet. The PM may pick Opus for a
  dev agent on root-cause hunts and risky changes (the reference loop's guide: "Use Opus for root-cause
  hunts and anything that could lose an author's work").

### Outside plugins (2026-10-15)

- **D40. Godmode carries its own skills, reusing Gael's or Karpathy's** rather than
  asking users to install other plugins. Gael: "i think the mod should carry its own
  skills to be independant -> re-use mine or karpathys". Per plugin:
  - Figma: out ("figma dont care").
  - ponytail (smallest change that works): in.
  - karpathy-skills (guidelines against common agent mistakes): in, alongside Gael's own
    ("i have some too").
  - context7 (current library docs): in ("why not").
- Note: copying ponytail's or karpathy-skills' text needs their licences checked first.
  context7 is a live service, not text: it can only come in as a connection the plugin
  sets up, not as a skill.
- **D41. Godmode sets up the context7 connection itself** (Gael: "ok"). context7 serves
  current, version-specific docs for the libraries a project uses, so agents do not code
  against an outdated API remembered from training.
- Licence check (2026-10-15, `gh repo view`):
  - `DietrichGebert/ponytail`: MIT. Its text can be copied in, with its licence notice
    kept.
  - `forrestchang/andrej-karpathy-skills`: no licence. Default copyright applies, so its
    text must not be copied; godmode writes its own rules covering the same pitfalls,
    next to Gael's.
  - `upstash/context7`: MIT.
- **D42. Licence handling as above** (Gael: "ok good keep that then"): ponytail copied
  with its MIT notice; karpathy-skills not copied, its pitfalls covered by godmode's own
  rules alongside Gael's.

### Dispatch panel (2026-10-15)

- Whether `dependencies` installs a dependency automatically is not documented in the
  `plugin-authoring` skill (build 2.1.295); to be tested at build time.
- Asked whether `/godmode` should open and close the panel. Gael: "hmm maybe keep them
  independant actually." This would revise D6 (panel bundled when the mod is on).
  Pending his confirmation.
- **D43. Godmode and dispatch-panel stay fully independent** (Gael: "yes, lock it in").
  No dependency: godmode works without the panel, and the panel keeps working on its own
  in every session. The README recommends installing both. This replaces D6.

### Status report (2026-10-15)

- The reference loop has no command: its first report comes from a starting prompt pasted
  once into a fresh chat ("report back and wait"); later sessions only read its rules
  file.
- **D44. `/godmode report` gives a status report** (setup check, open PRs and the files
  each holds, tickets ready to build, 2 or 3 suggested next). Gael: "i like that idea but
  give me a /godmode report."
- **D45. `/godmode` only switches godmode on.** Gael: "in not godmode, /godmode starts
  it / in godmode, /godmode does nun". Typed while godmode is already on, it changes
  nothing.
- **D46. Switching on is quiet: no automatic report.** Asked whether `/godmode` should
  also show the report once on switch-on; Gael: "no". The report comes only from
  `/godmode report`. (Read as "no automatic report"; the question was either/or.)

### Shared repos (2026-10-15)

- Dropped: asking who other PR authors are. Each PR's author is known from the git host,
  which is all the permission presets need.
- **D47. Before each dispatch, every open PR's files are checked, colleagues' included,
  so no agent edits a file another PR holds** (Gael: "yes, works for me").
- Gael's concern: "how bout the agent checks themselves? the goal is too avoid the PM
  thread being over contexted". Under D38 neither the PM nor the agent does the check:
  the mod's code lists the held files and adds them to the dev agent's brief, so the
  PM's context never sees them.
- **D48. An edit to a file another open PR holds is blocked while the agent works**
  (Gael: "ok"). This covers a PR opened after the dispatch: a hook blocks the edit and
  tells the agent to stop and report, so it never has to re-check by itself.

### Trying a change (2026-10-15)

- **D49. `/godmode try <ticket>` starts that ticket's worktree on a free port and gives
  the link** (Gael: "in the principle that pretty much what i want"). Setup finds the
  project's start command (`npm run dev`, `cargo run`, `python manage.py runserver`, ...);
  projects with nothing to run skip it.
- Gael did not recognise "T-012": it was the example id of a markdown ticket from D24
  (`tickets/T-012-export-button.md`); with Jira the id is the Jira key (`ABC-123`).
  The markdown id format is not decided.
- **D50. Markdown ticket ids are `T-` plus a number** (`T-1`, `T-2`, ...). Gael: "T- sure".

### Talking to the PM (2026-10-15)

- Rejected: a list of phrases and what each triggers, generalised from the reference loop's guide
  ("File a ticket for …", "Dispatch T-3 T-4", "Check the reviews", "Merged"). Gael: "no
  i actually don't really want that..." What he wants instead: open.
- **D51. Nothing to learn: Gael talks to the PM normally and it works out the intent.**
  What he rejected was "having to learn" phrases, not what they trigger. No phrase list
  in docs or onboarding.
- **D52. The behaviour under the plain talk stays** (Gael: "yes, works for me"): filing a
  ticket never builds; agents start only when Gael says go for a ticket, in any words;
  the PM confirms which tickets it understood before dispatching.

### Merging (2026-10-15)

- **D53. Auto-merge is off by default, in every preset, until Gael says so.** Gael: "it
  depends. keep auto-merge off by default unless i say so". This narrows D18: Free and
  Full freedom no longer arm auto-merge on their own. Once review and QA are clean, the
  PM waits for Gael's go. Whether "says so" is per ticket or a switch: open.
- Settled: Gael just says it, in his own words, and the PM understands the scope (D51).
  Gael: "ill just say so !!!!!!!!!!" — the per-ticket-or-switch question was one too
  many; don't ask how plain talk will be phrased.

### Open questions (2026-10-15, listed by Claude when Gael asked "do you have all info
needed? anything else that would make sense?")

- Projects without git, or without a PR host: what the loop becomes with no worktrees or
  PRs.
- Git hosts other than GitHub (GitLab, Bitbucket): an "Other" mapping like the tracker's
  (D25)?
- Fix rounds that never converge: after how many rounds the PM stops and asks Gael.
- Crashes and resuming: an agent or the session dies mid-ticket; how godmode picks the
  work back up (in the reference loop, dev agents commit as
  they go).
- Cost control: the agent cap's default, and any budget per ticket.
- Reference repos: other repos agents may read but never edit (e.g. an older app used as
  a parity reference, or backend repos).
- Godmode updates: how a project set up with an older version gets newer conventions
  (ties to D20's note and D22's change-setup mode).
- Several people using godmode on one repo with committed storage (D19): shared
  conventions vs personal settings.

### Gaps, one by one (2026-10-15)

- **D54. No git: godmode will not start, and offers `git init`. Git with no PR host:
  local branches only, the review runs on the branch, no PR** (Gael: "yes").
- **D55. Git hosts other than GitHub are handled like the "Other" tracker** (Gael:
  "yes"): setup checks how Claude can reach the host (`glab`, a connector, ...) and maps
  the PR actions (open, review comment, mark ready, merge) onto it. If it cannot reach
  the host, it falls back to local branches as in D54.
- **D56. After 3 fix rounds on one ticket the PM stops and asks Gael** (Gael: "yes"),
  saying what keeps failing. The limit is a setting.
- **D57. Resuming after a crash** (Gael: "yes"): the next `/godmode` compares tickets in
  progress with their worktrees, branches and PRs, and each picks up from its last commit
  (dev agents commit as they go). Gael gets one line per resumed ticket — the one thing
  a quiet switch-on (D46) shows.
- **D58. At most 5 agents at once by default (a setting); no per-ticket token budget**
  (Gael: "yes"). The fix-round limit (D56) and the dispatch panel's token counts already
  show where tokens go.
- **D59. One repo by default; setup never asks about reference repos.** Gael: "no. by
  default 1 repo only in the config. users will mention it if there is stuff like we have
  with [our reference repo]. by default not necessarily. dont ask bout that". When the user mentions
  one, it is added (through change-setup, D22) as read-only.

### Godmode updates (2026-10-15)

- **D60. After godmode itself is updated, `/godmode` on a project set up by an older
  version says there is an update, in one line, and changes nothing until Gael says yes**
  (in change-setup, D22). Gael: "yeah i like that. mention there is an update."
- How it is noticed: the setup note (D20) records the godmode version that wrote the
  project's conventions. On `/godmode`, the mod compares that with its own version. No
  fetch from GitHub is involved; the mod itself is updated the way any plugin installed
  from a marketplace is.

### Shared vs personal (2026-10-15)

- **D61. With committed storage, files split into shared (committed) and personal
  (always gitignored)** (Gael: "sure i guess. i just dont want this to make things less
  qualitative"):
  - Shared: agent rules, coding standards, git workflow, testing rules, quality gates,
    review checklist, ticket and PR templates, the optional pieces, decisions log,
    markdown tickets, the team's tracker choice, the start command for `/godmode try`,
    QA on or off, and the godmode version that wrote the conventions.
  - Personal: permission preset, attribution, auto-merge, models per role, agent cap,
    fix-round limit, tracker identity (account, default epic and sprint), reference repo
    paths, and the person's own answers.
  - A teammate's first `/godmode` finds the shared part and asks only the personal
    questions.
- Gael's condition: the split must not lower quality. Everything quality depends on is
  shared. The one personal knob that could lower it is the model per role (a cheaper
  reviewer).
- Gael asked whether the split changes anything when he is alone on a project. No: two
  files instead of one, same behaviour. The split exists only in committed mode; with
  gitignored or outside-the-repo storage everything is personal.
- **D62. The shared part sets a minimum model per role** (e.g. "reviewer: Opus at
  least"); personal settings can raise it, never lower it (Gael: "yes add it"). It only
  matters on shared repos.

### Status at end of session 1

- All open questions listed on 2026-10-15 are settled (D54–D62).

### A thin main thread (2026-10-15)

- Gael: "if i forget to mention dispatch an agent/shell to do this, can we enforce that
  the main thread should do as least as possible. if i say 'go check this' i need it to
  understand that a shell/agent should be dispatched and not the main thread do it
  itself".
- **D63. The PM's own tools are limited by a hook** (Gael: "yes, works for me"): talking,
  the ticket tools, dispatching agents and quick status checks (open PRs, git status).
  Anything heavier from the main thread (editing files, reading more than a couple of
  files, searching code, running commands) is blocked with a message to dispatch a
  researcher or a shell. A text rule tells the PM to delegate on purpose, so the hook is
  the backstop. This replaces the reference loop's "small work is the PM's"
  rule.
