import type { ScanFacts } from '../types'
import type { SetupScope } from '../types'
import { qaSignalsOf } from './role'
import type { Answer } from './storage'
import { trackerKindOf } from './tickets'

/*
 * The setup questionnaire (D8, D14, D29) as plain data: which questions a setup asks,
 * and what each answer means. Multiple choice, one question at a time through
 * godmode's own dialog (`$.ui.ask`), since a subagent has no AskUserQuestion tool.
 * `setup.ts` asks them.
 */

/**
 * One choice: the label the person picks, and the answer it records. `onlyIf` says when
 * it applies, set only while an answer it depends on is still unknown (the PM's outline).
 */
export type Choice = { label: string; value: Answer; onlyIf?: string }

/** Which half of the note an answer goes in (D61). */
export type NoteHalf = 'shared' | 'personal'

export type Question = {
  /** The answer's key in the note, as the loop reads it (`permissions`, `tracker`, ...). */
  key: string
  /** The dialog's chip, 12 characters at most. */
  header: string
  question: string
  /** Two to four choices; the first is the default where one is marked. */
  choices: Choice[]
  half: NoteHalf
  /**
   * What text typed under the dialog's "Other" becomes. Absent on a closed question,
   * where text that names no choice falls back to the first choice.
   */
  freeText?: (text: string) => Record<string, Answer>
  /** Several choices may be picked; the answer records their values comma-joined. */
  multiSelect?: true
  /**
   * The questions this answer leads to, asked right after it, given every answer so far
   * (D69's QA flow: where people test, or whether the QA agent does).
   */
  followUps?: (answers: Readonly<Record<string, Answer>>) => Question[]
  /** When the question applies, set only while an answer it depends on is still unknown (the PM's outline). */
  onlyIf?: string
}

/** A question the setup agent adds for a gap of its own (D29). */
export type ExtraQuestion = { key: string; question: string; options: string[]; header?: string }

/** The QA flow's keys (D69, D70, D71); `qa` is the on or off answer notes before D69 hold. */
export const QA_KEYS: readonly string[] = ['qa', 'qaHuman', 'qaMode', 'qaBotFirst', 'qaWaitStatus', 'qaSignals', 'qaPassStatus', 'qaApprovers']

/**
 * One more round's answers over a setup run's earlier ones. A round that answers the QA flow
 * again replaces every earlier QA answer, so a branch not taken this time leaves nothing.
 */
export const mergeAnswers = (earlier: Readonly<Record<string, Answer>>, round: Readonly<Record<string, Answer>>): Record<string, Answer> => {
  const qaAgain = Object.keys(round).some(key => QA_KEYS.includes(key))
  const kept = qaAgain ? Object.fromEntries(Object.entries(earlier).filter(([key]) => !QA_KEYS.includes(key))) : earlier
  return { ...kept, ...round }
}

/** The Jira questions' keys: the server, the site, the project, and the board's name for each status. */
export const JIRA_KEYS: readonly string[] = ['jiraServer', 'jiraCloudId', 'jiraProject', 'jiraStatusMap', 'jiraTodoStatus', 'jiraDoingStatus', 'jiraReviewStatus', 'jiraDoneStatus']

/** The keys of the fixed questions; an extra question may not reuse one. */
export const FIXED_KEYS: readonly string[] = [
  'permissions',
  'storage',
  'tracker',
  'attribution',
  ...QA_KEYS,
  ...JIRA_KEYS,
  'indicator',
  'gitHost',
  'stack',
  'testCommand',
  'startCommand',
  'autoMerge',
  'agentCap',
  'fixRoundLimit',
]

/**
 * Answers that steer the questionnaire but are not written into the note: the storage
 * answer is where the note goes, and `qaHuman` only leads to the `qaMode` it records.
 */
export const UNRECORDED_KEYS: readonly string[] = ['storage', 'qaHuman', 'jiraStatusMap']

/** Where PRs live, as the questionnaire and the scan settled it. */
export const isGitHubHost = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>) =>
  answers.gitHost === 'github' || (answers.gitHost === undefined && facts.git.host === 'github')

/**
 * Answers that stay one person's (D61), even when the setup agent passes them. The Jira
 * server is one: each person's session names its Atlassian connector its own way.
 */
