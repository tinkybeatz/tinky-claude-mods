---
name: change-advisor
description: >
  A quick, risk-proportional check before a change that is costly to undo: scores its
  risk, recommends deploy, deploy with conditions, hold or investigate, and lists what to
  check and how to roll back. Use before deploying to production, merging a large or risky
  PR, a database migration, a major dependency or runtime upgrade, an infrastructure or
  auth change, or when someone asks "is it safe to ship this?". Skip it for changes a
  plain revert undoes in seconds.
---

# Change advisor

You assess the risk of one change and give a recommendation in minutes, not a meeting.
The process is proportional: low-risk changes pass straight through, and only changes
that are hard to undo get a checklist and a rollback plan.

## Is it worth it?

- **Yes** when rolling back needs more than a revert: a data migration, a schema change,
  an infrastructure or DNS change, an auth or security change, a major upgrade, the first
  release of a new service, a change across several services.
- **No** for a change a revert undoes in seconds with nobody noticing: copy changes, an
  isolated, well-tested component. Say so in one line and stop.

## Step 1: inventory

Read the diff, the configs and the migration files. Then write:

```text
Change: <one or two sentences>
Touches: <n> files in <areas or services>
Kind: code | dependency | database | infrastructure | config | mixed
Rollback: trivial (revert) | moderate (reverse migration, redeploy) | hard (data loss, coordination)
```

## Step 2: score

**Impact if it fails (1-5):** 1 nobody notices; 2 a few users, with a workaround; 3 a
feature degraded for many; 4 a service down; 5 data loss, a security breach, or every
user affected.

**Likelihood of failure (1-5):** 1 routine and tested; 2 tested, a little complexity;
3 some unknowns; 4 new technology or thin tests; 5 untested or novel.

**Score = impact × likelihood (1-25)**, then adjust:

- add 1 to 3 for: a data migration, an auth or security change, no rollback plan, thin
  tests on the changed code, shipping at peak time, a first release;
- subtract 1 to 2 for: a feature flag, a canary or staged rollout, monitoring and alerts
  on the affected path, the same change already running in a staging environment.

| Score | Level | Recommendation |
| --- | --- | --- |
| 1-4 | Low | **Deploy.** |
| 5-9 | Medium | **Deploy with conditions**: a short checklist first. |
| 10-15 | High | **Hold** until the checklist is done and the rollback is tested. |
| 16-25 | Critical | **Investigate**: stage the rollout or flag it; no deploy without a tested rollback. |

## Step 3: recommend

```markdown
## Change check: <name>

Risk: <n>/25, <level>. Recommendation: <DEPLOY | DEPLOY WITH CONDITIONS | HOLD | INVESTIGATE>

| Axis | Score | Why |
| --- | --- | --- |
| Impact | x/5 | ... |
| Likelihood | x/5 | ... |
| Adjustments | +n / -n | ... |

Before: <checklist proportional to the risk: backups taken, migration tried on a copy,
flag in place, the people who must know told>
Rollback: <the exact steps, and how long they take>
After: <what to watch, for how long: error rate, latency, the business numbers this
change can move>
```

## After the change

If the person comes back after shipping, write a short review: what was shipped, the
outcome, what the numbers did, anything that surprised, and what to do differently next
time. When a kind of change always goes well, lower its default score; when it keeps
failing, raise it.

## Keep it honest

- Checking takes minutes. If it takes longer, the process is too heavy: trim it.
- It never replaces tests and review; it covers what they cannot, the cost of being
  wrong in production.
- In a godmode loop, before asking the person for a merge go on a risky PR, the PM has a
  researcher run this check, and puts the recommendation in front of them with the go
  question.
