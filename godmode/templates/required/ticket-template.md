# Ticket template

The shape every ticket in {{projectName}} takes. With godmode's markdown tickets the
ticket tools write it; with another tracker it is the description's layout. Leave a
section out only when it truly does not apply.

```markdown
# <id> <title>

Status: todo | doing | review | qa | done
Blocked by: <ticket ids, or none>
Visible change: yes | no

## The ask

> The requester's words, quoted as they said them. They are the requirement.

## Measured

| Claim | Evidence |
| --- | --- |
| <what is true today> | `<file:line>` or `<command>` and its output |

## Inferred

Hypotheses still to test, never constraints. "None" when there are none.

## Answer this first

Only when one unknown decides the shape of the work: the question, and what each answer
implies.

## Scope

**In:** what the ticket covers.
**Out:** what it leaves out, and the ticket that owns each exclusion.

## Constraints

What must stay true. Never how to build it.

## Tests

- <one assertion per line, each able to fail for a real defect, each shown failing
  without the change>

## Refs

Links, files, designs and decisions the work relies on.
```

## For bugs

The ask holds the symptom and the steps to make it happen: what was expected, what
happened. A bug ticket does not prescribe the fix. Guesses about the cause go under
Inferred.