export const PERSONAL_KEYS: readonly string[] = ['permissions', 'attribution', 'autoMerge', 'agentCap', 'fixRoundLimit', 'indicator', 'trackerAccount', 'jiraServer']

export const isPersonalKey = (key: string) => PERSONAL_KEYS.includes(key) || key.startsWith('permission.')

export const PERMISSIONS: Question = {
  key: 'permissions',
  header: 'Permissions',
  question:
    'What may godmode\'s agents do without asking you? Full freedom: everything, other people\'s PRs too. Free: commit, push, draft PRs, verdicts, ready and merge on your own PRs. Local only: edit and test; every git or PR write asks you. Locked: every write asks you.',
  choices: [
    { label: 'Full freedom', value: 'full-freedom' },
    { label: 'Free', value: 'free' },
    { label: 'Local only', value: 'local-only' },
    { label: 'Locked', value: 'locked' },
  ],
  half: 'personal',
}

const STORAGE: Question = {
  key: 'storage',
  header: 'Storage',
  question:
    'Where should godmode keep this project\'s conventions, settings and tickets? Committed: in the repo, shared with everyone who clones it. Gitignored: in the repo, on this machine only. Outside: under ~/.claude, the repo untouched.',
  choices: [
    { label: 'Committed', value: 'committed' },
    { label: 'Gitignored', value: 'gitignored' },
    { label: 'Outside the repo', value: 'outside' },
  ],
  half: 'shared',
}

export const TRACKER: Question = {
  key: 'tracker',
  header: 'Tracker',
  question:
    'Which tracker holds the tickets? None keeps them as markdown files godmode manages. For another tracker, pick Other and name it (Linear, GitHub Issues, ...).',
  choices: [
    { label: 'None (markdown)', value: 'none' },
    { label: 'Jira', value: 'jira' },
  ],
  half: 'shared',
  freeText: (text): Record<string, Answer> => {
    const kind = trackerKindOf(text)
    if (kind === undefined) return { tracker: 'other', trackerName: text.trim() }
    return { tracker: kind }
  },
}

export const ATTRIBUTION: Question = {
  key: 'attribution',
  header: 'Attribution',
  question: 'Should commits and PRs carry AI attribution (a "Co-Authored-By" line or a "Generated with" footer naming the AI)?',
  choices: [
    { label: 'No attribution', value: false },
    { label: 'Allow it', value: true },
  ],
  half: 'personal',
}

export const INDICATOR: Question = {
  key: 'indicator',
  header: 'Indicator',
  question:
    'How should the session show that godmode is on? Mode label: a red "godmode" among the footer\'s mode labels. Hint tag: a red tag at the end of the hint line under the prompt. Band: a thin dark red GODMODE strip above the prompt.',
  choices: [
    { label: 'Mode label', value: 'mode' },
    { label: 'Hint tag', value: 'hint' },
    { label: 'Band', value: 'band' },
  ],
  half: 'personal',
}

/**
 * A question the QA agent's work answers: the scan's runnable-UI finding only picks which
 * choice is the default (D34, D69, D71), since the agent needs an app it can run.
 */
const uiDefault = (facts: ScanFacts, yes: Choice, no: Choice) => {
  const marked = (choice: Choice): Choice => ({ ...choice, label: `${choice.label} (default)` })
  return facts.hasUi
    ? { why: `The scan found a runnable UI (${facts.uiReason ?? 'an app'}), so it defaults to ${yes.label.toLowerCase()}.`, choices: [marked(yes), no] }
    : { why: `The scan found no runnable UI, so it defaults to ${no.label.toLowerCase()}.`, choices: [marked(no), yes] }
}

/** No people test: the QA agent tests, or nobody does (D69). */
const qaAgentQuestion = (facts: ScanFacts): Question => {
  const { why, choices } = uiDefault(facts, { label: 'On', value: 'bot' }, { label: 'Off', value: 'none' })
  return {
    key: 'qaMode',
    header: 'QA agent',
    question: `Should a QA agent run the app and try each visible change after review, before it is ready for you? ${why}`,
    choices,
    half: 'shared',
  }
}

