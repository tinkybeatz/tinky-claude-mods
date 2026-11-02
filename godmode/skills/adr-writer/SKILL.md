---
name: adr-writer
description: >
  Writes Architecture Decision Records: short, immutable documents that capture one
  significant technical decision with its context, the options considered and the
  consequences. Use to "write an ADR", "document this decision", "record why we chose
  X", backfill a decision already in the code, supersede an earlier ADR, or review an
  ADR. Not for comparing options before deciding, and not for standards.
---

# ADR writer

An ADR answers the question a future developer will ask: "why is it like this?" It
records one decision, made for reasons, at a moment in time.

## Modes

| Mode | Signal | You produce |
| --- | --- | --- |
| **Write** | "write an ADR for ..." | A new ADR |
| **Backfill** | "document this existing decision" | An ADR for a decision already in the code |
| **Supersede** | "this replaces ADR-0007" | A new ADR, and the old one's status updated |
| **Review** | "review this ADR" | A score and fixes |

## Step 0: find the project's ADRs

- Look for an ADR folder (`docs/adr/`, `doc/adr/`, `docs/decisions/`, or the path the
  project's conventions name). Read the existing ADRs: their numbering and their format.
- If the project has a format, follow it exactly. If it has none, use
  `references/templates.md` and create `docs/adr/` (or the path the conventions name).
- If the project keeps a decisions log, add a one-line entry there linking to the ADR.

## Step 1: frame the decision

From the conversation, or by asking:

- **What** was decided, concretely.
- **Why now**: the trigger (a new need, an incident, a limit reached).
- **Constraints**: time, team, platform, compliance, existing code.
- **Options considered**: at least two, including "keep things as they are" when it was
  a real option.
- **Who decided**.

For a backfill, also: when it was decided, and whether it still holds. Read the code to
confirm what was actually built.

## Step 2: write it

Substance:

1. One ADR, one decision.
2. The why, not the how. Implementation detail belongs in the code and its docs.
3. The context states the forces neutrally, so a reader could weigh them before reading
   the decision.
4. The decision is in the active voice: "We will ...".
5. Consequences cover the good, the bad and the neutral, with mitigations where they
   exist.

Form:

6. File name `NNNN-title-with-dashes.md`, numbered after the highest existing number.
   Numbers are never reused.
7. One to two pages. Link out for more.
8. Full sentences, written the way you would explain it to a colleague.

Lifecycle:

9. An accepted ADR is never edited for substance. A changed decision gets a new ADR that
   supersedes it.
10. Statuses: `proposed`, `accepted`, `deprecated`, `superseded by ADR-NNNN`. A
    superseding ADR and the one it replaces link to each other.

## Step 3: check before delivering

- [ ] The title names the decision, not the problem.
- [ ] The context is neutral and complete.
- [ ] At least two options, each with why it was or was not chosen.
- [ ] Consequences: good, bad and neutral.
- [ ] The number is the next in sequence; the file name follows the pattern.
- [ ] No empty section, no placeholder left.

Then report in a few lines: the ADR number and title, its status, the decision in one
sentence, and its path.

## Review

Score out of 100: clarity of the reasons (25), completeness of the options (20), quality
of the consequences (20), neutrality of the context (15), form and conventions (20). 80
or more is ready to accept; 60 to 79 needs the listed fixes; under 60, rewrite.

## When not to write one

- No real alternative existed: a decisions-log line is enough.
- The decision is a durable rule for everyone: that is a standard.
- Nothing is decided yet: write up the options, not an ADR.
