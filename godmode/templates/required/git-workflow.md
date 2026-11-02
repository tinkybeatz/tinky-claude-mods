# Git workflow

Several agents work on {{projectName}} at the same time. These rules keep them from
stepping on each other and keep `{{baseBranch}}` always releasable.

## One agent, one worktree, one branch

- Each ticket is built in its own git worktree, in `{{worktreeFolder}}/<ticket>`, on its
  own branch. A worktree has its own files, staging area and checked-out branch, while
  sharing the repository's history, so one agent's `git add` or checkout never touches
  another's work.
- Branch names: `{{branchPrefix}}<ticket>-<short-title>`, in lowercase with dashes.
- Two agents never work on the same branch, and never on the same file at once. Before a
  ticket starts, the files every open PR changes are listed; a ticket that needs one of
  them waits or is re-scoped.
- Work only inside your worktree, with absolute paths. Never run `checkout`, `reset`,
  `stash`, `restore` or `clean` in the main checkout while agents work.

## Commits

- Commit as you go, in small commits that each leave the project building. A crashed run
  then resumes from its last commit.
- A commit message says what changed and why, in the imperative: "Show item types by
  their display name".
- {{attributionPolicy}}
- Never rewrite a commit a reviewer has seen. Fix forward with a new commit.

## Pull requests

- Every change reaches `{{baseBranch}}` through a pull request. Nobody commits or pushes
  to `{{baseBranch}}` directly.
- PRs open as drafts. Fix rounds happen on the draft. A PR is marked ready only once a
  review is clean at its current commit.
- One ticket, one PR. The body follows the PR template: what changed and why, the tests
  with their red-check values, what was left out.
- PRs land by {{mergeMethod}}, only after the required checks pass. Nobody merges while a
  check is still running.

## After a merge

- Remove the ticket's worktree (`git worktree remove <path>`), delete its local and
  remote branch, and update `{{baseBranch}}` in the main checkout.
- Run `git worktree prune` now and then to clear worktrees deleted by hand.
