import type { ScanFacts } from '../types'
import {
  AGENT_CAP,
  ATTRIBUTION,
  AUTO_MERGE,
  FIX_ROUNDS,
  gapQuestions,
  hostQuestion,
  INDICATOR,
  isPersonalKey,
  JIRA_KEYS,
  PERMISSIONS,
  QA_KEYS,
  qaQuestion,
  TRACKER,
  UNRECORDED_KEYS,
} from './questionnaire'
import type { Choice, Question } from './questionnaire'
import { qaModeOf } from './role'
import { isOlderVersion } from './storage'
import type { Answer } from './storage'

/*
 * Change-setup mode (Step 11; D21, D22, D60) as plain data and pure helpers: which
 * questions a change asks, which recorded answers it replaces, and what a note looks like
 * after it. The person says what to change in their own words; the PM names the topics,
 * and `setup.ts` asks them and writes the note through the same two tools setup uses.
 */

/** What a change-setup can re-ask: each topic owns the note's keys its questions record. */
type Topic = { keys: readonly string[]; questions: (facts: ScanFacts) => Question[] | string }

const TRACKER_KEYS: readonly string[] = ['tracker', 'trackerName', ...JIRA_KEYS]

const TOPICS = {
  gitHost: {
    keys: ['gitHost'],
    questions: facts => {
      const question = hostQuestion(facts)
      return question === undefined ? '`origin` is a GitHub godmode reaches, or there is no `origin`: there is no PR host to choose.' : [question]
    },
  },
  permissions: { keys: ['permissions'], questions: () => [PERMISSIONS] },
  tracker: { keys: TRACKER_KEYS, questions: () => [TRACKER] },
  // The tracker question answered as Jira unasked, so only the Jira questions run again.
  jira: { keys: TRACKER_KEYS, questions: () => [TRACKER] },
  attribution: { keys: ['attribution'], questions: () => [ATTRIBUTION] },
  qa: { keys: QA_KEYS, questions: facts => [qaQuestion(facts)] },
  indicator: { keys: ['indicator'], questions: () => [INDICATOR] },
  autoMerge: { keys: ['autoMerge'], questions: () => [AUTO_MERGE] },
  agentCap: { keys: ['agentCap'], questions: () => [AGENT_CAP] },
  fixRoundLimit: { keys: ['fixRoundLimit'], questions: () => [FIX_ROUNDS] },
} as const satisfies Record<string, Topic>

export type ChangeTopic = keyof typeof TOPICS

/** The topics in the order a setup asks them. */
const TOPIC_ORDER = Object.keys(TOPICS) as ChangeTopic[]

const isTopic = (name: string): name is ChangeTopic => TOPIC_ORDER.some(topic => topic === name)

/** What `all` re-asks besides the scan's gaps: a full setup's own questions, storage aside. */
const FULL_SETUP: readonly ChangeTopic[] = ['permissions', 'tracker', 'attribution', 'qa', 'indicator']

/** The topic names the PM may pass, for its brief and for a refusal. */
export const TOPIC_HELP =
  'permissions, attribution, indicator, autoMerge, agentCap, fixRoundLimit (the person\'s own); tracker, jira (the Jira questions again: server, site, project, statuses), qa (the QA mode and what it leads to), gitHost (the team\'s); all (every setup question but storage); update (only what is new since the note\'s godmode version)'

/** The note's keys only a topic's questions may set: `setup_finish`'s free `answers` may not. */
export const OWNED_KEYS: readonly string[] = [...new Set([...Object.values(TOPICS).flatMap(topic => topic.keys), ...UNRECORDED_KEYS])]

/** Questions added after a version, offered once to a note written by that version or earlier (D60). */
type NewQuestions = {
  after: string
  topic: ChangeTopic
  what: string
  /** Whether a note's answers still lack them: a note written while they were being built may hold them already. */
  isMissing: (answers: Readonly<Record<string, Answer>>) => boolean
}

export const NEW_QUESTIONS: readonly NewQuestions[] = [
  {
    after: '0.5.0',
    topic: 'qa',
    what: 'the QA mode (whether people test on the PR or on staging, or the QA agent, or nobody, and how godmode learns the result)',
    isMissing: answers => answers.qaMode === undefined,
  },
]

/** The questions new since the note's version that its answers lack; none unless this godmode is newer than the note. */
export const pendingUpdates = (noteVersion: string, current: string, answers: Readonly<Record<string, Answer>>) =>
  NEW_QUESTIONS.filter(entry => !isOlderVersion(entry.after, noteVersion) && isOlderVersion(entry.after, current) && entry.isMissing(answers))

