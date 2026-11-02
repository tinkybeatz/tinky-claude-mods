---
name: standard-maker
description: >
  Creates, audits and updates an engineering standard for a project: a short normative
  document with checkable rules, how each is enforced, and its reasons. Use when asked to
  "create a standard for", "write the rules for", "define a convention", "standardise X",
  or to audit or update an existing standard (code, tests, reviews, CI, security, docs,
  git). Not for one-off decisions (those are ADRs or decisions-log entries).
---

# Standard maker

A standard is a technical contract: rules that remove ambiguity, each one checkable,
each one enforced somehow, each one with its reason. It is not an opinion piece and not
a tutorial.

## Modes

| Mode | Signal | You produce |
| --- | --- | --- |
| **Create** | "create a standard for ...", "standardise ..." | A complete standard |
| **Audit** | "audit this standard", "is this standard good" | A score and the fixes |
| **Update** | "add a rule", "update this standard" | The revised standard, versioned |

## Create

1. **Frame the problem** in one sentence: what goes wrong without this standard, who it
   affects, and how anyone would see that it works. If nobody can say what problem it
   solves, there is no standard to write: say so.
2. **Gather evidence.** Look at the project first: recurring review findings, bugs,
   incidents, the conventions the code already follows. Then official documentation and
   recognised references for the topic. Cite what each rule rests on.
3. **Write the rules**, each with a keyword that sets its strength:

   | Keyword | Meaning |
   | --- | --- |
   | MUST / MUST NOT | Absolute. Breaking it blocks a merge. |
   | SHOULD / SHOULD NOT | Strong default; an exception needs a stated reason. |
   | MAY | Allowed, optional. |

   Each rule is unambiguous (one reading), testable (a clear pass or fail), enforceable
   (by a tool or a review step) and scoped (where it applies, where not).
4. **Say how each rule is enforced**: a linter rule, a CI check, a hook, a review
   checklist item. Prefer automatic enforcement; a rule enforced by nobody will drift.
5. **Write the file** from `references/template.md`, in the project's conventions
   folder, and link it from the agent rules file and the review checklist when it
   applies to every change.

Keep it short. A standard agents read on every ticket should fit on a screen or two;
move examples to an appendix.

## Audit

Score out of 100:

| Criterion | Points |
| --- | --- |
| Rules are clear and precise | 25 |
| Rules are testable and enforced | 25 |
| Rules rest on evidence, cited | 20 |
| The project can actually follow it | 15 |
| Owner, version, exceptions and change log present | 15 |

80 or more: usable as it is. 70 to 79: usable after the listed fixes. Under 70: back to
drafting. Report the score, what works, what does not, and the fixes in order.

## Update

Read the standard, apply the change, then bump its version and add a change-log line:
patch for wording with no change of meaning, minor for a new or changed rule, major for
a change of scope or a removed rule. Rule ids are never reused.

## Exceptions

An exception to a MUST names the rule, the reason, the risk, how the risk is limited,
and when the exception ends. Exceptions are temporary by default.

## When not to write one

- A one-time choice with alternatives: that is an ADR or a decisions-log entry.
- A rule a formatter or linter can enforce: configure the tool, and mention it in one
  line.
- A preference without a problem behind it.
