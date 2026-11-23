import type { ScanFacts } from '../types'
import type { Answer } from './storage'

/*
 * The project's own rules (D78) as plain data and pure helpers: who works on the project,
 * how careful godmode is, the merge conditions the project sets, the setup's summary and
 * the plain-language rules file. godmode enforces exactly these; its own defaults apply only
 * where the project said nothing, and the summary says where each value came from.
 *
 * The note is the source of truth. `project-rules.md` is written from it on every save, so
 * the two never disagree; a hand edit to the file is seen by its fingerprint, and the PM
 * carries it into the note through change-setup, on the person's yes.
 */

/** Alone, or with others: pre-fills the people side of the rules (approvals, QA). */
export const WHO = ['alone', 'others'] as const

export type Who = (typeof WHO)[number]

/** Careful asks the person before a risky action; not careful just acts. godmode has full access either way. */
export const CARE = ['careful', 'not-careful'] as const

export type Care = (typeof CARE)[number]

/** The merge conditions a project can set (D78); the list can be empty. */
export const MERGE_CONDITION_IDS = ['approvals', 'ci', 'up-to-date', 'qa'] as const

export type MergeConditionId = (typeof MERGE_CONDITION_IDS)[number]

/** One merge condition, with what it needs. */
export type MergeCondition = { kind: 'approvals'; count: number; reviewers: string } | { kind: 'ci' } | { kind: 'up-to-date' } | { kind: 'qa' }

/** The answer that records an empty list, so "no conditions" differs from "never answered". */
export const NO_CONDITIONS = 'none'

/** The rules file setup writes into the conventions folder. */
export const PROJECT_RULES_FILE = 'project-rules.md'

/** The section of the rules file godmode never rewrites: the person's own rules, kept as they wrote them. */
export const OWN_RULES_HEADING = '## Your own rules'

const textOf = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const countOf = (value: Answer | undefined) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isInteger(number) && number >= 1 ? number : undefined
}

/** The condition ids an answer names, or undefined when it names none and is not `none`. */
export const conditionIdsIn = (value: Answer | undefined): MergeConditionId[] | undefined => {
  if (typeof value !== 'string') return undefined
  const parts = value.split(/[\s,]+/).map(part => part.trim().toLowerCase()).filter(part => part !== '')
  if (parts.length === 1 && parts[0] === NO_CONDITIONS) return []
  const ids = MERGE_CONDITION_IDS.filter(id => parts.includes(id))
  return ids.length === 0 ? undefined : ids
}

/** The list as the note records it: the ids comma-joined, or `none`. */
export const conditionsAnswer = (ids: readonly MergeConditionId[]) => (ids.length === 0 ? NO_CONDITIONS : MERGE_CONDITION_IDS.filter(id => ids.includes(id)).join(','))

const isTrue = (value: Answer | undefined) => value === true || (typeof value === 'string' && /^(true|yes|on)$/i.test(value.trim()))

/**
 * The condition ids a note's answers set. A note written before D78 has no `mergeConditions`:
 * its code-review answer reads as approvals, people testing the PR as QA, and a CI answer as CI,
 * so an update never changes what a project's merge waits on.
 */
export const conditionIdsOf = (answers: Readonly<Record<string, Answer>>): MergeConditionId[] => {
  const recorded = conditionIdsIn(answers.mergeConditions)
  if (recorded !== undefined) return recorded
  return MERGE_CONDITION_IDS.filter(id => {
    if (id === 'approvals') return isTrue(answers.humanReview)
    if (id === 'ci') return isTrue(answers.ciRequired)
    if (id === 'qa') return answers.qaMode === 'human-pr'
    return false
  })
}

/** The project's merge conditions, each with what it needs. */
export const mergeConditionsOf = (answers: Readonly<Record<string, Answer>>): MergeCondition[] =>
  conditionIdsOf(answers).map((id): MergeCondition => {
    if (id === 'approvals') return { kind: 'approvals', count: countOf(answers.humanReviewCount) ?? 1, reviewers: textOf(answers.humanReviewers) ?? '' }
    return { kind: id }
  })