/** In a human mode, whether the QA agent tests before the people do (D71). */
const botFirstQuestion = (facts: ScanFacts): Question => {
  const { why, choices } = uiDefault(facts, { label: 'Yes', value: true }, { label: 'No', value: false })
  return {
    key: 'qaBotFirst',
    header: 'QA bot first',
    question: `Should the QA agent try each visible change first, so the people only get changes that already passed it? ${why}`,
    choices,
    half: 'shared',
  }
}

/** A status on the board, by its exact name: two common names to pick, or the board's own typed under Other. */
const boardStatusQuestion = (key: 'qaWaitStatus' | 'qaPassStatus', header: string, question: string, names: [string, string]): Question => ({
  key,
  header,
  question: `${question} Pick one, or type its exact name under Other.`,
  choices: names.map(name => ({ label: name, value: name })),
  half: 'shared',
  freeText: text => ({ [key]: text.trim() }),
})

// Common names, until `withBoardStatuses` offers the statuses read from a Jira board.
const WAIT_STATUS = boardStatusQuestion('qaWaitStatus', 'QA waiting', 'Which status on the board means a ticket waits for QA? godmode moves a ticket there after review.', ['Ready for QA', 'In QA'])
const PASS_STATUS = boardStatusQuestion('qaPassStatus', 'QA pass', 'Which status on the board means QA passed?', ['QA passed', 'Done'])

/** Which board statuses a status question puts first: likely names for waiting, then for passing. */
const LIKELY: Readonly<Record<string, { is: RegExp; isNot?: RegExp }>> = {
  qaWaitStatus: { is: /qa|test/i, isNot: /pass|done|ship|accept/i },
  qaPassStatus: { is: /pass|ship|accept|verified|done/i },
}

/**
 * A board-status question offering the statuses read from the board (Jira), the likely ones
 * first, every one named in the question; any other question as it is.
 */
export const withBoardStatuses = (question: Question, statuses: readonly string[]): Question => {
  const likely = LIKELY[question.key]
  if (likely === undefined || statuses.length === 0) return question
  const isLikely = (name: string) => likely.is.test(name) && !(likely.isNot?.test(name) ?? false)
  const ranked = [...statuses.filter(isLikely), ...statuses.filter(name => !isLikely(name))]
  const choices = ranked.slice(0, 4).map(name => ({ label: name.replace(/,/g, ' '), value: name }))
  const stem = question.question.replace(/ Pick one, or type its exact name under Other\.$/, '')
  return {
    ...question,
    question: `${stem} The board's statuses: ${statuses.join(', ')}. Pick one, or type its exact name under Other.`,
    choices: choices.length >= 2 ? choices : [...choices, ...question.choices].slice(0, 4),
  }
}

const APPROVERS: Question = {
  key: 'qaApprovers',
  header: 'QA approvers',
  question: 'Whose approval on the PR counts as a QA pass? Type their GitHub logins, comma-separated, or a team as `org/team`, under Other.',
  choices: [
    { label: 'Decide later', value: '' },
    { label: 'Nobody yet', value: '' },
  ],
  half: 'shared',
  freeText: text => ({ qaApprovers: text.trim() }),
}

/**
 * Jira and Other have a board whose statuses testers move tickets through; markdown tickets
 * do not (D24). Undefined while the tracker is unanswered.
 */
const hasBoard = (answers: Readonly<Record<string, Answer>>) => (answers.tracker === undefined ? undefined : trackerKindOf(answers.tracker) !== 'none')

const BOARD_ONLY = 'the tracker is Jira or Other'
const GITHUB_ONLY = 'PRs are on GitHub'

/**
 * Whether PRs are on GitHub; undefined while the host question, which could still answer
 * GitHub, is unanswered.
 */
const prsOnGitHub = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>) => {
  if (isGitHubHost(facts, answers)) return true
  const couldStill = answers.gitHost === undefined && hostQuestion(facts)?.choices.some(choice => choice.value === 'github') === true
  return couldStill ? undefined : false
}

/**
 * Keeps what may apply: a known true as it is, an unknown marked with the answer it waits
 * on, so one round of the PM's answers covers it too; a known false is left out.
 */
