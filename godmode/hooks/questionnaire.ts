import type { ScanFacts } from '../types'
import type { SetupScope } from '../types'
import type { Answer } from './storage'
import { trackerKindOf } from './tickets'

/*
 * The setup questionnaire (D8, D14, D29) as plain data: which questions a setup asks,
 * and what each answer means. Multiple choice, one question at a time through
 * godmode's own dialog (`$.ui.ask`), since a subagent has no AskUserQuestion tool.
 * `setup.ts` asks them.
 */

/** One choice: the label the person picks, and the answer it records. */
export type Choice = { label: string; value: Answer }

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
}

/** A question the setup agent adds for a gap of its own (D29). */
export type ExtraQuestion = { key: string; question: string; options: string[]; header?: string }

/** The keys of the fixed questions; an extra question may not reuse one. */
export const FIXED_KEYS: readonly string[] = ['permissions', 'storage', 'tracker', 'attribution', 'qa', 'indicator', 'gitHost', 'stack', 'testCommand', 'startCommand']

/** Answers that stay one person's (D61), even when the setup agent passes them. */
export const PERSONAL_KEYS: readonly string[] = ['permissions', 'attribution', 'autoMerge', 'agentCap', 'fixRoundLimit', 'indicator', 'trackerAccount']

export const isPersonalKey = (key: string) => PERSONAL_KEYS.includes(key) || key.startsWith('permission.')

const PERMISSIONS: Question = {
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

const TRACKER: Question = {
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

const ATTRIBUTION: Question = {
  key: 'attribution',
  header: 'Attribution',
  question: 'Should commits and PRs carry AI attribution (a "Co-Authored-By" line or a "Generated with" footer naming the AI)?',
  choices: [
    { label: 'No attribution', value: false },
    { label: 'Allow it', value: true },
  ],
  half: 'personal',
}

const INDICATOR: Question = {
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

/** QA defaults on only when the scan found an app to click through (D34). */
const qaQuestion = (facts: ScanFacts): Question => {
  const why = facts.hasUi ? `The scan found a runnable UI (${facts.uiReason ?? 'an app'}), so it defaults on.` : 'The scan found no runnable UI, so it defaults off.'
  const on: Choice = { label: facts.hasUi ? 'On (default)' : 'On', value: true }
  const off: Choice = { label: facts.hasUi ? 'Off' : 'Off (default)', value: false }
  return {
    key: 'qa',
    header: 'QA',
    question: `Should a QA agent run the app and try each visible change after review, before it is ready for you? ${why}`,
    choices: facts.hasUi ? [on, off] : [off, on],
    half: 'shared',
  }
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
const hostQuestion = (facts: ScanFacts): Question | undefined => {
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
 * (D18, D19, D23, D15, D34, D68). `personal`, a teammate on a committed note (D61): only
 * the personal ones, the team's answers being in the note already.
 */
export const questionsFor = (facts: ScanFacts, scope: SetupScope, extras: readonly Question[] = []): Question[] => {
  if (scope === 'personal') return [PERMISSIONS, ATTRIBUTION, INDICATOR, ...extras.filter(question => question.half === 'personal')]
  return [...gapQuestions(facts), ...extras, PERMISSIONS, STORAGE, TRACKER, ATTRIBUTION, qaQuestion(facts), INDICATOR]
}

const fold = (text: string) => text.trim().toLowerCase().replace(/\s*\(default\)$/, '')

/**
 * What an answer records: the choice it names (by label, or by value), else what its
 * free text means; on a closed question, text naming no choice takes the first choice,
 * and `note` says so.
 */
export const resolveAnswer = (question: Question, raw: string | boolean | number): { values: Record<string, Answer>; note?: string } => {
  const text = String(raw)
  const choice =
    question.choices.find(candidate => candidate.label === text) ??
    question.choices.find(candidate => fold(candidate.label) === fold(text) || fold(String(candidate.value)) === fold(text))
  if (choice !== undefined) return { values: { [question.key]: choice.value } }
  if (question.freeText !== undefined) return { values: question.freeText(text) }
  const fallback = question.choices[0] as Choice
  return {
    values: { [question.key]: fallback.value },
    note: `"${text}" named none of the choices for ${question.key}, so it took "${fallback.label}"; change it with \`/godmode setup\`.`,
  }
}
