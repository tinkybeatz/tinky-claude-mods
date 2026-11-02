# Testing rules

A test earns its place by failing when the code breaks. Every rule here serves that.

- Run all tests: `{{testCommand}}`
- Run one: `{{singleTestCommand}}`
- Tests live: {{testLocation}}

## Every new test fails first

- Each new or changed test is shown failing without the change it covers, for the right
  reason (the behaviour assertion, not an import error).
- The PR body quotes the real failing value ("expected `Text`, received `text-item`"),
  then the same test passing.
- "Not applicable" is never accepted. A change nobody can test is a finding to raise.

## Extend before adding

- When a bug slipped through, extend the test that should have caught it before writing a
  new one.
- Reuse the project's existing fixtures, factories and helpers. Add a new helper only
  when two tests need it.

## What a good test asserts

- Behaviour a user or a caller can see: outputs, rendered text, responses, stored data,
  errors raised.
- Never its own setup, private state, markup structure, or the order of internal calls.
- One clear reason to fail per test, named in the test's name ("returns an empty list
  when the folder is empty").
- Edge cases the code handles: empty, zero, the last item, an error from a dependency.

## What to fake

- Fake only at the boundaries: the network, the clock, randomness, the file system when
  it is not under test, other services.
- Never fake the code under test or its close collaborators. Needing many fakes is a sign
  the code is too coupled; say so.

## Reliability

- No sleeps or fixed waits; wait for the condition.
- No dependence on test order, the machine's time zone or locale, or leftover state.
- A flaky test is a bug. Fix it or file it; never retry it until it passes.

## Language notes

{{testingNotes}}
