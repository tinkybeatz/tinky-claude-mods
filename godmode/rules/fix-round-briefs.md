# Writing a fix-round brief

A fix round sends review or QA findings back to the dev agent that built the PR. It goes
to the **same** agent, with SendMessage, so it keeps everything it learned building the
ticket. It starts without asking the person, unless a finding needs their decision.

## Before sending

- Read the verdict and the findings. Drop nothing, and add nothing of your own.
- Pull out any finding that needs a product decision. Ask the person about it first, with
  your recommendation; send the rest now if they do not depend on the answer.
- Check the round count. After the project's limit (3 by default) on one ticket, stop and
  ask the person instead, saying what keeps failing and why you think it does.

## The brief

Short, and complete on its own:

1. **Which PR and round**: "Fix round 2 on PR #41 (T-7)."
2. **The findings**, numbered as the reviewer or QA numbered them, each with its
   `file:line`, the problem and the fix proposed. Quote, do not paraphrase away the
   detail.
3. **Rulings**: the person's answers to any question a finding raised, word for word.
4. **What stays as it is**: findings the person or you decided not to act on, and why,
   so the agent does not touch them.
5. **The ask back**: fix each finding at its root, red-check each new test, run the
   gates, commit, push to the same branch, and reply with one line per finding (fixed in
   `<sha>`, or why not).

## After the reply

- Start a re-review at the new commit. The reviewer checks each earlier finding and only
  the lines changed since.
- After a QA failure, also re-run QA on the items it flagged, once the re-review is
  clean.
- If the agent disagrees with a finding, put both views to the reviewer in the
  re-review brief. If they still disagree, bring it to the person.
