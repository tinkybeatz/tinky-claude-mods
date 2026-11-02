# Quality gates

A change is done when every gate below passes in its worktree, in this order. Run them
before opening a PR and after every fix round. A reviewer runs them again.

{{gates}}

## Rules

- A red gate is fixed, never skipped, weakened or silenced. No lowered thresholds, no
  ignore comments, no deleted tests to get green.
- A gate that fails for a reason outside your change is reported in the PR body and to
  the PM, with the command and its output. It is not fixed in passing.
- A gate that cannot run (a missing tool, a service down) means the change is not done
  yet. Say what stopped it.

## Done means

- The ticket's ask is met, item by item, inside its scope.
- Every new test was seen failing first, and the PR body quotes the value.
- Every gate above passes.
- The PR body follows the template, and names anything left out or not checked.
- The review is clean at the PR's current commit, and QA passed when the change is
  visible to users.
