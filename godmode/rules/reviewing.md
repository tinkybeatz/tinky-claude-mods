# Reviewing a PR

A review decides whether a change may go further. It is read-only, it happens at one
commit, and it ends with a verdict recorded at that commit.

## Read first

1. The ticket: the ask, scope, constraints and tests. The PR is judged against it before
   anything else.
2. The diff, then the code it touches: callers of every changed function, the functions
   it calls, the tests, the docs.
3. The project's review checklist, coding standards and testing rules.

Trace the real flow: where data comes in, what is stored, what goes out. Find the
project's expected load (one person running a script, or many users at once) and judge
against that, saying which load you assumed.

## What to look for, in order of weight

1. **Spec.** The change does all of the ask, nothing outside the scope, and keeps every
   constraint. The ticket's tests are there.
2. **Bugs.** Wrong results; missed edge cases (empty, zero, the last item, rounding, time
   zones, encodings); a caller broken by a changed signature or behaviour; a fix applied
   in one caller while the shared code stays broken.
3. **Risk.** Injection, missing checks on user input, secrets in code or logs, weak
   randomness, errors swallowed, writes in the wrong order, no transaction where one is
   needed.
4. **Load.** Check-then-write races, the same work done by every process, lists or
   caches that only grow, a query per item, quadratic work on large input.
5. **Tests.** Every new or changed test fails without the change (reproduce it, see
   `red-checking.md`). Tests assert behaviour, not their own setup, markup or call
   order. An existing test was extended where one should have caught the bug.
6. **Gates.** Every gate the project lists passes when you run it.
7. **Lean.** Dead code, options nobody sets, an abstraction with one use, a helper the
   project already has, near-copies that must change together.
8. **Conventions.** The project's written standards. Only written ones: no taste.

## Writing findings

- Every finding has a concrete case: "this input, in this situation, gives this wrong
  result". No case, no finding.
- Re-read the lines before reporting: the caller exists, the value can really be empty,
  the code really is unused.
- Give a `file:line`, the problem in a sentence or two, and the smallest fix. Prefer
  fixes that delete code.
- A shortcut the code marks with its limit (`shortcut: <limit>, <when to upgrade>`) is a
  decision, not a finding, unless the expected load already crosses it.
- Group findings: **must fix**, **should fix**, **suggestion**. Number them across the
  groups.

## The verdict

| Verdict | When |
| --- | --- |
| `clean` | Nothing must or should be fixed. Suggestions may remain. |
| `change-request` | Findings the dev agent can fix inside the ticket. |
| `blocker` | The approach or the ticket is wrong, or a product decision is needed first. |

A gate you could not run, or a check you could not make, means the verdict is not
clean: say what stopped you.

## Re-reviews

After a fix round: check each earlier finding against the new commit, then review only
the lines changed since the commit you last reviewed, and run the gates again. Docs-only
or config-only PRs may get one lighter pass, saying so.
