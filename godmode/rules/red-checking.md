# Red-checking a test

A red-check shows that a test fails without the change it covers. A test that has never
been seen failing proves nothing: it may assert its own setup, or nothing at all. Every
new or changed test gets one. "Not applicable" is never accepted.

## How the dev agent does it

1. Write or extend the test first, before the fix, when you can.
2. Run it against the code without your change and watch it fail. Two ways:
   - before you write the fix, on your branch;
   - after, by putting the old code back for one run (`git stash` the source change, or
     check out the source files from the base branch), running the test, then restoring
     your change.
3. Check it fails **for the right reason**: the assertion about the behaviour fails, not
   an import error, a typo or a missing fixture.
4. Quote the real failing value in the PR body: "expected `Text`, received
   `text-item`". Then quote the same test passing with the change.

For a bug fix, the red-check is the reproduction: the test fails on the base branch with
the bug's symptom.

## How the reviewer reproduces it

Without editing the dev agent's worktree:

1. Make a detached scratch worktree at the PR's base commit, in the system's temporary
   folder.
2. Copy the PR's new or changed test files into it (`git show <head>:<path>`).
3. Run those tests there. They must fail, for the reason the PR body quotes.
4. Remove the scratch worktree.

If a test passes without the change, it is a finding: the test does not cover what it
claims.

## Tests worth keeping

- Extend the test that should have caught the defect before adding a new one.
- Assert behaviour a user or caller sees, never markup, call order or private state.
- One clear reason to fail per test. No test that can only pass.
- No sleeps, no dependence on test order, no real network or clock unless that is what is
  under test.
