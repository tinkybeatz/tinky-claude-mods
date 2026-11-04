# godmode — first live test (temporary)

This file is temporary. It is deleted once the test is reported.

## Install and start

```
git clone https://github.com/tinkybeatz/tinky-claude-mods ~/tinky-claude-mods
cd <your project>
claude --plugin-dir ~/tinky-claude-mods/godmode --debug
```

godmode is not in the marketplace yet, so it runs from the clone. If the folder was cloned earlier, run `git -C ~/tinky-claude-mods pull` first. Then type `/godmode`.

## What to report back

- [ ] 1. Setup questions: did they pop up as dialogs you could answer, or did the main thread ask them in chat? (The one thing not yet proven.)
- [ ] 2. Scan: did it get the stack, the build/test/start commands and the git host right?
- [ ] 3. Conventions: which files did it write or change, and where? Did it ask before touching an existing file?
- [ ] 4. Indicator: does the "godmode is on" marker show, in the style you picked (mode label, hint tag or band)?
- [ ] 5. Second `/godmode`: does it go straight to coding mode, with no setup?
- [ ] 6. One small ticket: ask the PM for one. Was a dev agent dispatched, did it open a draft PR, and did a review start by itself?
- [ ] 7. Anything refused or stuck: paste the exact refusal text.
- [ ] 8. Errors: paste any red line or dim "skipped" line, and what `/plugin` → Errors shows.

## Also say

- [ ] Whether the laptop uses a work (organization-managed) login, since some hooks are skipped there.
- Screenshots are fine.
- If something breaks, the newest file in `~/.claude/debug/` holds the log. Send its godmode lines.
