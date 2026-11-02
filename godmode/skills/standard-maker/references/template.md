# Standard template

```markdown
# Standard: <title>

- Status: draft | active | retired
- Version: 0.1.0
- Owner: <who keeps it up to date>
- Effective: <YYYY-MM-DD>

## Problem

<One or two sentences: what goes wrong without this standard.>

## Scope

<Where it applies: code areas, file types, kinds of change.>
<What is explicitly out of scope.>

## Rules

### <DOMAIN>-01 <short name>

- **Rule:** <MUST / SHOULD / MAY statement> [S1]
- **Why:** <the reason, in a sentence or two>
- **Enforced by:** <linter rule, CI check, hook, review checklist item>
- **Exceptions:** <when allowed, who agrees, until when>; or "none"

### <DOMAIN>-02 <short name>

...

## Enforcement summary

| Rule | Mechanism | Automatic |
| --- | --- | --- |
| <DOMAIN>-01 | <mechanism> | yes / no |

## How we know it works

| Signal | Today | Target |
| --- | --- | --- |
| <e.g. review findings of this kind per month> | <value> | <value> |

## Sources

- S1: <title>, <link or path>, <why it matters here>

## Change log

| Version | Date | Change |
| --- | --- | --- |
| 0.1.0 | <YYYY-MM-DD> | First draft |
```

## Naming

- Files: `<conventions folder>/<topic>.md`, or the project's existing pattern.
- Rule ids: `<DOMAIN>-<NN>` (`SEC-01`, `TEST-03`, `GIT-02`). Never reuse a removed id.
- Versions: `MAJOR.MINOR.PATCH` inside the file, not in its name.
