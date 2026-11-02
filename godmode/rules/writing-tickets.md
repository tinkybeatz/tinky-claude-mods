# Writing a ticket

A ticket is ready when a dev agent could build it without asking a single question.
Writing it is the real work of the loop: every slot below exists because leaving it out
once cost a build.

## Before writing

- Have a researcher read the code the work touches. Suggest nothing before you know what
  exists.
- Look for what to reuse: a helper, a component, a pattern, an earlier decision. Propose
  it before anyone writes code.
- Recommend one approach. A list of options is for real trade-offs only, each with what
  it costs.
- Ask the person only what the code cannot settle, one question at a time.
- Split work that would make one PR too big to review properly. Each ticket should be
  reviewable in one sitting and shippable on its own.

## The slots

Filled through `mcp__godmode__ticket_create`. Leave a slot out only when it truly does
not apply.

| Slot | What goes in it |
| --- | --- |
| **Title** | The change, in a few words. |
| **The ask** | The person's words, quoted as they said them. They are the requirement. |
| **Measured** | Claims checked against the code or a run, each with its evidence: a `file:line`, a command and its output. A claim without evidence is visibly unfinished. |
| **Inferred** | Hypotheses still to test, never constraints. Write "none" when there are none, so it reads as a decision. |
| **Answer this first** | Only when one unknown decides the shape of the work. Say what each answer implies. |
| **Scope: in / out** | Out matters more than in. Name the ticket that owns each exclusion, if any. |
| **Constraints** | What must stay true (one source of names, no new dependency, an API kept stable). Never how to build it. |
| **Tests** | One line per assertion, each able to fail for a real defect, each to be shown failing without the change. |
| **Refs** | Links, files, designs, decisions the work relies on. |
| **Blocked by** | Ticket ids that must be done first. A blocker in its own field cannot be buried in prose. |
| **Visible change** | Yes when a user would see or feel the change. QA runs only when it is yes. |

## Bugs

- A bug ticket says what is wrong and how to make it happen: the symptom, the steps, what
  was expected, what happened. It does not prescribe the fix; the dev agent finds the
  cause.
- Guesses about the cause go under Inferred, labelled as guesses.
- A hunch is not a bug report yet. Check it first, then file it.

## Decisions

- When the person must choose (a product trade-off), file a decision ticket: the
  options, what each costs, your recommendation. It keeps the options not taken, so they
  can be picked up later.
- Once they rule, record the ruling on the ticket at once.

## After filing

Say in one line what was filed, its id, whether it clashes with an open PR, and stop.
Filing never starts a build.