/** How careful godmode is; a note from before D78 kept asking before its controlled actions, so it reads as careful. */
export const careOf = (answers: Readonly<Record<string, Answer>>): Care => (answers.care === 'not-careful' ? 'not-careful' : 'careful')

/** Who works on the project; undefined when the note never said and nothing in it tells. */
export const whoOf = (answers: Readonly<Record<string, Answer>>): Who | undefined => {
  if (answers.who === 'alone' || answers.who === 'others') return answers.who
  const people = isTrue(answers.humanReview) || String(answers.qaMode ?? '').startsWith('human') || textOf(answers.qaApprovers) !== undefined
  return people ? 'others' : undefined
}

/** Whether godmode merges on its own once the conditions hold: the answer, else what Care pre-fills. */
export const autoMergeOf = (answers: Readonly<Record<string, Answer>>) => {
  const value = answers.autoMerge
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(true|yes|on|false|no|off)$/i.test(value.trim())) return /^(true|yes|on)$/i.test(value.trim())
  return careOf(answers) === 'not-careful'
}

/** A merge condition in plain words. */
export const conditionWords = (condition: MergeCondition) => {
  if (condition.kind === 'approvals') {
    const whose = condition.reviewers === '' ? 'someone other than its author' : condition.reviewers
    return `${condition.count} approval${condition.count === 1 ? '' : 's'} from ${whose}`
  }
  if (condition.kind === 'ci') return 'green CI'
  if (condition.kind === 'up-to-date') return 'the branch up to date with its base'
  return 'a QA pass from the people who test'
}

/** The merge conditions in one line. */
export const conditionsLine = (conditions: readonly MergeCondition[]) =>
  conditions.length === 0 ? 'no conditions: a PR may merge as it is' : `needs ${conditions.map(conditionWords).join(' + ')}`

// ---------------------------------------------------------------------------
// What setup reads live besides the scan

/** Branch protection on the base branch, as GitHub's rules or protection answered. */
export type Protection = { approvals: number; checks: string[]; isStrict: boolean }

/** Facts setup reads live (D78): protection, CI, how PRs land, and the history's attribution habit. */
export type LiveFacts = {
  /** `read` with what it found, `none` when the base branch has none, `unreadable` when gh could not tell. */
  protection: { status: 'read'; rules: Protection } | { status: 'none' } | { status: 'unreadable'; reason: string } | { status: 'no-host' }
  /** CI files the repo holds: `.github/workflows/ci.yml`, `.gitlab-ci.yml`, ... */
  ci: string[]
  /** How PRs land, when the repo allows one way only or GitHub says; undefined when unknown. */
  mergeMethod?: string
  /** True when recent commits carry AI attribution, false when they have none, undefined with no history. */
  attribution?: boolean
}

export const NO_LIVE_FACTS: LiveFacts = { protection: { status: 'no-host' }, ci: [] }

// ---------------------------------------------------------------------------
// Pre-fill: what the scan and the two answers settle

/** Where a value on the summary came from. */
export type Source = 'saved' | 'scan' | 'scan: protection' | 'scan: CI' | 'scan: history' | 'scan: UI' | 'alone' | 'with others' | 'careful' | 'not careful' | 'you' | 'default' | '?'

/**
 * The working answers the summary and the questions use, besides the note's own keys:
 * `mergeApprovals` (0 for none), `mergeCi`, `mergeUpToDate` and `qaAgent` (godmode's own QA
 * agent on its own visible changes). `toNoteAnswers` turns them into the note's keys.
 */
export const WORKING_KEYS: readonly string[] = ['mergeApprovals', 'mergeCi', 'mergeUpToDate', 'qaAgent']

