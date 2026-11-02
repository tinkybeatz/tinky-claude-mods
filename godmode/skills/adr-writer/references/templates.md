# ADR templates

Use the project's own format when it has one. Otherwise, the default below; the minimal
one for small decisions.

## Default

```markdown
# ADR-NNNN: <noun phrase naming the decision>

- Date: YYYY-MM-DD
- Status: proposed | accepted | deprecated | superseded by ADR-NNNN
- Confidence: high | medium | low
- Deciders: <names or roles>

## Context

<The problem and the forces at play: technical, product, team, time. Neutral, factual.>

## Decision drivers

- <the factor that weighed most>
- <the next one>

## Options considered

1. **<Option A>**: <one line>.
2. **<Option B>**: <one line>.

## Decision

We will <the decision>.

<Why this option over the others, tied to the drivers.>

## Consequences

- Good: <...>
- Bad: <...>, mitigated by <...>
- Neutral: <...>

## Links

- <related ADRs, tickets, PRs, docs>
```

## Minimal

```markdown
# ADR-NNNN: <title>

- Status: proposed | accepted | deprecated | superseded by ADR-NNNN

## Context

<The forces at play.>

## Decision

We will <the decision>.

## Consequences

<Good, bad and neutral.>
```

## A first ADR, when a project starts recording them

```markdown
# ADR-0001: Record architecture decisions

- Date: <today>
- Status: accepted

## Context

The reasons behind the project's technical choices live only in people's heads and old
conversations. When a choice is questioned, nobody can say what it was weighed against.

## Decision

We will record each significant technical decision as a short Markdown file in
`docs/adr/`, versioned with the code.

## Consequences

- Good: the reasons survive, and newcomers can read the history of the choices.
- Bad: each significant decision costs a few minutes of writing.
- Neutral: ADRs do not replace design docs or code comments.
```