const isHumanQa = (answers: Readonly<Record<string, Answer>>) => qaModeOf(answers).startsWith('human')

/** What one change-setup round asks, which recorded keys it replaces, and the answers it takes as given. */
export type ChangePlan = { topics: ChangeTopic[]; questions: Question[]; dropped: string[]; given: Record<string, Answer> }

/**
 * The plan for the topics the PM named. `update` stands for the topics `pending` names; `all`
 * for a full setup's questions and the scan's gaps. A new tracker brings the QA flow again
 * when people test, since its waiting and pass statuses live on the board. A refusal is a string.
 */
export const changePlan = (
  facts: ScanFacts,
  requested: readonly string[],
  current: Readonly<Record<string, Answer>>,
  pending: readonly ChangeTopic[] = [],
): ChangePlan | string => {
  const names = new Set<string>()
  let gaps: Question[] = []
  for (const raw of requested) {
    const name = raw.trim()
    if (name === 'storage') return 'Where the setup is kept (storage) cannot change here: it would move the note, the conventions and the tickets. Nothing was asked.'
    if (name === 'update') for (const topic of pending) names.add(topic)
    else if (name === 'all') {
      for (const topic of FULL_SETUP) names.add(topic)
      gaps = gapQuestions(facts)
    } else if (isTopic(name)) names.add(name)
    else return `\`${name}\` is not something change-setup asks. The topics: ${TOPIC_HELP}. A setting with no question of its own goes in setup_finish's \`answers\`.`
  }
  if (names.has('tracker')) names.delete('jira')
  if ((names.has('tracker') || names.has('jira')) && isHumanQa(current)) names.add('qa')
  const topics = TOPIC_ORDER.filter(topic => names.has(topic))
  const questions: Question[] = [...gaps]
  for (const topic of topics) {
    const asked = TOPICS[topic].questions(facts)
    if (typeof asked === 'string') return asked
    questions.push(...asked)
  }
  const dropped = [...new Set([...gaps.map(question => question.key), ...topics.flatMap(topic => TOPICS[topic].keys)])]
  return { topics, questions, dropped, given: topics.includes('jira') ? { tracker: 'jira' } : {} }
}

/** An answer to offer first: the one the note holds (`current`), or one read from an older answer (`suggested`). */
export type Suggestion = { value: Answer; mark: 'current' | 'suggested' }

/**
 * The note's answers as each question's first choice. A note from before the QA modes holds
 * `qa: true` or `false`; it suggests `bot` or `none`, and no people testing (D69's defaults).
 */
export const suggestionsOf = (answers: Readonly<Record<string, Answer>>): Record<string, Suggestion> => {
  const suggestions: Record<string, Suggestion> = Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value, mark: 'current' as const }]))
  if (answers.qaMode === undefined && answers.qa === undefined) return suggestions
  const mark = answers.qaMode === undefined ? ('suggested' as const) : ('current' as const)
  suggestions.qaMode = { value: qaModeOf(answers), mark }
  suggestions.qaHuman = { value: isHumanQa(answers), mark }
  return suggestions
}

const unmarked = (label: string) => label.replace(/\s*\((default|current|suggested)\)$/, '')

/**
 * A question with the note's answer first and marked. A free-text answer that is no choice
 * (a board status typed in) becomes the first choice; a closed question without it is unchanged.
 */
export const withSuggestion = (question: Question, suggestions: Readonly<Record<string, Suggestion>>): Question => {
  const suggestion = suggestions[question.key]
  if (suggestion === undefined) return question
  const values = question.multiSelect === true ? String(suggestion.value).split(',').map(part => part.trim()) : [String(suggestion.value)]
  const isPicked = (choice: Choice) => values.includes(String(choice.value))
  const plain = question.choices.map(choice => ({ ...choice, label: unmarked(choice.label) }))
  let picked = plain.filter(isPicked)
  const canAdd = question.multiSelect !== true && question.freeText !== undefined && typeof suggestion.value === 'string' && suggestion.value !== '' && !suggestion.value.includes(',')
  if (picked.length === 0 && canAdd) picked = [{ label: String(suggestion.value), value: suggestion.value }]
  if (picked.length === 0) return question
  const marked = picked.map(choice => ({ ...choice, label: `${choice.label} (${suggestion.mark})` }))
  const rest = plain.filter(choice => !isPicked(choice))
  return { ...question, choices: [...marked, ...rest].slice(0, Math.max(4, marked.length)) }
}