const unlessRuledOut = <T extends { onlyIf?: string }>(holds: boolean | undefined, item: T, condition: string): T[] => {
  if (holds === false) return []
  return holds === undefined ? [{ ...item, onlyIf: condition }] : [item]
}

/**
 * The pass signals besides being told (D70), each only where godmode can read it: the
 * board status with Jira or Other, a PR approval on GitHub and only before the merge.
 * Undefined when none applies.
 */
const signalsQuestion = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>): Question | undefined => {
  const offered: Choice[] = [
    ...unlessRuledOut<Choice>(hasBoard(answers), { label: 'Ticket status', value: 'ticket-status' }, BOARD_ONLY),
    ...unlessRuledOut<Choice>(answers.qaMode === 'human-pr' ? prsOnGitHub(facts, answers) : false, { label: 'PR approval', value: 'pr-approval' }, GITHUB_ONLY),
  ]
  if (offered.length === 0) return undefined
  // Every signal waiting on an unknown answer: the question itself applies only if one holds.
  const conditions = offered.map(choice => choice.onlyIf)
  const onlyIf = conditions.every(condition => condition !== undefined) ? conditions.join(' or ') : undefined
  return {
    ...(onlyIf === undefined ? {} : { onlyIf }),
    key: 'qaSignals',
    header: 'QA signals',
    question:
      'Being told always counts as a QA result. Which other signals should godmode watch? Ticket status: a tester moves the ticket to the board\'s pass status. PR approval: named people or a team approve the PR.',
    choices: [...offered, { label: 'Only being told', value: '' }],
    half: 'shared',
    multiSelect: true,
    followUps: picked => {
      const signals = qaSignalsOf(picked)
      return [...(signals.includes('ticket-status') ? [PASS_STATUS] : []), ...(signals.includes('pr-approval') ? [APPROVERS] : [])]
    },
  }
}

/** People test: on the PR or on staging, then the bot pass first, the board's waiting status and the signals. */
const whereQuestion = (facts: ScanFacts): Question => ({
  key: 'qaMode',
  header: 'QA where',
  question: 'Where do the people test: on the PR before it merges, or on staging after the merge?',
  choices: [
    { label: 'On the PR', value: 'human-pr' },
    { label: 'On staging', value: 'human-staging' },
  ],
  half: 'shared',
  followUps: answers => {
    const signals = signalsQuestion(facts, answers)
    return [botFirstQuestion(facts), ...unlessRuledOut(hasBoard(answers), WAIT_STATUS, BOARD_ONLY), ...(signals === undefined ? [] : [signals])]
  },
})

/** The QA mode (D69): whether people test first, then where they test, or else whether the QA agent does. */
export const qaQuestion = (facts: ScanFacts): Question => ({
  key: 'qaHuman',
  header: 'QA',
  question: 'Do people (QA engineers) test changes before they count as done?',
  choices: [
    { label: 'Yes, people test', value: true },
    { label: 'No', value: false },
  ],
  half: 'shared',
  followUps: answers => [answers.qaHuman === true ? whereQuestion(facts) : qaAgentQuestion(facts)],
})

/** A count the loop reads, asked only by a change-setup: three common values, or another typed under Other. */
const countQuestion = (key: 'fixRoundLimit' | 'agentCap', header: string, question: string, counts: readonly number[]): Question => ({
  key,
  header,
  question: `${question} Pick one, or type another number under Other.`,
  choices: counts.map(count => ({ label: String(count), value: count })),
  half: 'personal',
  freeText: text => {
    const count = Number.parseInt(text.trim(), 10)
    return Number.isFinite(count) && count >= 1 ? { [key]: count } : {}
  },
})

/** Fix rounds on one ticket before the PM stops and asks (D56); the loop's default is 3. */
export const FIX_ROUNDS = countQuestion('fixRoundLimit', 'Fix rounds', 'How many fix rounds may one ticket take before the PM stops and asks you? Without an answer it is 3.', [2, 3, 5])

/** Agents running at once (D58); the loop's default is 5. */
export const AGENT_CAP = countQuestion('agentCap', 'Agent cap', 'How many godmode agents may run at once? Without an answer it is 5.', [3, 5, 8])