/** What the scan and the two answers settle, each with its source, and the keys still open ("?"). */
export type Prefilled = { values: Record<string, Answer>; sources: Record<string, Source>; open: string[] }

const careSource = (care: Care): Source => (care === 'careful' ? 'careful' : 'not careful')

/**
 * Pre-fills every answer the scan, the live facts and Who and Care settle (D78). Who and Care
 * decide behaviour only: tools and environments come from the scan, or are asked. Keys in
 * `given` are the person's and are kept with the source `you`.
 */
export const prefill = (facts: ScanFacts, live: LiveFacts, given: Readonly<Record<string, Answer>>): Prefilled => {
  const values: Record<string, Answer> = {}
  const sources: Record<string, Source> = {}
  const open: string[] = []
  const set = (key: string, value: Answer, source: Source) => {
    if (key in given) return
    values[key] = value
    sources[key] = source
  }
  const ask = (key: string) => {
    if (!(key in given)) open.push(key)
  }
  const who = given.who === 'others' ? 'others' : given.who === 'alone' ? 'alone' : undefined
  const care: Care = given.care === 'not-careful' ? 'not-careful' : 'careful'
  const protection = live.protection
  const isGitHub = facts.git.host === 'github' || given.gitHost === 'github'

  // Approvals from others: none alone; else what protection asks for, or a question.
  if (who === 'alone') set('mergeApprovals', 0, 'alone')
  else if (!isGitHub) set('mergeApprovals', 0, 'scan')
  else if (protection.status === 'read') set('mergeApprovals', protection.rules.approvals, 'scan: protection')
  else if (protection.status === 'none' && who === undefined) set('mergeApprovals', 0, 'scan: protection')
  else ask('mergeApprovals')

  // CI: what protection requires, else the CI the repo holds; a fact, never asked.
  if (protection.status === 'read' && protection.rules.checks.length > 0) set('mergeCi', true, 'scan: protection')
  else if (isGitHub && live.ci.length > 0) set('mergeCi', true, 'scan: CI')
  else set('mergeCi', false, 'scan')
  if (protection.status === 'read' && protection.rules.isStrict) set('mergeUpToDate', true, 'scan: protection')

  // People's QA: nobody else alone; else asked, since no scan can tell.
  if (who === 'alone') set('qaMode', 'none', 'alone')
  else ask('qaMode')
  // godmode's own QA agent tries its own visible changes when there is an app to run.
  set('qaAgent', facts.hasUi, 'scan: UI')

  set('autoMerge', care === 'not-careful', careSource(care))
  if (live.attribution !== undefined) set('attribution', live.attribution, 'scan: history')
  else ask('attribution')
  return { values, sources, open }
}

/**
 * The note's keys from the working answers: the merge conditions list and its approval count,
 * and the QA mode with godmode's own QA agent folded in. The working keys are left out.
 */
export const toNoteAnswers = (answers: Readonly<Record<string, Answer>>): Record<string, Answer> => {
  const out: Record<string, Answer> = {}
  for (const [key, value] of Object.entries(answers)) if (!WORKING_KEYS.includes(key) && key !== 'qaHuman') out[key] = value
  const hasWorking = WORKING_KEYS.some(key => key in answers)
  if (!hasWorking) return out
  const approvals = typeof answers.mergeApprovals === 'number' ? answers.mergeApprovals : (countOf(answers.mergeApprovals) ?? 0)
  const people = answers.qaMode === 'human-pr' || answers.qaMode === 'human-staging' ? answers.qaMode : undefined
  const ids: MergeConditionId[] = [
    ...(approvals >= 1 ? (['approvals'] as const) : []),
    ...(isTrue(answers.mergeCi) ? (['ci'] as const) : []),
    ...(isTrue(answers.mergeUpToDate) ? (['up-to-date'] as const) : []),
    ...(people === 'human-pr' ? (['qa'] as const) : []),
  ]
  out.mergeConditions = conditionsAnswer(ids)
  if (approvals >= 1) out.humanReviewCount = approvals
  else delete out.humanReviewCount
  delete out.humanReview
  if ('qaAgent' in answers || 'qaMode' in answers) {
    const agent = isTrue(answers.qaAgent)
    out.qaMode = people ?? (agent ? 'bot' : 'none')
    if (people !== undefined) out.qaBotFirst = agent
    else delete out.qaBotFirst
  }
  return out
}

