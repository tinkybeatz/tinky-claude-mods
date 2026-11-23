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
is the source. Candidates:
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
  routed to Jira or Other when one is chosen. (Statuses changed by D69: a `qa` status
  now sits between review and done.)
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
    "try it" step, done by an agent), for projects with something to run. (Where it
    runs now depends on the QA mode, changed by D69 and D71.)
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
- **D34. QA is an optional piece** (replaced by D69's four modes). Offered at setup, on by default only when the scan
  finds a runnable UI; the PM also skips it for tickets that change nothing visible.
  Gael: "yes, works for me". It needs a driving tool (a browser tool such as
  agent-browser or Playwright) and an app that runs locally.
- **D35. Order: dev → review → fix rounds until clean → QA → fixes if needed → ready for
  Gael.** After a QA fix the reviewer re-checks only the changed lines and QA re-tests
  only what it flagged. Gael: "yes, lock it in." (Changed by D69: this order is now the
  `bot` mode; the human modes follow D69-D72.)
- Gael asked whether the PM takes decisions in the reference loop or whether everything
  is deterministic. Answer: its PM is a model following written rules (a local rules file
  and a PM workflow doc); it judges process steps within them
  (e.g. adding a browser check for appearance-only work, one review pass for docs-only
  PRs, classifying a CI flake). Only product decisions go to the human. Nothing is
  enforced by code. A mod can make some of it deterministic with hooks.
- **D36. Hard rules in code where it makes sense; model judgement where a rule cannot
  express it.** Gael: "yes where it makes sense." Example: QA runs if and only if the
  ticket's "visible change" field, confirmed with the ticket, says yes. (Changed by D69:
  the example now holds for bot QA; whether human QA uses the field is open.)
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
- **D38. The hook / text split as proposed under D37** (Gael: "ok yeah"). (Changed by
  D69 and D73: the QA hook now follows the QA mode, and the prompt hook also checks the
  tickets waiting on QA.)

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
  give me a /godmode report." (Extended by D70: the report also checks the tickets
  waiting on QA.)
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
  PM waits for Gael's go. Whether "says so" is per ticket or a switch: open. (Changed by
  D69: in `human-pr` the PR is not marked ready until QA passes; in `human-staging` the
  merge comes before QA; in `none` there is no QA step.)
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
    QA on or off (now the QA mode, changed by D69), and the godmode version that wrote
    the conventions.
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

## Session 2 — 2026-10-16

- Spikes (`spikes.md`): on an organisation-managed (Team) login, Claude Code's default
  security plugin skips `prompt.compose`, `session.append` and `classic.Stop` hooks from
  plugins the person installs. A `prompt.submit` hook that attaches context, plus the
  `/godmode` reply's own context, carries the PM's role instead.
- **D64. Godmode works on both kinds of account.** Gael: "this plugin is not only to be
  used with this account. I have personnal claude accounts too. friends will prolly want
  to use it too, can you make it work for both? (with or without system prompt)". Where
  `prompt.compose` runs, the PM's role goes in the system prompt and the per-message
  reminder switches itself off; where it is skipped, the reply-plus-reminder fallback is
  used. The mod detects which one ran.
- Open: whether "ask me" in the permission presets goes through Claude Code's own check
  (`tool.check`, which auto mode may answer by itself) or always asks Gael directly
  (`$.ui.ask`).
- **D65. Gitignored mode ignores `.godmode/` through `.git/info/exclude`, not
  `.gitignore`.** Gael: "i feel like 2nd option is a better fit to 'gitignored mode' since
  it will not even track that parent folder." The repo stays untouched (no tracked file
  changes, nothing to commit by mistake); the exclude file is shared by every worktree of
  the repo; no effect on performance. Committed mode keeps its `.godmode/personal.json`
  line in `.gitignore`, since that one should apply to every clone.
- **D66. "Ask me" always asks Gael directly, through godmode's own question
  (`$.ui.ask`), never through Claude Code's permission check.** Gael's decision, relayed
  on 2026-10-16 while Step 7 was built. A rule set to "ask me" (D13) holds the tool call
  in godmode's `tool.call` hook and opens the question dialog itself; the hook never
  returns an "ask" verdict from `tool.check`. Why: in auto mode Claude Code's classifier
  settles a `tool.check` ask by itself, so a write could go through without Gael ever
  seeing it (spike 4). This settles the open question above. With nobody to ask (a `-p`
  run, a dismissed question) the call is refused, and the refusal says so.
