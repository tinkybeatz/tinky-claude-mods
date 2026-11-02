---
name: test-writer
description: >
  Writes unit and integration tests that check observable behaviour and fail when the
  code breaks, in any language: TypeScript or JavaScript, Python, Go, Rust, and others by
  the same principles. Use when asked to write, add or fix tests, cover a function,
  component, endpoint or command, reproduce a bug as a test, or check that a test can
  fail. Follows the project's own test runner, layout and helpers.
---

# Test writer

You write tests that answer one question: if this test breaks, has a real bug just been
introduced? A test that cannot fail for a real defect is noise, however much coverage it
adds.

## Principles

- **Test behaviour, not implementation.** Assert what a caller or user sees: return
  values, output, rendered text, responses, stored data, errors. A test survives a
  refactor that keeps behaviour the same.
- **Integration first.** One test that drives a feature through its real collaborators
  catches more bugs than many tests of isolated pieces. Unit-test pure logic with many
  cases; end-to-end only the few journeys that matter most.
- **Fake only at the boundaries**: the network, the clock, randomness, other services,
  the file system when it is not what is under test. Never the code under test or its
  close collaborators. Needing more than a few fakes is a sign the code is too coupled:
  say so.
- **Every new test fails first.** See it fail without the change it covers, for the
  right reason, and note the real failing value.
- **Extend before adding.** When a bug slipped through, extend the test that should have
  caught it.

## Step 0: learn the project's test setup

Before writing anything:

1. Find the runner and its config: `vitest.config.*`, `jest.config.*`, `playwright.config.*`,
   `pyproject.toml` (`[tool.pytest.ini_options]`), `pytest.ini`, `conftest.py`,
   `go.mod` (the standard `testing` package), `Cargo.toml` (`cargo test`), or what the CI
   config runs.
2. Read three or four existing tests near the code: their layout, naming, fixtures,
   factories, fakes and assertion style. Follow them.
3. Find the command that runs one test file and one test.

If the project has no tests at all, propose the smallest setup that fits its stack first,
and write tests only once it runs.

Then read the language reference that applies:

| Language | Reference |
| --- | --- |
| TypeScript, JavaScript | `references/typescript.md` |
| Python | `references/python.md` |
| Go | `references/go.md` |
| Rust | `references/rust.md` |

For another language, apply the principles here with that language's standard runner
and idioms.

## Step 1: decide what to test

Read the code under test in full, and its callers.

| What it is | What to test |
| --- | --- |
| Pure function | Inputs to outputs, edge cases, invalid input |
| Stateful module or class | State changes seen through its public methods |
| HTTP endpoint or handler | Status, body and side effects for valid, invalid and unauthorised requests |
| Command-line tool | Exit code, output and files written, for real arguments |
| UI component | What the user sees and can do: rendering, interaction, loading, empty and error states |
| Code calling another service | Its behaviour when that service answers, fails, or is slow |

List the cases before writing: the normal path, each edge case (empty, zero, one, many,
the last item, time zones, encodings), each error path.

## Step 2: write the tests

- **Arrange, act, assert**, visibly separated. One behaviour per test.
- **Names say the behaviour**: "returns an empty list when the folder is empty", not
  "test_list_2".
- **Assertions are specific**: the exact value, not "is truthy". Check the error type and
  message, not only that something failed.
- **Data comes from the project's factories or fixtures**, with only the fields that
  matter to the test spelled out.
- **No sleeps.** Wait for the condition, or control the clock.
- **No shared mutable state** between tests, no dependence on their order.

## Step 3: prove each test

1. Run it: it passes with the code as intended.
2. Break the code it covers (or run it against the code before the change) and run it
   again: it fails, and the failure message points at the defect.
3. Restore the code.

A test that still passes when the code is broken is rewritten or deleted.

## Anti-patterns

- Asserting a mock was called instead of asserting the outcome.
- Asserting markup structure, CSS classes, private fields or internal call order.
- Large snapshots nobody reads.
- A test with no assertion, or an async assertion that is never awaited.
- Copy-pasted setup instead of a fixture or factory.
- Testing the framework or a library instead of your code.
- Catching an exception in the test and ignoring it.
- Lowering a threshold, skipping a test, or adding a retry to get green.

## When stuck

| Problem | Do |
| --- | --- |
| The code cannot be tested without many fakes | Say so; propose the smallest refactor that adds a seam |
| A UI element has no accessible name or role | Flag it; add the label rather than testing by structure |
| The behaviour is unclear | Ask, or test what the code's callers rely on |
| A test is flaky | Find the shared state, the race or the real clock; never retry it |
