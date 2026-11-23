import type { ScanFacts } from '../types'
import type { SetupScope } from '../types'
import { WORKING_KEYS } from './project-rules'
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
export type Choice = {
  label: string
  value: Answer
  onlyIf?: string
  /** On a multi-select, words in text typed under Other that mean this choice. */
  words?: RegExp
}

/** Which half of the note an answer goes in (D61). */
export type NoteHalf = 'shared' | 'personal'

export type Question = {
  /** The answer's key in the note, as the loop reads it (`autoMerge`, `tracker`, ...). */
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
export const QA_KEYS: readonly string[] = ['qa', 'qaHuman', 'qaMode', 'qaAgent', 'qaBotFirst', 'qaWaitStatus', 'qaSignals', 'qaPassStatus', 'qaApprovers']

/** The merge conditions' keys (D77, D78): the list, the approvals it needs and whose count, and the working answers setup asks them by. */
export const MERGE_KEYS: readonly string[] = ['mergeConditions', 'humanReview', 'humanReviewCount', 'humanReviewers', 'mergeApprovals', 'mergeCi', 'mergeUpToDate', 'ciRequired']

/**
 * One more round's answers over a setup run's earlier ones. A round that answers the QA flow
 * again replaces every earlier QA answer, so a branch not taken this time leaves nothing.
 */
export const mergeAnswers = (earlier: Readonly<Record<string, Answer>>, round: Readonly<Record<string, Answer>>): Record<string, Answer> => {
  const qaAgain = Object.keys(round).some(key => QA_KEYS.includes(key) && key !== 'qaAgent')
  const kept = qaAgain ? Object.fromEntries(Object.entries(earlier).filter(([key]) => !QA_KEYS.includes(key) || key === 'qaAgent')) : earlier
  return { ...kept, ...round }
}

/** The Jira questions' keys: the server, the site, the project, and the board's name for each status. */
export const JIRA_KEYS: readonly string[] = ['jiraServer', 'jiraCloudId', 'jiraProject', 'jiraStatusMap', 'jiraTodoStatus', 'jiraDoingStatus', 'jiraReviewStatus', 'jiraDoneStatus']

/** The keys of the fixed questions; an extra question may not reuse one. */
export const FIXED_KEYS: readonly string[] = [
  'who',
  'care',
  'confirmed',
  ...MERGE_KEYS,
  'prApproval',
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
export const UNRECORDED_KEYS: readonly string[] = ['storage', 'qaHuman', 'jiraStatusMap', 'confirmed', ...WORKING_KEYS]

/** Where PRs live, as the questionnaire and the scan settled it. */
export const isGitHubHost = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>) =>
  answers.gitHost === 'github' || (answers.gitHost === undefined && facts.git.host === 'github')

/**
 * Answers that stay one person's (D61), even when the setup agent passes them. The Jira
 * server is one: each person's session names its Atlassian connector its own way.
 */
export const PERSONAL_KEYS: readonly string[] = ['care', 'prApproval', 'attribution', 'autoMerge', 'agentCap', 'fixRoundLimit', 'indicator', 'trackerAccount', 'jiraServer']

export const isPersonalKey = (key: string) => PERSONAL_KEYS.includes(key)

/** Setup's first question (D78): alone or with others. It pre-fills the people side of the rules, never which tools exist. */
export const WHO_QUESTION: Question = {
  key: 'who',
  header: 'Who',
  question: 'Do you work on this project alone, or with others?',
  choices: [
    { label: 'Alone', value: 'alone' },
    { label: 'With others', value: 'others' },
  ],
  half: 'shared',
}

/** Setup's second question (D78): whether godmode asks before a risky action. It has full access either way. */
export const CARE_QUESTION: Question = {
  key: 'care',
  header: 'Care',
  question:
    'godmode has full access either way. Careful: it asks you before risky actions (merging, force-pushing, deleting, touching others\' work). Not careful: it just does them.',
  choices: [
    { label: 'Careful: ask me first', value: 'careful' },
    { label: 'Not careful: just do it', value: 'not-careful' },
  ],
  half: 'personal',
}

/** Approvals from others before a merge (D78), asked when protection cannot tell; "None" sets no condition. */
export const APPROVALS_QUESTION: Question = {
  key: 'mergeApprovals',
  header: 'Approvals',
  question: 'Must someone other than the author approve a PR before it merges? Pick how many, or type another number under Other.',
  choices: [
    { label: 'None', value: 0 },
    { label: '1 approval', value: 1 },
    { label: '2 approvals', value: 2 },
  ],
  half: 'shared',
  freeText: text => ({ mergeApprovals: text.trim() }),
  followUps: answers =>
    Number(answers.mergeApprovals ?? 0) >= 1
      ? [
          {
            key: 'humanReviewers',
            header: 'Reviewers',
            question: 'Whose approval counts: anyone but the author, or named people? Type GitHub logins, or a team as org/team, under Other.',
            choices: [
              { label: 'Anyone', value: '' },
              { label: 'Decide later', value: '' },
            ],
            half: 'shared',
            freeText: text => ({ humanReviewers: text.trim() }),
          },
        ]
      : [],
}

/** Green CI before a merge (D78): asked only when the person changes it; the scan settles it otherwise. */
export const CI_QUESTION: Question = {
  key: 'mergeCi',
  header: 'CI',
  question: 'Must CI be green before a PR merges?',
  choices: [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
  ],
  half: 'shared',
}

/** godmode's own QA agent on godmode's own visible changes (D78): the scan's runnable UI settles it; asked only on a change. */
export const QA_AGENT_QUESTION: Question = {
  key: 'qaAgent',
  header: 'QA agent',
  question: 'Should godmode\'s QA agent run the app and try each of godmode\'s own visible changes before its PR is marked ready?',
  choices: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  half: 'shared',
}

/**
 * Merging, the headline of what godmode does alone (D53, D74): merge once review (and QA,
 * where it runs) passed, or wait for the person's go. Every other write is free.
 */
export const AUTO_MERGE: Question = {
  key: 'autoMerge',
  header: 'Merging',
  question: 'Once a PR meets this project\'s merge conditions, should godmode merge it on its own, or wait for you to say "merge"?',
  choices: [
    { label: 'Wait for my go', value: false },
    { label: 'Merge when green', value: true },
  ],
  half: 'personal',
}

export const STORAGE: Question = {
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
    'How should the session show that godmode is on? Mode label: a red "godmode" among the footer\'s mode labels. Hint tag: a red tag at the end of the hint line under the prompt. Band: a thin dark red GODMODE strip above the prompt. Side pane: a godmode panel beside the chat with live tickets, running agents and what waits on you.',
  choices: [
    { label: 'Mode label', value: 'mode' },
    { label: 'Hint tag', value: 'hint' },
    { label: 'Band', value: 'band' },
    { label: 'Side pane', value: 'pane' },
  ],
  half: 'personal',
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
  const onGitHubPr = answers.qaMode === 'human-pr' ? prsOnGitHub(facts, answers) : false
  const offered: Choice[] = [
    ...unlessRuledOut<Choice>(hasBoard(answers), { label: 'Ticket status', value: 'ticket-status', words: /status|done|move|column|board|transition/i }, BOARD_ONLY),
    ...unlessRuledOut<Choice>(onGitHubPr, { label: 'PR approval', value: 'pr-approval', words: /approv/i }, GITHUB_ONLY),
    ...unlessRuledOut<Choice>(onGitHubPr, { label: 'PR merged', value: 'pr-merged', words: /merg/i }, GITHUB_ONLY),
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
      'Being told always counts as a QA result. Which other signals should godmode watch? Ticket status: a tester moves the ticket to the board\'s pass status. PR approval: named people or a team approve the PR. PR merged: someone merges the PR themselves while its ticket waits for QA.',
    choices: [...offered, { label: 'Only being told', value: '' }],
    half: 'shared',
    multiSelect: true,
    followUps: picked => {
      const signals = qaSignalsOf(picked)
      return [...(signals.includes('ticket-status') ? [PASS_STATUS] : []), ...(signals.includes('pr-approval') ? [APPROVERS] : [])]
    },
  }
}

/**
 * Whether anyone tests changes besides their author (D78), and where: the QA mode's people part.
 * "No one" leaves no rule; godmode's own QA agent is its own answer (`qaAgent`).
 */
export const peopleQaQuestion = (facts: ScanFacts): Question => ({
  key: 'qaMode',
  header: 'QA',
  question: 'Does anyone test changes besides their author: on the PR before it merges, or on staging after?',
  choices: [
    { label: 'No one', value: 'none' },
    { label: 'On the PR', value: 'human-pr' },
    { label: 'On staging', value: 'human-staging' },
  ],
  half: 'shared',
  followUps: answers => {
    if (answers.qaMode !== 'human-pr' && answers.qaMode !== 'human-staging') return []
    const signals = signalsQuestion(facts, answers)
    return [...unlessRuledOut(hasBoard(answers), WAIT_STATUS, BOARD_ONLY), ...(signals === undefined ? [] : [signals])]
  },
})

/** A count the loop reads: three common values, or another typed under Other. */
const countQuestion = (key: 'fixRoundLimit' | 'agentCap', header: string, question: string, counts: readonly number[], half: NoteHalf = 'personal'): Question => ({
  key,
  header,
  question: `${question} Pick one, or type another number under Other.`,
  choices: counts.map(count => ({ label: String(count), value: count })),
  half,
  // The answer rules read the count, and ask again with the reason when it is none.
  freeText: text => ({ [key]: text.trim() }),
})

/** Fix rounds on one ticket before the PM stops and asks (D56); the loop's default is 3. */
export const FIX_ROUNDS = countQuestion('fixRoundLimit', 'Fix rounds', 'How many fix rounds may one ticket take before the PM stops and asks you? Without an answer it is 3.', [2, 3, 5])

/** Agents running at once (D58); the loop's default is 5. */
export const AGENT_CAP = countQuestion('agentCap', 'Agent cap', 'How many godmode agents may run at once? Without an answer it is 5.', [3, 5, 8])

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
    { label: 'Not decided yet', value: '' },
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
 * The questions every setup asks (D78), in order: Who and Care, then the gaps the scan left,
 * storage and the tracker. The summary's other "?" items follow, as the answers leave them
 * open. `personal`, a teammate on a committed note (D61): Care alone, the team's answers being
 * in the note already.
 */
export const questionsFor = (facts: ScanFacts, scope: SetupScope, extras: readonly Question[] = []): Question[] => {
  if (scope === 'personal') return [CARE_QUESTION, ...extras.filter(question => question.half === 'personal')]
  return [WHO_QUESTION, CARE_QUESTION, ...gapQuestions(facts), ...extras, STORAGE, TRACKER]
}

// A label may carry a mark: `(default)` from the scan, `(current)` or `(suggested)` in a change-setup.
const fold = (text: string) => text.trim().toLowerCase().replace(/\s*\((default|current|suggested)\)$/, '')

const choiceNamed = (question: Question, text: string) =>
  question.choices.find(candidate => candidate.label === text) ??
  question.choices.find(candidate => fold(candidate.label) === fold(text) || fold(String(candidate.value)) === fold(text))

/** Whether an answer names one of the question's own choices, by label or by value (each part, on a multi-select). */
export const namesChoice = (question: Question, raw: string | boolean | number) =>
  (question.multiSelect === true ? String(raw).split(',') : [String(raw)]).every(part => choiceNamed(question, part.trim()) !== undefined)

/** The choices whose words a part typed under Other holds, as a person describes them in a sentence. */
const choicesWorded = (question: Question, part: string) => question.choices.filter(choice => choice.words?.test(part) === true)

/**
 * A multi-select answer: the dialog joins the picked labels with commas, and text typed under
 * Other joins them too, commas and all. Each part names a choice, or else is read for the
 * words of each choice; a part that holds neither is left out.
 */
const resolvePicks = (question: Question, text: string): { values: Record<string, Answer>; note?: string } => {
  const parts = text.split(',').map(part => part.trim()).filter(part => part !== '')
  const named = parts.map(part => choiceNamed(question, part))
  const worded = parts.map((part, index) => (named[index] === undefined ? choicesWorded(question, part) : []))
  const picked = [...named.flatMap(choice => choice ?? []), ...worded.flat()]
  const unknown = parts.filter((_part, index) => named[index] === undefined && worded[index]?.length === 0)
  const values = [...new Set(picked.flatMap(choice => (choice.value === '' ? [] : [String(choice.value)])))]
  const read = parts.flatMap((part, index) => {
    const choices = worded[index] ?? []
    return choices.length === 0 ? [] : [`"${part}" was read as ${choices.map(choice => choice.label).join(' and ')}`]
  })
  const left = unknown.length === 0 ? [] : [`"${unknown.join(', ')}" named none of the choices for ${question.key}, so it was left out`]
  const notes = [...read, ...left]
  const recorded = { values: { [question.key]: values.join(',') } }
  if (notes.length === 0) return recorded
  return { ...recorded, note: `${notes.join('; ')}; change it with \`/godmode setup\`.` }
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
