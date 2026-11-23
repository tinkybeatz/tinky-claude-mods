import { CARE, conditionIdsIn, WHO } from './project-rules'
import { QA_MODES, QA_SIGNALS } from './role'
import type { Answer } from './storage'

/*
 * One rule per setup answer: what a typed value becomes, and when it cannot be used. Every
 * answer passes through it when it is given (the dialog, `given`, `setup_finish`'s
 * `answers`) and again when a saved note is read, so a value saved before a rule existed is
 * repaired where that is safe and flagged where it is not. Plain data and pure helpers:
 * `storage.ts` reads notes through it, so it imports nothing at run time but `role.ts`.
 */

/** How godmode treats approving a PR (D74): never unasked, or once review and QA passed. */
export const APPROVAL_POLICIES = ['ask', 'when-passed'] as const

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]

/** An answer after its key's rule: the value to keep, or why it cannot be used. */
export type Checked = { value: Answer } | { problem: string }

type Rule = {
  /** The `/godmode setup` topic whose questions set the answer; none for a free setting. */
  topic?: string
  check: (value: Answer) => Checked
}

/** A saved answer the rules changed, in the note's `half`. */
export type AnswerRepair = { key: string; from: Answer; to: Answer; half: 'shared' | 'personal' }

/** A saved answer the rules cannot use, in the note's `half`. */
export type AnswerIssue = { key: string; value: Answer; problem: string; topic?: string; half: 'shared' | 'personal' }

const ok = (value: Answer): Checked => ({ value })
const bad = (problem: string): Checked => ({ problem })