/** Arming auto-merge (D53), off unless the person turns it on. */
export const AUTO_MERGE: Question = {
  key: 'autoMerge',
  header: 'Auto-merge',
  question:
    'May godmode arm auto-merge on your PRs once review (and QA, where it runs) passed? Off: a PR merges only when you say so. With people testing the PR, auto-merge stays refused either way.',
  choices: [
    { label: 'Off', value: false },
    { label: 'On', value: true },
  ],
  half: 'personal',
}

/** A command the scan could not find: picked from the two plain answers, or typed under Other. */
const commandQuestion = (key: 'testCommand' | 'startCommand', question: string, none: string): Question => ({
  key,
  header: key === 'testCommand' ? 'Tests' : 'Start',
  question,
  choices: [
    { label: none, value: '' },
    { label: 'Decide later', value: '' },
  ],
  half: 'shared',
  freeText: text => ({ [key]: text.trim() }),
})

/** The host question, only when `origin` exists and is not a GitHub godmode can reach (D54, D55). */
export const hostQuestion = (facts: ScanFacts): Question | undefined => {
  const { git } = facts
  if (!git.hasGit || git.origin === undefined || git.host === 'github') return undefined
  const isGitHub = /(^|\.)github\.com$/.test(git.remoteHost ?? '')
  if (isGitHub) {
    return {
      key: 'gitHost',
      header: 'PR host',
      question: `\`origin\` is on GitHub, but ${git.hostReason.replace(/^`gh`/, 'the `gh` command line')}. Sign in with \`gh auth login\` to use PRs, or keep the review on local branches?`,
      choices: [
        { label: 'I will sign in', value: 'github' },
        { label: 'Local branches', value: 'local' },
      ],
      half: 'shared',
    }
  }
  return {
    key: 'gitHost',
    header: 'PR host',
    question: `\`origin\` is on ${git.remoteHost ?? 'a host other than GitHub'}. godmode drives PRs on GitHub only so far; another host needs a mapping that is not built yet. Use local branches (review on the branch, no PR), or record the other host for later?`,
    choices: [
      { label: 'Local branches', value: 'local' },
      { label: 'Other host', value: 'other' },
    ],
    half: 'shared',
  }
}

const STACK: Question = {
  key: 'stack',
  header: 'Stack',
  question: 'The scan recognised no language from the files at the root. What is this project written in? Pick one, or type it under Other.',
  choices: [
    { label: 'TypeScript', value: 'TypeScript' },
    { label: 'Python', value: 'Python' },
    { label: 'Go', value: 'Go' },
    { label: 'Rust', value: 'Rust' },
  ],
  half: 'shared',
  freeText: text => ({ stack: text.trim() }),
}

/** The questions the scan could not answer (D29): only the gaps. */
export const gapQuestions = (facts: ScanFacts): Question[] => {
  const questions: Question[] = []
  if (facts.stacks.length === 0) questions.push(STACK)
  if (facts.commands.test === undefined) {
    questions.push(commandQuestion('testCommand', 'The scan found no test command. What runs the tests? Type the command under Other, or pick one.', 'No tests yet'))
  }
  if (facts.hasUi && facts.commands.start === undefined) {
    questions.push(commandQuestion('startCommand', 'The scan found a UI but no start command. What starts the app locally? Type it under Other, or pick one.', 'Nothing to run'))
  }
  const host = hostQuestion(facts)
  if (host !== undefined) questions.push(host)
  return questions
}

/** A question the setup agent adds, after checking it is a real gap (D29) and not about reference repos (D59). */
export const extraQuestion = (extra: ExtraQuestion): Question | string => {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(extra.key)) return `\`${extra.key}\` is not a usable answer key: letters, digits, \`_\`, \`.\`, \`-\`.`
  if (FIXED_KEYS.includes(extra.key)) return `\`${extra.key}\` is one of godmode's own questions; it is asked already.`
  if (/reference repo|other repos?\b|parity repo|sibling repo/i.test(`${extra.key} ${extra.question}`)) {
    return 'godmode never asks about reference repos at setup (D59): the person mentions one when there is one.'
  }
  const options = extra.options.map(option => option.trim()).filter(option => option !== '')
  if (options.length < 2 || options.length > 4) return `\`${extra.key}\` needs two to four options; the person can always type another answer under Other.`
  return {
    key: extra.key,
    header: (extra.header ?? extra.key).slice(0, 12),
    question: extra.question,
    choices: options.map(label => ({ label, value: label })),
    half: isPersonalKey(extra.key) ? 'personal' : 'shared',
    freeText: text => ({ [extra.key]: text.trim() }),
  }
}