/**
 * Both halves after a change: the keys the asked topics own are cleared first, so a branch
 * not taken this time leaves nothing behind; then the person's answers, then the PM's free
 * settings (an empty one clears its key). Each key lands in its half (D61).
 */
export const applyChange = (
  shared: Readonly<Record<string, Answer>>,
  personal: Readonly<Record<string, Answer>>,
  dropped: readonly string[],
  round: Readonly<Record<string, Answer>>,
  settings: Readonly<Record<string, Answer>> = {},
) => {
  const keep = (half: Readonly<Record<string, Answer>>) => Object.fromEntries(Object.entries(half).filter(([key]) => !dropped.includes(key)))
  const next = { shared: keep(shared), personal: keep(personal) }
  const put = (key: string, value: Answer) => {
    delete next.shared[key]
    delete next.personal[key]
    if (value === '' || UNRECORDED_KEYS.includes(key)) return
    if (isPersonalKey(key)) next.personal[key] = value
    else next.shared[key] = value
  }
  for (const [key, value] of Object.entries(round)) put(key, value)
  for (const [key, value] of Object.entries(settings)) put(key, value)
  return next
}

const shown = (value: Answer | undefined) => (value === undefined ? '(none)' : JSON.stringify(value))

/** One line per key whose answer differs, as the person sees it before saving. */
export const answerChanges = (before: Readonly<Record<string, Answer>>, after: Readonly<Record<string, Answer>>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => before[key] !== after[key])
    .map(key => (after[key] === undefined ? `${key}: ${shown(before[key])} removed` : `${key}: ${shown(before[key])} -> ${shown(after[key])}`))

/** Whether two halves hold the same answers. */
export const sameAnswers = (a: Readonly<Record<string, Answer>>, b: Readonly<Record<string, Answer>>) => answerChanges(a, b).length === 0

/** The line `/godmode setup` shows about the note's version (D60), if any. */
export const updateOfferLine = (noteVersion: string, current: string, pending: readonly NewQuestions[]) => {
  if (pending.length > 0) {
    return `godmode ${current} asks something new since this project's setup (${noteVersion}): ${pending.map(entry => entry.what).join('; ')}. Say yes to answer it; nothing changes until you do.`
  }
  return isOlderVersion(noteVersion, current) ? `This project was set up with godmode ${noteVersion}; ${current} asks nothing new of it.` : undefined
}

/** What the PM is told when `/godmode setup` opens change-setup mode: how to apply a change, and the setup as it stands. */
export const changeSetupBrief = (note: {
  noteVersion: string
  version: string
  storage: string
  dir: string
  answers: Readonly<Record<string, Answer>>
  pending: readonly NewQuestions[]
}) => {
  const answers = Object.entries(note.answers).map(([key, value]) => `${key} ${JSON.stringify(value)}`)
  return [
    `godmode is on in change-setup mode: the person says what to change in their own words, and you apply it through godmode's tools. Never edit the setup note in ${note.dir} yourself.`,
    `The setup as it stands (godmode ${note.noteVersion}, ${note.storage} storage): ${answers.join(', ') || 'no answers'}.`,
    `Name what they ask as topics and call mcp__godmode__setup_questionnaire with \`change\`: ${TOPIC_HELP}. It asks the person only those questions and the ones they lead to, in godmode's dialog, offering the current answer first; every other answer is kept. Do not ask those questions yourself.`,
    'Then call mcp__godmode__setup_finish. It shows the person every change and saves only on their yes. Every end of the change, saved or not, switches back to coding mode, and the person typing `/godmode` ends it unsaved. A setting with no question of its own (testCommand, startCommand, baseBranch, branchPrefix, worktreeFolder, ...) goes in its `answers`; a conventions file you edited for the change goes in its `conventions`, so its fingerprint is taken again.',
    ...(note.pending.length === 0
      ? []
      : [
          `This setup predates godmode ${note.version}, which asks something new: ${note.pending.map(entry => entry.what).join('; ')}. If the person wants it, call setup_questionnaire with change ["update"]: it asks them first, then only the new questions, their old answers offered as the suggestion.`,
        ]),
    'If setup_questionnaire says it could not ask the person, ask them its questions in plain words and call it again with their answers as `given`.',
  ].join('\n')
}
