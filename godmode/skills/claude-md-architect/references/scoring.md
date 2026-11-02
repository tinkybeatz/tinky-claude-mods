# Scoring agent rules (out of 100)

Score the root rules file (`AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`)
together with what it imports. Round the weighted sum.

| # | Dimension | Points | Full marks | Zero |
| --- | --- | --- | --- | --- |
| 1 | Size | 15 | 60 lines or fewer | over 300 lines |
| 2 | Specificity | 15 | no vague directive | 3 or more vague directives |
| 3 | Commands that work | 15 | every listed command runs as written | none listed, or most fail |
| 4 | What / why / how | 10 | all three present | none |
| 5 | Density | 10 | most non-heading lines are bullets that tell the agent something | mostly narrative prose |
| 6 | One home per rule | 10 | no rule repeated across files | more than 5 repeated |
| 7 | Inline code | 5 | no code block over 5 lines | 3 or more |
| 8 | Placement | 10 | must-never rules enforced by a tool, personal preferences out of shared files | neither |
| 9 | Agent-neutral | 10 | rules in `AGENTS.md`, `CLAUDE.md` importing it | rules split between both, contradicting |

## Grids

**Size**: 60 lines or fewer, 15; up to 120, 12; up to 200, 8; up to 300, 4; more, 0.

**Specificity**: count directives no one could check ("follow best practices", "write
clean code", "be careful", "keep it consistent"). None, 15; one, 10; two, 5; more, 0.
The test: could a grep, a test or a reviewer tell whether the rule was kept?

**Commands that work**: run each listed command (or check it exists in the manifest).
All work, 15; one fails, 8; more fail, 0.

**What / why / how**: one third of the points per part present.

**Density**: share of non-heading lines that are imperative bullets or facts an agent
acts on. 60% or more, 10; 40% or more, 7; 20% or more, 4; less, 0.

**One home per rule**: when other rules files and docs are available, grep for repeated
rules. None, 10; one or two, 6; three to five, 3; more, 0. Unable to check, 7.

**Inline code**: blocks over 5 lines. None, 5; one, 3; more, 0. Prefer a `path:line`
pointer.

**Placement**: 5 points for must-never rules backed by a hook, CI check or setting; 5
for no personal preferences in committed files.

**Agent-neutral**: 10 when `AGENTS.md` holds the rules and `CLAUDE.md` imports it, or
when only one agent is ever used and its file is the single source; 5 when both files
exist with overlapping rules that agree; 0 when they contradict.

## Verdicts

| Score | Verdict | Action |
| --- | --- | --- |
| 85-100 | Excellent | Change nothing. |
| 75-84 | Solid | Adopt; fill missing pieces only. |
| 50-74 | Weak | Improve in place, with consent. |
| under 50 | Critical | Rewrite from the templates, keeping what is true. |

## Report

```markdown
## Score: 68/100, weak

| Dimension | Score | Note |
| --- | --- | --- |
| Size | 8/15 | 142 lines |
| ... | ... | ... |

## Top three issues
1. <anti-pattern>, line <n>: <one line>.

## Proposed change
<diff>

## Where moved content goes
- "<rule>" → <destination> (<reason>)
```