/** The working answers read back from a note's keys, so a change offers the saved values first. */
export const workingAnswersOf = (answers: Readonly<Record<string, Answer>>): Record<string, Answer> => {
  const conditions = mergeConditionsOf(answers)
  const approvals = conditions.find((condition): condition is Extract<MergeCondition, { kind: 'approvals' }> => condition.kind === 'approvals')
  const qaMode = String(answers.qaMode ?? 'none')
  return {
    mergeApprovals: approvals?.count ?? 0,
    mergeCi: conditions.some(condition => condition.kind === 'ci'),
    mergeUpToDate: conditions.some(condition => condition.kind === 'up-to-date'),
    qaAgent: qaMode === 'bot' || isTrue(answers.qaBotFirst),
    qaMode: qaMode === 'bot' ? 'none' : qaMode,
  }
}

// ---------------------------------------------------------------------------
// The summary screen

/** One line of the setup's summary: the area, its value, and where the value came from. */
export type SummaryLine = { area: string; text: string; source: string }

/** Where the detailed rules of each area live, linked from the summary and the rules file. */
export type AreaFiles = { conventionsDir: string; prTemplate?: string; gitWorkflow?: string; ticketRules?: string; existing: readonly string[] }

const sourceOf = (sources: Readonly<Record<string, Source>>, keys: readonly string[], fallback = 'you') => {
  const named = [...new Set(keys.map(key => sources[key]).filter((source): source is Source => source !== undefined))]
  if (named.includes('?')) return '?'
  return named.length === 0 ? fallback : named.join(', ')
}

const commandsText = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>) => {
  const command = (key: 'test' | 'lint' | 'start') => textOf(answers[`${key}Command`]) ?? facts.commands[key]
  const parts = (['test', 'lint', 'start'] as const).flatMap(key => {
    const found = command(key)
    return found === undefined ? [] : [`${key} \`${found}\``]
  })
  return parts.length === 0 ? 'none found' : parts.join(' · ')
}

const TRACKER_WORDS: Readonly<Record<string, string>> = { none: 'markdown tickets godmode keeps', jira: 'Jira', other: 'another tracker' }

const ticketsText = (answers: Readonly<Record<string, Answer>>, files: AreaFiles) => {
  const tracker = String(answers.tracker ?? '')
  if (tracker === '') return 'asked next'
  const name = tracker === 'jira' ? `Jira ${textOf(answers.jiraProject) ?? ''}`.trim() : tracker === 'other' ? (textOf(answers.trackerName) ?? 'another tracker') : (TRACKER_WORDS[tracker] ?? tracker)
  if (tracker === 'none') return `${name}; ticket shape in ${files.conventionsDir}/ticket-template.md`
  return `${name} · ticket rules: ${files.ticketRules ?? 'from your tickets, in ticket-filing.md, shown next'}`
}

const qaText = (answers: Readonly<Record<string, Answer>>) => {
  const mode = answers.qaMode
  const people = mode === 'human-pr' ? 'people test the PR before it merges' : mode === 'human-staging' ? 'people test on staging after the merge' : mode === undefined ? 'asked next' : 'nobody besides the author'
  const agent = answers.qaAgent === undefined ? '' : ` · godmode's QA agent on its own visible changes: ${isTrue(answers.qaAgent) ? 'on' : 'off'}`
  return `${people}${agent}`
}

/** The risky actions, in the words the summary and the rules file use. */
export const RISKY_WORDS = 'merge, force-push over pushed work, delete branches or tickets, close or approve PRs, others\' PRs or tickets'

