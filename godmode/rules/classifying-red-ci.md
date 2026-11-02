# Classifying a red CI run

Before acting on a failed CI run, decide what kind of failure it is. Each kind has one
response. Read the failing job's log (a researcher or a background shell does the
reading; `gh pr checks` and `gh run view --log-failed` give it).

| Kind | Signs | Response |
| --- | --- | --- |
| **Real failure** | A test, lint or type error that touches code the PR changed or depends on; it fails the same way on a re-run or locally. | A fix round to the dev agent, with the job, the failing check and the log lines. |
| **Base breakage** | The same check fails on the base branch too, or on other PRs, without their changes. | Not this PR's fault. Tell the person, and file a ticket if none exists. The PR waits. |
| **Flake** | A failure in code the PR does not touch, that passes on a re-run, or a known unstable test. | Re-run the failed jobs once. If it passes, report it in one line and note the test as flaky on a ticket. If it fails twice, treat it as real. |
| **Infrastructure** | Runner lost, timeout before tests start, registry or network errors, quota or permission errors. | Re-run once. If it fails again, tell the person: it needs someone with access. |
| **Not run** | Checks skipped on a draft, or waiting for approval. | Nothing to fix. Say so if asked. |

## Rules

- A flaky test can hide a real bug (a race, a time-zone or ordering assumption). If a
  flake touches the area the PR changed, treat it as real.
- Never re-run more than once on the same commit without telling the person.
- Never disable, skip or retry-loop a test to get green. That is a finding, not a fix.
- A merge waits for the required checks to finish. A merge never goes in while a check
  is still running.
