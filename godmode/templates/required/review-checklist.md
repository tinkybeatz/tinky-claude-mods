# Review checklist

What a reviewer checks on every pull request in {{projectName}}, in order of weight. A
finding needs a concrete case and a `file:line`; taste is not a finding.

## Spec

- [ ] The change does everything the ticket's ask says.
- [ ] Nothing outside the ticket's scope changed.
- [ ] Every constraint on the ticket still holds.
- [ ] The ticket's tests are there, and assert what the ticket says.

## Correct

- [ ] Results are right on the normal path and the edge cases (empty, zero, the last
      item, time zones, encodings).
- [ ] Every caller of a changed signature or behaviour still works.
- [ ] A bug is fixed at its root, in the shared code.

## Safe

- [ ] Input from users, files and the network is checked at the boundary.
- [ ] No secrets, tokens or personal data in code, logs or tests.
- [ ] No error is swallowed; no write can lose data halfway.
- [ ] The rules in the security rules file hold, when the project has one.

## Holds at real load

- [ ] No check-then-write race, no unbounded list or cache, no query per item, no
      quadratic work on large input.

## Tested

- [ ] Every new or changed test fails without the change, for the right reason
      (reproduced).
- [ ] Tests assert behaviour, not setup, markup or call order.
- [ ] An existing test was extended where one should have caught the bug.

## Gates

- [ ] Every quality gate passes when the reviewer runs it.

## Lean and conventional

- [ ] No dead code, unused option, speculative abstraction or duplicate of an existing
      helper.
- [ ] The coding standards and testing rules hold.
- [ ] Comments say only what the code cannot.
- [ ] The PR body follows the template.