/**
 * The summary the person confirms (D78): each area's value and its source, with a link to the
 * file that holds the area's detailed rules. `answers` are the working answers so far, and a
 * key still open shows "?".
 */
export const summaryLines = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>, sources: Readonly<Record<string, Source>>, files: AreaFiles): SummaryLine[] => {
  const conditions = mergeConditionsOf(toNoteAnswers({ ...answers, mergeApprovals: answers.mergeApprovals ?? 0 }))
  const isOpen = (key: string) => sources[key] === '?'
  const base = textOf(answers.baseBranch) ?? facts.git.baseBranch ?? 'the current branch'
  const host = answers.gitHost ?? facts.git.host
  const prs = host === 'github' ? `PRs: ${files.prTemplate === undefined ? 'godmode\'s template' : 'your template'} + rules in ${files.gitWorkflow ?? `${files.conventionsDir}/git-workflow.md`}` : host === 'other' ? 'PRs on another host, not driven yet' : 'review on local branches, no PRs'
  const merging = isOpen('mergeApprovals') ? `approvals from others: asked next; ${conditionsLine(conditions.filter(condition => condition.kind !== 'approvals'))}` : conditionsLine(conditions)
  const auto = isTrue(answers.autoMerge) ? 'godmode merges once these hold' : 'you say "merge"; nothing merges on its own'
  const risky = answers.care === 'not-careful' ? 'godmode just does them' : 'asks you first'
  const lines: SummaryLine[] = [
    { area: 'Who', text: answers.who === 'others' ? 'with others' : answers.who === 'alone' ? 'alone' : 'not said', source: sourceOf(sources, ['who']) },
    { area: 'Commands', text: commandsText(facts, answers), source: sourceOf(sources, ['stack', 'testCommand', 'startCommand'], 'scan') },
    { area: 'Git', text: `branches off ${base} · ${prs}`, source: sourceOf(sources, ['gitHost'], 'scan') },
    { area: 'Merging', text: merging, source: sourceOf(sources, ['mergeApprovals', 'mergeCi', 'mergeUpToDate', 'qaMode']) },
    { area: '', text: auto, source: sourceOf(sources, ['autoMerge']) },
    { area: 'QA', text: qaText(answers), source: sourceOf(sources, ['qaMode', 'qaAgent']) },
    { area: 'Tickets', text: ticketsText(answers, files), source: sourceOf(sources, ['tracker']) },
    { area: 'Risky', text: `${RISKY_WORDS} → ${risky}`, source: sourceOf(sources, ['care']) },
    { area: 'Attribution', text: answers.attribution === undefined ? 'asked next' : isTrue(answers.attribution) ? 'commits and PRs may name the AI' : 'no AI attribution', source: sourceOf(sources, ['attribution']) },
    {
      area: 'Rules',
      text: `all of this in ${files.conventionsDir}/${PROJECT_RULES_FILE}${files.existing.length === 0 ? '' : `; your own files kept as the rules: ${files.existing.slice(0, 4).join(', ')}${files.existing.length > 4 ? ', ...' : ''}`}`,
      source: 'scan',
    },
  ]
  if (answers.storage !== undefined || isOpen('storage')) lines.splice(7, 0, { area: 'Storage', text: answers.storage === undefined ? 'asked next' : String(answers.storage), source: sourceOf(sources, ['storage']) })
  return lines
}

/** The summary as the lines `$.ui.log` shows, one call each: the area, the value, the source in brackets. */
export const summaryText = (lines: readonly SummaryLine[]) => lines.map(line => `${line.area.padEnd(12)} ${line.text}   (${line.source})`)

// ---------------------------------------------------------------------------
// The plain-language rules file

/** The person's own section of an existing rules file, kept as they wrote it; undefined when there is none. */
export const ownRulesIn = (text: string | undefined) => {
  if (text === undefined) return undefined
  const at = text.indexOf(OWN_RULES_HEADING)
  return at === -1 ? undefined : text.slice(at).trimEnd()
}

