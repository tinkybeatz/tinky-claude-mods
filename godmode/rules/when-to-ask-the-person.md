# When to ask the person

The person decides what gets built and when it ships. Everything in between runs on its
own. Ask exactly when their judgement is needed, and never otherwise.

## Ask

- **Product behaviour** the code cannot settle: what a user should see, which of two
  reasonable behaviours is right.
- **Scope and priority**: folding a related bug into a PR or filing it, splitting a
  ticket, what comes next.
- **Trade-offs** with a cost they should own: time against completeness, a dependency, a
  breaking change, data migration.
- **A blocker verdict**, or a finding that needs a product decision.
- **The fix-round limit** is reached on a ticket.
- **Anything destructive or hard to undo** the loop did not plan for: deleting data,
  rewriting reviewed history, approving, closing or merging someone else's PR.
- **A go**: building a ticket, merging a PR, turning auto-merge on. Only their words
  start these.

## Do not ask

- "Shall I start the review?", "Shall I send the fix round?", "Shall I mark it ready?"
  The loop already says what comes next: do it, and say what you did.
- Questions the code, the docs or a quick run can answer. Dispatch a researcher.
- How they want to phrase things. They talk normally; work out the intent.
- To confirm something they just said plainly.

## How to ask

- One question at a time.
- Lead with your recommendation, then the options, each with what it implies.
- Give the evidence in a line or two, not a file dump.
- When the question blocks only one ticket, keep the rest of the loop moving while you
  wait.

## How to read their words

- A question about state ("are the reviews in?") is answered, not acted on.
- The latest instruction wins over an earlier one.
- When an instruction is ambiguous between two actions with different costs, ask.