/**
 * Every question a setup asks, in order. `full`: the gaps, then the person's own choices
 * (D18, D19, D23, D15, D69, D68), the QA question bringing its follow-ups. `personal`, a
 * teammate on a committed note (D61): only the personal ones, the team's answers being in
 * the note already.
 */
export const questionsFor = (facts: ScanFacts, scope: SetupScope, extras: readonly Question[] = []): Question[] => {
  if (scope === 'personal') return [PERMISSIONS, ATTRIBUTION, INDICATOR, ...extras.filter(question => question.half === 'personal')]
  return [...gapQuestions(facts), ...extras, PERMISSIONS, STORAGE, TRACKER, ATTRIBUTION, qaQuestion(facts), INDICATOR]
}

// A label may carry a mark: `(default)` from the scan, `(current)` or `(suggested)` in a change-setup.
const fold = (text: string) => text.trim().toLowerCase().replace(/\s*\((default|current|suggested)\)$/, '')

const choiceNamed = (question: Question, text: string) =>
  question.choices.find(candidate => candidate.label === text) ??
  question.choices.find(candidate => fold(candidate.label) === fold(text) || fold(String(candidate.value)) === fold(text))

/** A multi-select answer: the dialog joins the picked labels with commas; each part names a choice, or is left out. */
const resolvePicks = (question: Question, text: string): { values: Record<string, Answer>; note?: string } => {
  const parts = text.split(',').map(part => part.trim()).filter(part => part !== '')
  const picked = parts.map(part => choiceNamed(question, part))
  const unknown = parts.filter((_part, index) => picked[index] === undefined)
  const values = [...new Set(picked.flatMap(choice => (choice === undefined || choice.value === '' ? [] : [String(choice.value)])))]
  const recorded = { values: { [question.key]: values.join(',') } }
  if (unknown.length === 0) return recorded
  return { ...recorded, note: `"${unknown.join(', ')}" named none of the choices for ${question.key}, so it was left out; change it with \`/godmode setup\`.` }
}

/**
 * A question for the PM to relay when nobody could be asked, with what each choice would
 * ask next indented under it, so one round of answers can cover the whole flow.
 */
export const outline = (question: Question, answers: Readonly<Record<string, Answer>>, depth = 0): string[] => {
  const pad = '  '.repeat(depth)
  const label = (choice: Choice) => (choice.onlyIf === undefined ? choice.label : `${choice.label} [only if ${choice.onlyIf}]`)
  const when = question.onlyIf === undefined ? '' : ` (only if ${question.onlyIf})`
  const lines = [`${pad}- ${question.key}${when}: ${question.question} (${question.choices.map(label).join(' / ')})`]
  for (const choice of question.choices) {
    const after = { ...answers, [question.key]: choice.value }
    const below = (question.followUps?.(after) ?? []).flatMap(followUp => outline(followUp, after, depth + 2))
    if (below.length > 0) lines.push(`${pad}  if ${choice.label}:`, ...below)
  }
  return lines
}

/**
 * What an answer records: the choice it names (by label, or by value), else what its
 * free text means; on a closed question, text naming no choice takes the first choice,
 * and `note` says so. A multi-select answer records every choice it names.
 */
export const resolveAnswer = (question: Question, raw: string | boolean | number): { values: Record<string, Answer>; note?: string } => {
  const text = String(raw)
  if (question.multiSelect === true) return resolvePicks(question, text)
  const choice = choiceNamed(question, text)
  if (choice !== undefined) return { values: { [question.key]: choice.value } }
  if (question.freeText !== undefined) return { values: question.freeText(text) }
  const fallback = question.choices[0] as Choice
  return {
    values: { [question.key]: fallback.value },
    note: `"${text}" named none of the choices for ${question.key}, so it took "${fallback.label}"; change it with \`/godmode setup\`.`,
  }
}