- **D67. The PM main thread may itself comment on PRs, mark them ready, merge them, and
  start background shells, as exceptions to D63's thin main thread.** Gael's words: "yes
  thats fine". Relaying a verdict as a PR comment, marking a PR ready and merging it on
  his go are loop steps, not heavy work, and a background shell is how heavier work
  leaves the main thread anyway. The verdict-at-commit rule (no ready or merge without a
  clean verdict at the PR's current commit, D53) and auto-merge off unless Gael says so
  (D53) still apply to the PM's own actions exactly as to an agent's. (Step 7's hooks
  already let these through; this records the decision behind them.)
- **D68. A visual "godmode is on" indicator, one of three styles, chosen as a personal
  setting** (Gael said yes; his words on the questionnaire: "setup WILL ask about it"):
  - `mode` (the default): a red "godmode" label among the footer's mode labels;
  - `hint`: a red tag at the end of the hint line under the prompt;
  - `band`: a thin dark red strip saying GODMODE above the prompt.
  Only one shows at a time. Setup asks it as a personal answer (D61's split, key
  `indicator`, values `mode`, `hint`, `band`), and change-setup can change it.
- **D69. QA is one of four modes, asked at setup per repo; this replaces D34's on/off.**
  Gael: "this plugin is made to be plug-and-play with any project, so that should be a
  step of the setup", and "we need to make this as modulable as the rest". Personal and
  work repos do not test the same way, work repos differ between them, and someone else
  may use godmode. The four modes:
  - `human-pr`: people test the PR before merge. After a clean review the ticket moves to
    a QA status and the PM waits; it never marks the PR ready until it is told QA passed.
    A human fail starts a fix round.
  - `human-staging`: people test on staging after merge. Merging stays allowed, but the
    ticket goes to a QA status instead of done, and the QA team closes it.
  - `bot`: the QA agent runs after a clean review and before ready (D35's order).
  - `none`: a clean review goes straight to ready.
  The setup asks "human QA?" first, then where humans test, or else whether a bot QA is
  needed. The scan's runnable-UI finding only suggests a default. Ticket statuses gain a
  QA status (todo / doing / review / qa / done).
- **D70. In `human-pr` mode, the PM learns the QA result from any signal setup chose for
  the repo** (Gael: "second option sounds good"). Telling the PM always works; setup can
  add a ticket moved to the board's pass status (its exact name asked) and a PR approval
  from a named QA person or team. A fail through any signal starts a fix round. No
  background listener: Gael worried one would not outlive a QA pass that comes weeks
  later. Instead the PM checks the tickets waiting on QA when it next looks (each prompt,
  `/godmode`, `/godmode report`), since the result lives in the tracker or on the PR, not
  in a process. Gael keeps one PM session open as long as possible, so a new session is
  not the trigger.
- **D71. In both human QA modes, a bot QA pass first is a setup option** (Gael: "make it
  an option at setup, modular."). When on, the QA agent tests after a clean review and
  its fails are fixed before the change reaches the human testers, so they only get
  changes that already passed. It needs what bot QA always needs (an app that runs
  locally and a driving tool); the scan's runnable-UI finding suggests the default.
- **D72. In `human-staging` mode, the PM watches the QA result with the same signals as
  D70, and a fail opens a new fix ticket and PR** (Gael: "yes, same signals, fail opens a
  new fix ticket."), since the change is already merged. The fix ticket links the
  original and carries the QA person's reason.
- **D73. The QA check runs in godmode's prompt hook from the ticket store, never from the
  PM's memory** (Gael: "yes log it"). Gael's worry: after a session open for weeks, the PM
  may no longer remember that a ticket waits on QA. So on each prompt the hook (code)
  reads the tickets in the QA status from disk, checks the signals it can reach itself
  (GitHub through `gh`), and adds a fresh line to that prompt with each result or "still
  waiting". Compaction cannot lose it, as it comes from disk each time, like D64's
  reminder line. If a hook cannot call the Jira tools (a spike is needed), the line says
  to check that ticket's Jira status and the PM model does that check, reminded on every
  prompt. Rejected: a timer re-checking every few minutes. Gael: "feels overkill and
  could get out of hand"; a fail is seen on his next message, which is enough.

### Step 3, setup mode, as built (2026-10-16)

Build notes, not decisions: the decisions are D3, D8, D9, D14, D15, D18, D19, D23,
D29-D34, D54, D59, D61, D64, D68. Recorded so a later session knows why it is shaped so.

- Checked first (spike 9 in `spikes.md`): a subagent never gets the AskUserQuestion tool.
  The engine strips it from the agent's tools even when its definition lists it. So the
  setup agent cannot ask Gael itself. Its questions go through godmode's own tools, which
  ask with `$.ui.ask` from the mod's hook, the same dialog D66 uses for "ask me".
- Also checked: an agent the mod spawns itself (`$.agent.spawn` from the `/godmode` hook)
  works on the Team login, but runs in the background as a non-interactive run, and its
  Write call was refused outright with nobody asked. So `/godmode` does not spawn the
  setup agent: its reply's hidden context tells the PM to dispatch `godmode:setup`, which
  runs like any agent the model dispatches. `command.run` context reaches the model on
  both kinds of account (D64).
- The setup agent's five tools: `setup_scan` (the deterministic scan: stacks, commands,
  git and PR host, conventions files, runnable UI, and the templates on offer),
  `setup_questionnaire` (only the gaps the scan left, then permissions, storage, tracker,
  attribution, QA, indicator; a question about reference repos is refused, D59; the QA
  question is still D34's on/off, which D69 replaces),
  `setup_confirm` (Gael's yes before weak conventions are improved in place, D32),
  `setup_write_preset` (writes the templates, filled from the scan; never overwrites), and
  `setup_finish` (refuses while a required piece is neither written nor covered by an
  existing file, D31; then writes the note with fingerprints and switches to coding mode).
- Hard rules in code (D37): an edit to an existing conventions file during setup is
  refused until `setup_confirm` got a yes; the finish refuses a missing required piece.
  Judgement stays with the agent: whether conventions are none, solid or weak, extra gap
  questions, filling placeholders the scan could not.
- No git: `/godmode` asks whether to run `git init`, and runs it only on a yes (D54). A
  remote that is not a GitHub godmode can reach adds a `gitHost` question (local branches,
  or another host for later); no `origin` at all means local branches, unasked.
- Where conventions go per storage: committed, `docs/conventions/` with `AGENTS.md` and
  `CLAUDE.md` at the root and the PR template in `.github/` on GitHub; gitignored,
  `.godmode/conventions/`; outside, beside the note under `~/.claude`. Because a
  gitignored or outside file is never loaded on its own, every godmode agent's brief now
  lists the note's conventions files by absolute path.
- The PM's role (`agents/pm.md`) is hidden from the model's list of agents and given to
  the main thread instead: in `/godmode`'s hidden context when it switches on in coding
  mode, once more with the setup's report, and as a one-line reminder on each prompt
  (D64's channels).
- Open, for Gael: whether a gitignored or outside setup should also write a root
  `CLAUDE.local.md` that points at the conventions, so a session without godmode on
  still sees them.

### QA modes: build defaults (2026-11-16)

Build defaults, not decisions: none gets a D-number, and Gael can overrule any of them
later. They settle the questions found on 2026-11-04 while planning D69-D73, so Step 13
of `build-plan.md` can be built without asking. Each takes the simplest choice that keeps
the loop safe: when unsure, refuse ready or merge rather than allow it. The "(changed by
D69)" notes above mark where D69-D73 change earlier decisions.

- QA mode under D61: shared, since it replaces D61's shared "QA on or off".
- Bot pass first (D71), pass status name, named QA people or team (D70): default: shared,
  like the mode; they say how the repo is tested, and D61 shares what quality rests on.
- Recording "QA passed" when Gael says it: default: a `qaResult` ticket field (passed or
  failed, at the PR's commit) only the main thread sets with `ticket_move`, like `ready`.
- A pass at a commit: default: it counts only at the commit it was given at; a later
  commit needs a new pass, as a review verdict does (D53).
- How a fail shows: default: a "changes requested" review from the named people, or the
  ticket moved out of the waiting status to anything but the pass status. No new
  question.
- A fail's reason: default: the tester's latest comment on the ticket or PR; with none,
  the PM asks Gael for it before the fix round.
- Which tickets wait with Jira or Other: default: godmode keeps its own list of the
  tickets it moved to `qa`, in the personal settings, so the hook still reads disk (D73).
- The board's "waiting for QA" status in Jira or Other: default: setup asks it beside the
  pass status, offering the board's statuses when it can read them; shared, like that one.
- Ticket-status signal with markdown tickets: default: not offered with tracker None;
  there the signals are being told and a PR review. Testers never edit ticket files (D24).
- Tickets with no visible change: default: human QA skips them too, as bot QA does (D36);
  testers would have nothing to try.
- Fix-round limit: default: a human QA fail counts towards D56's limit, one count per
  ticket whatever started the round, so the stop comes sooner, never later.
- After a human fail in `human-pr`: default: review re-checks the changed lines, the bot
  pass (when on) re-tests what testers flagged, then back to `qa`; the PM tells testers
  what failed and what changed, and what they re-test is theirs to choose.
- Staging fix ticket (D72 vs D52): default: it is filed and waits for Gael's go like any
  ticket (D52), and the PM tells Gael it filed it. Filing never builds.
- The fix ticket's own QA: default: it goes through the repo's QA mode like any ticket.
- When the original closes in `human-staging`: default: it stops being watched once its
  fix ticket is filed, and closes when the fix ticket passes QA, never before.
- PR approval after the merge in `human-staging`: default: ignored; the signals there are
  being told and the board status.
- QA approvals on a draft PR: default: assumed to work on GitHub, and checked while 13.6
  is built; if they do not, setup drops the PR signal from `human-pr`. A check, not a
  question.
- Hosts with no PR approval (D54, D55): default: the PR signal is offered only on GitHub
  through `gh`; elsewhere being told and the board status remain.
- `/godmode` and QA results: default: switching on shows none (D46, D57); the next
  prompt's line carries them (D73), and `/godmode report` lists them (D70).
- The prompt hook's cost: default: each ticket's answer is kept 5 minutes on disk, each
  `gh` call stops after 3 seconds, at most 10 tickets are checked per prompt, and the rest
  read "still waiting, not checked". Kept answers are not a timer (D73).
- D73's Jira fallback and D63: default: the PM checks through the ticket list tool, which
  routes to Jira (D24) and which D63 already allows; no new exception.
- Resume (D57): default: a ticket in `qa` is not in progress: no dev restart and no resume
  line; the prompt line and the report show it instead.
- Changing the QA mode with tickets in `qa` (D22): default: a ticket leaves `qa` only with
  a recorded pass, whatever the new mode; Gael saying it passed counts.
- Notes written before D69: default: `qa: true` reads as `bot` and `false` as `none` until
  Gael says yes to the update notice (D60), as 13.0 and 13.1 already plan.

---

## Session after the first live test — 2026-11-23

- **D74. Root-cause fixes after the live test, decided by Gael 2026-11-23** (relayed by
  the session coordinating the fix round). The first live run saved a board link as the
  Jira project, a bare name as the Jira site, dropped a QA answer typed as a sentence, and
  the PM refused to start a dev server the person asked for. Each was one case of a class,
  so the fix closes the class:
  - Every setup answer passes one answer-rule table (`hooks/answers.ts`), when it is given
    and again when a saved note is read. A saved value is repaired where that is safe and
    flagged once per switch-on otherwise, with the `/godmode setup` topic that fixes it.
    An unusable answer is asked again with the reason, never saved raw or dropped.
  - Setup checks answers against the world before saving (Jira site, project and
    statuses; the repo and each approver through `gh`; package-manager commands against
    `package.json`), read-only, and asks again with the reason. The report the setup agent
    and the person see is built from the note as saved. `/godmode setup` gains `check`.
  - Hard rules versus thinness rules: the person's explicit ask always wins over a
    thinness rule; the PM does it or dispatches it. One principle in `pm.md`.
  - Tests feed messy, real-world input through setup.
  - Permissions tiers replaced: free by default, merge and approval are their own
    settings. Reads are never restricted. Writes are free, a colleague's PR included.
    Controlled: merging (the `autoMerge` setting), approving a PR (the `prApproval`
    setting), moving or editing a ticket godmode did not file, force-pushing a reviewed
    commit, closing a PR, deleting a branch godmode did not create. The person's explicit
    ask unlocks one controlled action on one target, recorded by the PM with `allow_once`;
    an agent never unlocks anything. Refusals say "ask for it explicitly and it goes
    through". A note's old `permissions` value is ignored; `update` asks the approval
    question.
  - QA "the PR was merged by someone else" is a pass signal of its own (`pr-merged`).
  - Models: PM on Fable, agents tiered by weight (researcher haiku, dev and QA sonnet,
    reviewer and setup opus).
- Build choices inside D74, not decisions (Gael can overrule any):
  - A raw write through the git host's API (`gh api`) stays controlled: it could approve,
    close or merge around the PR commands.
  - "A ticket the person neither created nor is assigned to" is read as "a ticket godmode
    did not file" (no side file), which needs no extra Jira read on every call.
  - An unlock is used once and lapses after an hour, so an agent dispatched for it can
    still use it after the person's next message.
  - A Jira status name is checked site-wide by JQL; Jira gives no per-workflow check
    through the connector.
  - A model godmode cannot rank takes the role's floor, so nothing runs above Fable.
- D74, corrections by Gael 2026-11-23:
  - "My tickets" are the tickets godmode filed (a side file) plus those created with the
    person's own Atlassian account; the assignee is not enough. godmode reads the account
    (`atlassianUserInfo`) once per site and each issue's creator (else reporter) once,
    both kept in the person's store. A ticket whose account or creator cannot be read
    stays controlled, and the refusal says why. The Other tracker has no creator field, so
    it is unchanged.
  - When Fable is unavailable or not allowed, the PM's request is sent again on Opus, and
    the session stays on Opus from then on, logged once. Overload, rate limits and network
    errors never trigger it.
  - Ticket-filing rules (Gael 2026-11-23): the team's Jira is messy and each case is
    tailored, so godmode learns how tickets are filed and keeps it as a plain conventions
    file, `ticket-filing.md`, fingerprinted with the others. On Jira, setup asks "Scan the
    board, then I confirm" or "I'll explain it myself". The scan is read-only: the last 30
    issues, each issue type's fields, and from them the types in use, where each goes
    (active sprint, next sprint, backlog), parents, labels, components, fields usually set
    with their values, required fields, and fields left holding template text. Nothing is
    saved without the person's yes; an unclear scan falls back to explaining. The PM
    reads the rules before filing, `ticket_create` takes the Jira fields they call for, a
    required field the ticket leaves out is refused by name so the PM asks the person, and
    a ticket that fits no rule is the person's call. `/godmode setup` has a `tickets`
    topic, `update` offers it to a Jira note without the file, and a rule the person gives
    mid-session goes through `ticket_rules` and their yes.

- **D75. `/godmode audit`, in place after updates — decided by Gael 2026-11-23.** Gael keeps
  one session open for a long time and updates with `/plugin update` and `/reload-plugins`,
  never restarting, so nothing may wait on `session.start`. `/godmode audit` re-checks every
  saved answer (the answer rules and the live checks, the same code as `/godmode setup`'s
  `check` topic, which stays as the answers-only part), checks drift against the project as
  it is now (commands whose script is gone, a base branch that no longer exists, conventions
  files gone or edited by hand, `ticket-filing.md` missing on Jira, a worktree folder that
  cannot be made), lists what is new since the note's godmode version (what `update` asks),
  and suggests what a fresh scan finds that the note lacks (a new script, a new package
  manager). One short report: the checks that hold as a count, then each issue with its
  fix; one line when nothing needs fixing. It reads only: with issues, godmode goes to
  change-setup mode and the PM applies the fixes the person picks, saved on their yes.
  After a reload, the prompt hook compares the loaded version with the note's and suggests
  the audit in one line, once per version (kept in the person's store); it never runs it.

- **D76. The ticket-filing scan answers a fixed checklist — decided by Gael 2026-11-23.**
  The 0.7.1 scan counted issue types across the team's last 30 tickets, missed the sprint
  the "Atlassian MCP" server reports under `customFields` by label, and its multi-line
  log rendered stray characters. Counting types is noise. The scan now answers only the
  decisions godmode makes each time it files: the issue type per kind of work (bug,
  feature or change, chore, piece of a bigger item); where a new ticket goes, with the
  sprint naming pattern; the parent (required or not, of which type; ask the person which
  one unless one clear rule shows); the assignee (the person); each type's fields
  (Jira-required apart from team habit, with usual values, and template text as "fill or
  leave"); the title convention; the description template; labels and components only
  when used. The person's own tickets come first (reporter or creator, the last 40); the
  team's only settle what theirs do not, and each answer says its source. An item nothing
  settles is "?" and asked in plain words, never guessed. "Explain it myself" goes
  through the same checklist, and `ticket-filing.md` keeps its headings. Every multi-line
  text is logged one line per `$.ui.log` call, and every question is one line.

- **D77. Required human code review — decided by Gael 2026-11-23.** godmode's reviewer is a
  pre-review; some teams still need another person's approval before a PR merges. A team
  question, "Does a person other than the author have to approve the PR before it merges?",
  with the approval count and whose approvals count (anyone, or named people), its default
  read from GitHub branch protection when `gh` can read it. `update` and `/godmode audit`
  offer it to existing notes, and it sits in the `qa` change-setup topic. After godmode's
  clean review the PR is marked ready and named reviewers are requested; code review and
  QA run side by side, and the per-prompt check reports both. The merge needs the
  approvals at the PR's current commit, from someone other than the author and the person
  (GitHub's `reviewDecision` followed where branch protection gives one, else the latest
  review per person counted), plus QA and godmode's verdict as before. With code review on,
  a PR approval is a code-review approval, never a QA pass: the PR-approval QA signal
  counts only named QA approvers and is skipped when none are named. A review requesting
  changes shows in the per-prompt check, and the PM offers a fix round from it.

- **D78. godmode follows the project's rules; its own rules only fill gaps. Decided by Gael
  on 2026-11-23.** This supersedes D37's "hard rules in code" wherever a rule is a project
  policy.

  godmode is plug-and-play on any kind of dev project: solo or with others, with or without
  QA, reviewers, a tracker, CI or staging. Nothing is assumed from the kind of project.
  Gael: "IT DEPENDS. godmode will be a nice tool if it can make sense out of the
  instructions its given." It should feel like doing everything by hand, except that the
  tool does it.

  - **The project's instructions are the rules.** A rule a project could want differently
    comes from that project: setup answers, one plain-language rules file the person can
    edit, and what the person tells the PM. Examples are merge conditions, approvals, QA,
    the ticket flow, and how far godmode acts on its own. godmode enforces exactly those
    rules. Its own defaults apply only where the project said nothing, and they say so.
  - **Check the real state or ask; never refuse on unknown.** When godmode lacks
    information, it reads the live state (GitHub, the tracker, CI) or asks the person. A
    PR, branch or ticket godmode did not make is never refused for that reason, and godmode
    never asks to link, record or adopt it. No refusal suggests switching a rule off.
  - **The person's word goes through.** An explicit ask from the person is carried out,
    unless the project's own rules attach a condition to that action.
  - **godmode's way of working stays its own.** Its reviewer, QA agent, fix rounds, model
    tiers and thin main thread shape only the work godmode does. They never block the
    person, and they never become conditions on work godmode did not do.
  - **A short safety list stays fixed:** irreversible actions, and acting on other people's
    work. godmode asks the person first instead of refusing.

  **Setup starts with two questions**, then the scan, then one confirmation:
  1. Alone, or with others? With others, setup scans for or asks about their process:
     peer review, QA, conventions.
  2. Careful or not? godmode has full access either way. Careful means it asks the person
     before risky actions such as merging, force-pushing, deleting or touching others'
     work. Not careful means it does them.

  These two answers pre-fill every other answer. They decide behaviour only, never which
  tools exist. Tools and environments (tracker, CI, staging, PR template, branch
  protection) are facts about the project: the scan detects them or setup asks, whatever
  the two answers were. The person confirms everything on one summary. Setup asks only
  what the two answers and the scan could not settle. Every answer can be changed later.

  Not built yet. An audit of the current code (2026-11-23) lists 100 fixed rules: 63
  project policy, 16 safety, 21 internal. 41 of them refuse on unknown. That audit is the
  rebuild's checklist.
