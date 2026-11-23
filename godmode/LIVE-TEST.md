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
  did the main thread ask them in chat?
- [ ] 2. Scan: did it get the stack, the build, test and start commands and the git host
  right?
- [ ] 3. Conventions: which files did it write or change, and where? Did it ask before
  touching an existing file?
- [ ] 4. QA mode: did it ask whether people test, then the right follow-ups for your
  answers (on the PR or on staging, the QA agent first or not, the pass signals)? Which
  of the four modes (`human-pr`, `human-staging`, `bot`, `none`) did you end on?
- [ ] 5. Indicator: does the "godmode is on" marker show, in the style you picked (mode
  label, hint tag or band)?
- [ ] 6. Second `/godmode`: does it go straight to coding mode, with no setup? Ask the PM
  which QA mode it was told: it gets a hidden "QA mode: X" line. Does X match your
  answer?
- [ ] 7. One small ticket, end to end: ask the PM for one, then say go. Was a dev agent
  dispatched, did it open a draft PR, did a review start by itself, did QA run as your
  mode says, was the PR marked ready, and did it merge only on your go?
- [ ] 8. `/godmode try <ticket>` on that ticket: did the app start and the link work?
  Did `/godmode try stop` stop it?
- [ ] 9. `/godmode report`: was the status right?
- [ ] 10. `/godmode setup`: change one answer in your own words. Did only that question
  come up, and did it save only on your yes?
- [ ] 10b. `/godmode audit`: after a `/plugin update` and `/reload-plugins`, did the next
  prompt suggest it once? Was the report one line on a clean project, or each issue with
  its fix, and did a fix save only on your yes?
- [ ] 11. A fix round: get a review or QA to fail (ask for a ticket with a known flaw, or
  fail QA yourself). Did the same dev agent fix it, and was it reviewed again?
- [ ] 12. Anything refused or stuck: paste the exact text.
- [ ] 13. Errors: paste any red line or dim "skipped" line, what `/plugin` → Errors shows,
  and the godmode lines of the debug log.

## Also say

- [ ] Whether the laptop uses a work (organization-managed) login, since some hooks are skipped there.
- Screenshots are fine.
- If something breaks, the newest file in `~/.claude/debug/` holds the log. Send its godmode lines.