/** Typed text on one line: spaces folded, and one pair of wrapping quotes or backticks taken off. */
export const typedText = (value: Answer) => {
  const flat = String(value).replace(/\s+/g, ' ').trim()
  return /^([`"'])(.*)\1$/.exec(flat)?.[2]?.trim() ?? flat
}

const shown = (value: Answer) => JSON.stringify(typedText(value))

/** Text that means "none" or "later", as people type it under Other. */
const NONE_WORDS = /^(none|no|nope|n\/?a|nothing|-+|skip|later|decide later|not yet|no tests?( yet)?|nothing to run)\.?$/i

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * An Atlassian site as the Atlassian servers take it for `cloudId`: a cloud id kept as it
 * is, else the site's host name. A link loses its scheme and path, and a bare name without a
 * dot is an Atlassian Cloud site (`acme` is `acme.atlassian.net`). Undefined when nothing
 * reads as a site.
 */
export const jiraSiteOf = (raw: Answer) => {
  const text = typedText(raw)
  if (UUID.test(text)) return text.toLowerCase()
  const host = (text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '').toLowerCase()
  if (!HOST.test(host)) return undefined
  return host.includes('.') ? host : `${host}.atlassian.net`
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

/**
 * A Jira project key: a bare key in any case (`prod` is `PROD`), a choice's label
 * (`PROD (Product)`), or a link to the project (`.../projects/PROD/boards/1`) or to one of
 * its issues (`.../browse/PROD-12`, `?selectedIssue=PROD-12`). Undefined when none is found.
 */
export const jiraProjectKeyOf = (raw: Answer) => {
  const text = typedText(raw)
  const found =
    /\/projects\/([A-Za-z][A-Za-z0-9_]*)(?:[/?#]|$)/i.exec(text)?.[1] ??
    /\/browse\/([A-Za-z][A-Za-z0-9_]*)-\d+/i.exec(text)?.[1] ??
    /[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*)-\d+/i.exec(text)?.[1] ??
    /^([A-Za-z][A-Za-z0-9_]*)(?:\s*\(.*\))?$/.exec(text)?.[1]
  return found !== undefined && PROJECT_KEY.test(found) ? found.toUpperCase() : undefined
}

const site: Rule = {
  topic: 'jira',
  check: value => {
    const found = jiraSiteOf(value)
    return found === undefined ? bad(`${shown(value)} is not an Atlassian site: type its address (acme.atlassian.net) or its name (acme)`) : ok(found)
  },
}

const project: Rule = {
  topic: 'jira',
  check: value => {
    const key = jiraProjectKeyOf(value)
    return key === undefined ? bad(`${shown(value)} is not a Jira project key: type the key (PROD), or paste a link to the project's board or to one of its issues`) : ok(key)
  },
}

/** A status on a board, by its name. */
const status = (topic: string): Rule => ({
  topic,
  check: value => {
    const text = typedText(value)
    return text.length > 60 ? bad(`${shown(value)} is too long to be a status name: type the status exactly as the board shows it`) : ok(text)
  },
})

/** A command line: one line, wrapping backticks off; "none" in any words records none. */
const command: Rule = { check: value => (typeof value !== 'string' ? ok(value) : ok(NONE_WORDS.test(typedText(value)) ? '' : typedText(value))) }

const REF_BAD = /\s|\.\.|[~^:?*[\\]|@\{|^[-/.]|\/\/|\.lock$|\.$/

/** A git branch name, or a prefix ending in `/` when `isPrefix`. */
const branch = (what: string, isPrefix: boolean): Rule => ({
  check: value => {
    const text = typedText(value)
    const name = isPrefix ? text.replace(/\/$/, '') : text
    return text === '' || !REF_BAD.test(name) ? ok(text) : bad(`${shown(value)} is not a usable ${what}: git refuses spaces, "..", and ~ ^ : ? * [ \\ in a branch name`)
  },
})

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const TEAM = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** GitHub logins and `org/team` names, typed with commas, spaces, `@` or "and". */
export const peopleIn = (value: Answer) =>
  typedText(value)
    .split(/[\s,;]+/)
    .map(part => part.replace(/^@/, '').trim())
    .filter(part => part !== '' && !/^(and|or|&)$/i.test(part))

const people: Rule = {
  topic: 'qa',
  check: value => {
    const named = peopleIn(value)
    const wrong = named.filter(part => !LOGIN.test(part) && !TEAM.test(part))
    if (wrong.length > 0) return bad(`${wrong.map(part => JSON.stringify(part)).join(', ')} ${wrong.length === 1 ? 'is not a GitHub login' : 'are not GitHub logins'} or org/team names: type logins (alice, bob) or a team as org/team`)
    return ok(named.join(', '))
  },
}

/** The pass signals a `qaSignals` answer names; a part naming none is left out. */
const signals: Rule = {
  topic: 'qa',
  check: value => {
    const named = String(value).split(/[\s,]+/).map(part => part.trim().toLowerCase())
    return ok(QA_SIGNALS.filter(signal => named.includes(signal)).join(','))
  },
}

/** A count of 1 or more, typed or picked. */
const count = (topic: string): Rule => ({
  topic,
  check: value => {
    const number = typeof value === 'number' ? value : Number(typedText(value))
    return Number.isInteger(number) && number >= 1 ? ok(number) : bad(`${shown(value)} is not a whole number of 1 or more: type one, such as 3`)
  },
})

/** A count of 0 or more: "none" is 0. */
const countOrNone = (topic: string): Rule => ({
  topic,
  check: value => {
    const text = typedText(value)
    const number = typeof value === 'number' ? value : NONE_WORDS.test(text) ? 0 : Number(/^(\d+)/.exec(text)?.[1] ?? Number.NaN)
    return Number.isInteger(number) && number >= 0 ? ok(number) : bad(`${shown(value)} is not a whole number: type one, such as 1, or none`)
  },
})

/** The merge conditions list (D78): known ids comma-joined, or `none`. */
const conditions: Rule = {
  topic: 'merging',
  check: value => {
    const ids = conditionIdsIn(typedText(value))
    if (ids !== undefined) return ok(ids.length === 0 ? 'none' : ids.join(','))
    return NONE_WORDS.test(typedText(value)) ? ok('none') : bad(`${shown(value)} names no merge condition: use approvals, ci, up-to-date, qa, or none`)
  },
}

const YES = /^(true|yes|y|on|allow(ed)?)$/i
const NO = /^(false|no|n|off|none)$/i

const flag = (topic: string): Rule => ({
  topic,
  check: value => {
    if (typeof value === 'boolean') return ok(value)
    const text = typedText(value)
    if (YES.test(text)) return ok(true)
    if (NO.test(text)) return ok(false)
    return bad(`${shown(value)} is neither yes nor no`)
  },
})

const oneOf = (topic: string, values: readonly string[]): Rule => ({
  topic,
  check: value => {
    const text = typedText(value).toLowerCase()
    return values.includes(text) ? ok(text) : bad(`${shown(value)} is not one of ${values.join(', ')}`)
  },
})

/** One of `values`, or the first of `words` the typed text holds. */
const worded = (topic: string, values: readonly string[], words: readonly (readonly [RegExp, string])[]): Rule => ({
  topic,
  check: value => {
    const text = typedText(value).toLowerCase()
    if (values.includes(text)) return ok(text)
    const found = words.find(([pattern]) => pattern.test(text))?.[1]
    return found === undefined ? bad(`${shown(value)} is not one of ${values.join(', ')}`) : ok(found)
  },
})

/** Text kept on one line; a number or a yes/no stays as it is (notes before D69 hold `qa: true`). */
const plain = (topic?: string): Rule => ({ ...(topic === undefined ? {} : { topic }), check: value => ok(typeof value === 'string' ? typedText(value) : value) })

/** Each answer key's rule; a key ending in `Command` is a command, any other key plain text. */
export const ANSWER_RULES: Readonly<Record<string, Rule>> = {
  who: worded('who', WHO, [
    [/\b(not alone|others?|team|together|colleagues?|people)\b/i, 'others'],
    [/\b(alone|solo|myself|just me|only me)\b/i, 'alone'],
  ]),
  care: worded('care', CARE, [
    [/\b(not|just do|no need|don'?t ask)\b/i, 'not-careful'],
    [/\b(careful|ask)\b/i, 'careful'],
  ]),
  mergeConditions: conditions,
  mergeApprovals: countOrNone('merging'),
  mergeCi: flag('merging'),
  mergeUpToDate: flag('merging'),
  qaAgent: flag('qa'),
  confirmed: flag('who'),
  prApproval: oneOf('care', APPROVAL_POLICIES),
  attribution: flag('attribution'),
  indicator: oneOf('indicator', ['mode', 'hint', 'band', 'pane']),
  autoMerge: flag('merging'),
  agentCap: count('agentCap'),
  fixRoundLimit: count('fixRoundLimit'),
  // `tickets.ts` reads a tracker in any words, so the rule only tidies it.
  tracker: plain('tracker'),
  trackerName: plain('tracker'),
  gitHost: oneOf('gitHost', ['github', 'local', 'other']),
  jiraServer: plain('jira'),
  jiraCloudId: site,
  jiraProject: project,
  jiraIssueType: plain('jira'),
  jiraTodoStatus: status('jira'),
  jiraDoingStatus: status('jira'),
  jiraReviewStatus: status('jira'),
  jiraDoneStatus: status('jira'),
  qaMode: oneOf('qa', QA_MODES),
  qaHuman: flag('qa'),
  qaBotFirst: flag('qa'),
  qaWaitStatus: status('qa'),
  qaPassStatus: status('qa'),
  qaSignals: signals,
  qaApprovers: people,
  humanReview: flag('merging'),
  humanReviewCount: count('merging'),
  humanReviewers: { ...people, topic: 'merging' },
  baseBranch: branch('branch name', false),
  branchPrefix: branch('branch prefix', true),
  stack: plain(),
}

const ruleOf = (key: string): Rule => ANSWER_RULES[key] ?? (key.endsWith('Command') ? command : plain())

/** The `/godmode setup` topic that asks an answer again; undefined for a free setting. */
export const topicOf = (key: string) => ruleOf(key).topic

/** One answer through its key's rule. An empty answer ("decide later") always passes, as nothing. */
export const checkAnswer = (key: string, value: Answer): Checked => {
  if (typeof value === 'string' && value.trim() === '') return ok('')
  return ruleOf(key).check(value)
}

/**
 * A saved half of the note through the rules: the answers to use, the ones the rules changed,
 * and the ones they cannot use, which are left out of the answers.
 */
export const cleanAnswers = (answers: Readonly<Record<string, Answer>>, half: 'shared' | 'personal') => {
  const clean: Record<string, Answer> = {}
  const repairs: AnswerRepair[] = []
  const issues: AnswerIssue[] = []
  for (const [key, value] of Object.entries(answers)) {
    const checked = checkAnswer(key, value)
    if ('problem' in checked) {
      issues.push({ key, value, problem: checked.problem, topic: topicOf(key), half })
      continue
    }
    clean[key] = checked.value
    if (checked.value !== value) repairs.push({ key, from: value, to: checked.value, half })
  }
  return { answers: clean, repairs, issues }
}

/** The saved answers before the rules ran: the clean ones, with each repair and issue put back as saved. */
export const savedAnswers = (clean: Readonly<Record<string, Answer>>, repairs: readonly AnswerRepair[], issues: readonly AnswerIssue[], half: 'shared' | 'personal') => {
  const saved: Record<string, Answer> = { ...clean }
  for (const repair of repairs) if (repair.half === half) saved[repair.key] = repair.from
  for (const issue of issues) if (issue.half === half) saved[issue.key] = issue.value
  return saved
}

const how = (topic: string | undefined) => (topic === undefined ? '`/godmode setup`, then say the right value' : `\`/godmode setup\` (topic \`${topic}\`)`)

/** The lines that tell the person what the rules did to a saved note, each with what fixes it. */
export const answerIssueLines = (repairs: readonly AnswerRepair[], issues: readonly AnswerIssue[]) => [
  ...repairs.map(
    repair =>
      `godmode reads the setup's ${repair.key} ${JSON.stringify(repair.from)} as ${JSON.stringify(repair.to)}. \`/godmode setup\` (topic \`check\`) saves the repaired value.`,
  ),
  ...issues.map(issue => `The setup's ${issue.key} ${JSON.stringify(issue.value)} cannot be used (${issue.problem}), so godmode ignores it. Fix it with ${how(issue.topic)}.`),
]