const OWN_RULES_STUB = `${OWN_RULES_HEADING}\n\nAnything you add under this heading is kept when godmode rewrites the sections above, and every agent follows it.`

/**
 * The rules file (D78), written from the note's answers. Each person's own settings (Care and
 * merging on their own) live in their personal note and are named, not quoted, so a committed
 * file says nothing about one person. `kept` is the person's own section of the old file.
 */
export const projectRulesText = (answers: Readonly<Record<string, Answer>>, files: AreaFiles, kept?: string) => {
  const conditions = mergeConditionsOf(answers)
  const qaMode = String(answers.qaMode ?? 'none')
  const people = qaMode === 'human-pr' ? 'People test each PR before it merges.' : qaMode === 'human-staging' ? 'People test each change on staging after it merges.' : 'Nobody tests changes besides their author.'
  const agent = qaMode === 'bot' || isTrue(answers.qaBotFirst) ? 'on' : 'off'
  const tracker = String(answers.tracker ?? 'none')
  const commands = ['test', 'lint', 'start', 'build', 'typecheck'].flatMap(key => {
    const value = textOf(answers[`${key}Command`])
    return value === undefined ? [] : [`- ${key}: \`${value}\``]
  })
  const who = whoOf(answers)
  return [
    '# Project rules',
    '',
    'godmode follows these rules in this project; its own defaults apply only where they say nothing. To change one, edit this file or tell the PM: either way the change is saved with your yes. The detailed rules of each area are in the files named below.',
    '',
    '## Who works here',
    '',
    `- ${who === 'alone' ? 'One person works on this project.' : who === 'others' ? 'Several people work on this project.' : 'Not said.'}`,
    '',
    '## Merging',
    '',
    `- A PR merges with ${conditions.length === 0 ? 'no conditions of the project\'s' : conditions.map(conditionWords).join(', ')}. Each is checked live on every PR, whoever made it.`,
    '- Whether godmode merges on its own once these hold is each person\'s own setting, in their personal note.',
    '- godmode\'s own review, QA agent and fix rounds apply only to the work godmode does, before it marks its PR ready.',
    '',
    '## Testing',
    '',
    `- ${people}`,
    `- godmode's QA agent tries godmode's own visible changes before its PR is marked ready: ${agent}.`,
    '',
    '## Tickets',
    '',
    `- ${tracker === 'jira' ? `Jira, project ${textOf(answers.jiraProject) ?? '(not set)'}.` : tracker === 'other' ? `${textOf(answers.trackerName) ?? 'Another tracker'}, mirrored by hand.` : 'Markdown tickets kept by godmode.'}`,
    ...(files.ticketRules === undefined ? [] : [`- How tickets are filed: ${files.ticketRules}.`]),
    '',
    '## Git and PRs',
    '',
    `- Branches start from \`${textOf(answers.baseBranch) ?? 'the default branch'}\`.`,
    `- PR descriptions follow ${files.prTemplate ?? 'the PR template'}; branches, commits and PRs follow ${files.gitWorkflow ?? `${files.conventionsDir}/git-workflow.md`}.`,
    `- ${isTrue(answers.attribution) ? 'Commits and PRs may carry AI attribution.' : 'Commits and PRs carry no AI attribution.'}`,
    '',
    '## Commands',
    '',
    ...(commands.length === 0 ? ['- None recorded.'] : commands),
    '',
    '## Risky actions',
    '',
    `- ${RISKY_WORDS}: each person chooses in their personal note whether godmode asks them first (careful) or just acts (not careful).`,
    ...(files.existing.length === 0 ? [] : ['', '## The project\'s own conventions', '', ...files.existing.map(path => `- ${path}`)]),
    '',
    kept ?? OWN_RULES_STUB,
    '',
  ].join('\n')
}
