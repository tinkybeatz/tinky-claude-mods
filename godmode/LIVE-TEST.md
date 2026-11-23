# godmode — first full live test (temporary)

This file is temporary. It is deleted once the test is reported.

One test of the finished build, on a personal project.

## Install and start

Once godmode is listed in the marketplace:

```
/plugin marketplace add tinkybeatz/tinky-claude-mods
/plugin install godmode@tinky-claude-mods
```

If the install fails, run it from a clone instead:

```
git clone https://github.com/tinkybeatz/tinky-claude-mods ~/tinky-claude-mods
cd <your project>
claude --plugin-dir ~/tinky-claude-mods/godmode --debug
```

If the folder was cloned earlier, run `git -C ~/tinky-claude-mods pull` first. Then type
`/godmode` in the project.

## What to report back

- [ ] 1. Setup dialogs: did the setup questions pop up as dialogs you could answer, or
  did the main thread ask them in chat? Were the first two "Alone / With others" and
  "Careful / Not careful", with nothing asked before them?
- [ ] 2. Summary: after those two, did one summary show each area (commands, git and PRs,
  merging, QA, tickets, risky actions, attribution, rules) with its value and its source
  (`scan`, `alone`, `with others`, `careful`, `not careful`, or `?`)? Did areas with
  detailed rules name their file (git workflow, PR template, `ticket-filing.md`)? Was
  anything wrong?
- [ ] 3. "?" items: were only the "?" items asked, one question each, each with a "none"
  answer? How many questions did the whole setup take?
- [ ] 4. Confirm: did it end on "Save" or "Change something"? Try "Change something" once:
  did it ask only the part you picked, then show the summary again?
- [ ] 5. Scan: did it get the stack, the build, test and start commands, the git host,
  branch protection (approvals, required checks) and CI right?
- [ ] 6. Conventions: which files did it write or change, and where? Did it ask before
  touching an existing file? Is `project-rules.md` in the conventions folder, and does it
  read right? Edit a line by hand: does the next `/godmode` say it was edited?
- [ ] 7. QA: if you said "With others", did it ask who tests (no one, on the PR, on
  staging) and the right follow-ups (the board's statuses, the pass signals)? Which mode
  (`human-pr`, `human-staging`, `bot`, `none`) did you end on?
- [ ] 8. Indicator: does the "godmode is on" marker show (godmode's side pane by default, the band while the
  pane cannot be shown)? Check the side pane:
  - [ ] 8a. Does the pane open at the next switch-on, in setup, change-setup and coding
    mode alike, under a red GODMODE header?
  - [ ] 8b. Sections: does "Waits on you" show (a go to start, QA, a merge go, a
    fix-round go) only when something waits, the tickets with their status, a running
    `/godmode try` with its link, then the Active and Finished tabs with each agent named
    by its role and ticket, and the usage bars?
  - [ ] 8c. Narrow window (under 144 columns): does the band show instead? Close the
    pane by hand: does the band stand in until the next `/godmode`?
  - [ ] 8d. `/godmode off`: does the pane close?
  - [ ] 8e. With the dispatch panel plugin on too: do both panes show, each with its own
    content, and does closing one leave the other alone?
- [ ] 9. Second `/godmode`: does it go straight to coding mode, with no setup? Ask the PM
  which QA mode it was told: it gets a hidden "QA mode: X" line. Does X match your
  answer?
- [ ] 10. One small ticket, end to end: ask the PM for one, then say go. Was a dev agent
  dispatched, did it open a draft PR, did a review start by itself, did godmode's QA agent
  run if it was on, was the PR marked ready, and did the merge follow your Care answer
  (asked for your "merge" when careful, merged once the conditions held when not)?
- [ ] 11. Merge conditions: say "merge" on a PR that misses one (CI still running, or no
  approval). Careful: did godmode name what is missing with its live state, and did
  "merge anyway" go through? Not careful: did it merge and say what was missing?
- [ ] 12. A PR godmode did not make (yours or someone else's): did "merge" check its
  conditions without asking to link it to a ticket?
- [ ] 13. Risky actions: ask for one (close a PR, delete a branch). Careful: did it ask
  first, and go through once you said so? Not careful: did it just do it?
- [ ] 14. `/godmode try <ticket>` on that ticket: did the app start and the link work?
  Did `/godmode try stop` stop it?
- [ ] 15. `/godmode report`: was the status right?
- [ ] 16. `/godmode setup`: change one answer in your own words. Did only that question
  come up, did the summary show before the save, and did it save only on your yes?
- [ ] 17. `/godmode audit`: after a `/plugin update` and `/reload-plugins`, did the next
  prompt suggest it once? On a setup from before 0.8.0, did it offer Who and Care and
  show your old answers mapped on the summary? Did a fix save only on your yes?
- [ ] 17a. `/godmode reset` (at the very end, on a throwaway copy or a project you are
  done with): did it list every trace first and ask "Wipe all of this?" once? Did Cancel
  leave everything as it was? After Wipe, are `.godmode/`, the files setup wrote and the
  ignore lines gone, your own files and the team's conventions still there, a worktree
  holding work kept, and in committed storage the deletions left uncommitted? Did
  `/godmode` then start a fresh setup?
- [ ] 18. A fix round: get a review or QA to fail (ask for a ticket with a known flaw, or
  fail QA yourself). Did the same dev agent fix it, and was it reviewed again?
- [ ] 19. Anything refused or stuck: paste the exact text. Did any refusal tell you to
  switch a rule off, rather than what to ask for or what is missing?
- [ ] 20. Errors: paste any red line or dim "skipped" line, what `/plugin` → Errors shows,
  and the godmode lines of the debug log.

## Also say

- [ ] Whether the laptop uses a work (organization-managed) login, since some hooks are skipped there.
- Screenshots are fine.
- If something breaks, the newest file in `~/.claude/debug/` holds the log. Send its godmode lines.
