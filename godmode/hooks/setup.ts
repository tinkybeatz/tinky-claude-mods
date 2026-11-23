import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolSpec } from 'claude-code'

import type { GodmodeMode, IndicatorStyle, ScanFacts, SetupRun, SetupScope } from '../types'
import {
  answerChanges,
  applyChange,
  changePlan,
  changeSetupBrief,
  migratedAnswers,
  MIGRATED_AWAY,
  OWNED_KEYS,
  pendingUpdates,
  sameAnswers,
  suggestionsOf,
  TOPIC_HELP,
  updateOfferLine,
  withSuggestion,
} from './change-setup'
import { answerIssueLines, checkAnswer, savedAnswers } from './answers'
import { answerFindings, auditBrief, auditNote, auditText } from './audit'
import { indicatorOf } from './indicator'
import { logLines, questionText } from './ui-text'
import { jiraSetup, personalJiraQuestions } from './jira'
import { liveFactsOf } from './live-facts'
import { openGodmodePane } from './pane'
import { toNoteAnswers, NO_LIVE_FACTS, WORKING_KEYS, prefill, PROJECT_RULES_FILE, projectRulesText, ownRulesIn, summaryLines, summaryText, workingAnswersOf } from './project-rules'
import type { AreaFiles, Source } from './project-rules'
import {
  APPROVALS_QUESTION,
  ATTRIBUTION,
  AUTO_MERGE,
  CARE_QUESTION,
  CI_QUESTION,
  extraQuestion,
  gapQuestions,
  isGitHubHost,
  isPersonalKey,
  JIRA_KEYS,
  mergeAnswers,
  namesChoice,
  outline,
  peopleQaQuestion,
  QA_AGENT_QUESTION,
  QA_KEYS,
  questionsFor,
  resolveAnswer,
  STORAGE,
  TRACKER,
  UNRECORDED_KEYS,
  WHO_QUESTION,
  withBoardStatuses,
} from './questionnaire'
import type { ExtraQuestion, Question } from './questionnaire'
import { qaModeLine, qaModeOf } from './role'
import { COMMAND_KEYS, commandKey, presetFoldersFor, scanProject } from './scan'
import { trackerKindOf } from './tickets'
import { verifyAnswer, verifyAnswers } from './verify'
import {
  claudeDirOf,
  conventionsDirOf,
  ensureExcluded,
  fingerprintOf,
  gitignoreLines,
  godmodeVersionOf,
  isOlderVersion,
  notePath,
  presetTarget,
  projectOf,
  readNote,
  REPO_FOLDER,
  STORAGE_MODES,
  writeNote,
  writePersonalNote,
  writeSharedNote,
} from './storage'
import type { Answer, NoteLookup, Project, SharedNote, StorageMode } from './storage'

/*
 * Setup mode (Step 3; D3, D8, D9, D14, D15, D18, D19, D23, D29-D34, D54, D59, D61, D68).
 * The PM dispatches the setup agent (`agents/setup.md`, Opus), which works in its own
 * context through five godmode tools, so the main thread stays clean:
 *
 *   setup_scan          the deterministic scan, and the templates on offer
 *   setup_questionnaire the questions, asked of the person through godmode's own dialog
 *   setup_confirm       the person's yes before weak conventions are improved in place
 *   setup_write_preset  the convention templates, written where the storage answer says
 *   setup_finish        the note, with fingerprints; godmode goes to coding mode
 *
 * A subagent has no AskUserQuestion tool (the engine strips it), so the questions go
 * through these tools, which ask with `$.ui.ask`. Every helper here that takes `$` is a
 * function declaration: the engine follows `$` past an import only into those.
 */

// The same state as `register.tsx`'s atoms: `validate` reads a state source only from this file.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const setupScope = atom({ plugin: 'godmode', key: 'setupScope' } as const, 'full' as SetupScope)
const recheck = atom({ plugin: 'godmode', key: 'recheck' } as const, [] as string[])
const setupRun = atom({ plugin: 'godmode', key: 'setupRun' } as const, { consented: [], written: [] } as SetupRun)
const setupReport = atom({ plugin: 'godmode', key: 'setupReport' } as const, '')
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'mode' as IndicatorStyle)

export type SetupToolName = 'setup_scan' | 'setup_questionnaire' | 'setup_confirm' | 'setup_write_preset' | 'setup_finish'

const text = (description: string) => ({ type: 'string', description })

/** The setup agent's tools. Only setup mode serves them. */
export const SETUP_TOOLS: readonly (ToolSpec & { name: SetupToolName })[] = [
  {
    name: 'setup_scan',
    description:
      'godmode setup, step 1: scan the project (stacks, build/test/start/lint commands, git and PR host, existing conventions files, runnable UI) and list the convention templates godmode ships. Call it first.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  },
  {
    name: 'setup_questionnaire',
    description:
      'godmode setup, step 2: ask the person the setup questions, one multiple-choice dialog each: only the gaps the scan left, then merging, approvals, storage, tracker, attribution, QA (with the follow-ups its answers lead to) and the on-indicator. Every answer, typed or given, is read through godmode\'s answer rules and checked against Jira, GitHub and package.json; one that does not hold is asked again with the reason. Add a question only for a real gap the scan could not settle; never about reference repos. `given` holds answers the person already gave (relayed by the PM), which are not asked again. In change-setup mode (`/godmode setup`), pass `change`: only those topics are asked again, with the follow-ups they lead to, and nothing is saved until setup_finish.',
    inputSchema: {
      type: 'object',
      properties: {
        extra: {
          type: 'array',
          description: 'Gap questions of your own, each with two to four options (the person can always type another answer).',
          items: {
            type: 'object',
            properties: {
              key: text('The answer\'s key in the note, e.g. `e2eCommand`.'),
              question: text('The question, ending in a question mark.'),
              options: { type: 'array', items: { type: 'string' } },
              header: text('A chip of up to 12 characters.'),
            },
            required: ['key', 'question', 'options'],
          },
        },
        given: { type: 'object', description: 'Answers the person already gave, by key (`autoMerge`, `prApproval`, `storage`, `tracker`, `qaHuman`, `qaMode`, ...).' },
        change: { type: 'array', items: { type: 'string' }, description: `Change-setup mode only: what the person wants to change, as topics: ${TOPIC_HELP}.` },
      },
    },
    isDeferred: false,
  },
  {
    name: 'setup_confirm',
    description:
      'godmode setup: before improving the project\'s existing conventions in place, ask the person once. Say what would change and why in a line or two each; an edit to an existing conventions file is refused until the person says yes.',
    inputSchema: {
      type: 'object',
      properties: {
        change: text('What would change, in a line or two.'),
        why: text('Why, in a line or two. Do not over-justify.'),
        files: { type: 'array', items: { type: 'string' }, description: 'The files the change touches; all existing conventions files when left out.' },
      },
      required: ['change', 'why'],
    },
    isDeferred: false,
  },
  {
    name: 'setup_write_preset',
    description:
      'godmode setup: write convention templates into the project where the storage answer says, filling in what the scan found. Never overwrites a file. With no `pieces`, writes every required template and the stack\'s preset notes (for a project with no conventions); with `pieces`, only those required templates (to fill missing pieces next to solid conventions).',
    inputSchema: {
      type: 'object',
      properties: {
        pieces: { type: 'array', items: { type: 'string' }, description: 'Required template file names to write, as setup_scan lists them.' },
        optional: { type: 'array', items: { type: 'string' }, description: 'Optional template file names to add.' },
        stack: { type: 'string', description: 'The preset folder for the stack\'s notes, when not the one setup_scan picked; "none" for no stack notes.' },
      },
    },
    isDeferred: false,
  },
  {
    name: 'setup_finish',
    description:
      'godmode setup, last step: write the setup note with a fingerprint of each conventions file, so the next /godmode starts in coding mode, and switch godmode to coding mode. Every required template must be written or covered by an existing file named in `covered`. In change-setup mode it shows the person every change and saves only on their yes: `answers` then holds settings with no question of their own (`testCommand`, `baseBranch`, ...; an empty value clears one), and `conventions` the files the change edited, whose fingerprints are taken again.',
    inputSchema: {
      type: 'object',
      properties: {
        conventions: {
          type: 'array',
          items: { type: 'string' },
          description: 'The conventions files the loop follows (adopted, improved or written); every existing one from setup_scan when left out.',
        },
        covered: { type: 'object', description: 'Required template name -> the existing file that covers that piece, e.g. {"testing.md": "docs/testing.md"}.' },
        answers: { type: 'object', description: 'Settings the scan or your reading settled, e.g. {"testCommand": "pnpm test", "baseBranch": "main"}.' },
      },
    },
    isDeferred: false,
  },
]

export const SETUP_TOOL_NAMES: readonly SetupToolName[] = SETUP_TOOLS.map(tool => tool.name)

/** A setup tool's refusal: the model reads it as the tool's error. */
export class SetupError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAnswer = (value: unknown): value is Answer => ['string', 'number', 'boolean'].includes(typeof value)

const answersIn = (value: unknown, field: string): Record<string, Answer> => {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new SetupError(`\`${field}\` must be an object of answers by key.`)
  const entries = Object.entries(value)
  const bad = entries.find(entry => !isAnswer(entry[1]))
  if (bad !== undefined) throw new SetupError(`\`${field}.${bad[0]}\` must be text, a number or true/false.`)
  return Object.fromEntries(entries) as Record<string, Answer>
}

const stringsIn = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new SetupError(`\`${field}\` must be a list of text.`)
  return value.map(item => item.trim()).filter(item => item !== '')
}

const absoluteIn = (project: Project, path: string) => (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${project.root}/${path.replace(/^\.\//, '')}`)

// ---------------------------------------------------------------------------
// Templates (Step 4's files, read by listing their folders)

export type TemplateFile = { name: string; path: string }

/** What `templates/` holds: required and optional pieces (D31), and one folder of notes per stack. */
export type TemplateSet = { required: TemplateFile[]; optional: TemplateFile[]; presets: Record<string, TemplateFile[]> }


/**
 * The values the templates' `{{name}}` placeholders take (see `templates/README.md`), from
 * the scan and the answers. A placeholder with no value is left as written, for the setup
 * agent to fill in or to remove with its line.
 */
export const templateValues = (
  facts: ScanFacts,
  answers: Readonly<Record<string, Answer>>,
  paths: { conventionsDir: string; date: string },
): Record<string, string> => {
  const text = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const languages = [...new Set(facts.stacks.flatMap(stack => [stack.language, stack.framework ?? '']).filter(part => part !== ''))]
  const values: Record<string, string | undefined> = {
    projectName: facts.name,
    stack: languages.length > 0 ? languages.join(', ') : text(answers.stack),
    language: facts.stacks[0]?.language ?? text(answers.stack),
    packageManager: facts.stacks[0]?.packageManager,
    baseBranch: text(answers.baseBranch) ?? facts.git.baseBranch,
    branchPrefix: text(answers.branchPrefix) ?? 'godmode/',
    gitHost: isGitHubHost(facts, answers) ? 'GitHub' : answers.gitHost === 'other' ? `${facts.git.remoteHost ?? 'another host'} (mapped by godmode later)` : 'local branches (no PRs; review runs on the branch)',
    tracker:
      answers.tracker === 'jira' ? 'Jira' : answers.tracker === 'other' ? (text(answers.trackerName) ?? 'another tracker') : 'markdown tickets kept by godmode',
    attributionPolicy:
      answers.attribution === true ? 'Commit messages and PR texts may carry AI attribution.' : 'Commit messages and PR texts carry no AI attribution.',
    conventionsDir: paths.conventionsDir,
    decisionsLog: `${paths.conventionsDir}/decisions-log.md`,
    knowledgeFile: `${paths.conventionsDir}/knowledge.md`,
    adrDir: facts.conventions.map(path => /^(.*\/)?(adrs?|decisions)\//i.exec(path)?.[0]?.replace(/\/$/, '')).find(dir => dir !== undefined),
    date: paths.date,
  }
  for (const key of COMMAND_KEYS) values[commandKey(key)] = text(answers[commandKey(key)]) ?? facts.commands[key]
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''))
}

/** The placeholder a stack's notes file fills: `coding.md` is `{{languageNotes}}`, `testing.md` `{{testingNotes}}`. */
export const notesKey = (fileName: string) => {
  const base = fileName.replace(/\.md$/i, '')
  if (base.toLowerCase() === 'coding') return 'languageNotes'
  return `${base.replace(/[-_\s]+(\w)/g, (_whole, letter: string) => letter.toUpperCase())}Notes`
}

/** A template's text with each `{{name}}` it has a value for filled in. */
export const fillTemplate = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (whole, name: string) => values[name] ?? whole)

/** The markdown files in one template folder, by name; none when the folder is missing. */
async function templateFiles($: EngineInterface, folder: string): Promise<TemplateFile[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  return entries
    .filter(entry => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => ({ name: entry.name, path: `${folder}/${entry.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Every template godmode ships, listed at run time so whatever files Step 4 holds are used. */
export async function listTemplates($: EngineInterface): Promise<TemplateSet> {
  const root = `${$.plugin.root}/templates`
  const presets: Record<string, TemplateFile[]> = {}
  for (const entry of await $.fs.list(`${root}/presets`).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    const files = await templateFiles($, `${root}/presets/${entry.name}`)
    if (files.length > 0) presets[entry.name] = files
  }
  return { required: await templateFiles($, `${root}/required`), optional: await templateFiles($, `${root}/optional`), presets }
}

// ---------------------------------------------------------------------------
// The run's state

async function runOf($: EngineInterface) {
  return read($, setupRun)
}

async function saveRun($: EngineInterface, change: (run: SetupRun) => SetupRun) {
  await update($, setupRun, change)
}

/** The scan, from this run or taken now. */
async function factsOf($: EngineInterface, project: Project) {
  const run = await runOf($)
  if (run.facts !== undefined && run.facts.root === project.root) return run.facts
  const facts = await scanProject($, project)
  await saveRun($, current => ({ ...current, facts }))
  return facts
}

/** Asks one question in godmode's own dialog (D66's way of asking); undefined when nobody could answer. */
async function askQuestion($: EngineInterface, question: Question) {
  try {
    return await $.ui.ask(questionText(question.question), { options: question.choices.map(choice => choice.label), header: question.header, multiSelect: question.multiSelect })
  } catch {
    return undefined
  }
}

/** How many times one question is asked when its answer cannot be used. */
const ASK_TRIES = 3

/** A question asked again, with why the last answer could not be used. */
const askedAgain = (question: Question, problem: string): Question => ({
  ...question,
  // The reason is cut, never the question.
  question: `That answer could not be used: ${problem.length > 150 ? `${problem.slice(0, 147)}...` : problem}. ${question.question}`,
})

/**
 * One answer's values through the answer rules (A) and checked against the world (B): the
 * values to keep, or the first problem. A value that names one of the question's choices
 * was offered by godmode itself, so only a typed or given one is checked against the world.
 */
async function checkedValues($: EngineInterface, root: string, question: Question, raw: Answer, values: Readonly<Record<string, Answer>>, known: Readonly<Record<string, Answer>>) {
  const kept: Record<string, Answer> = {}
  for (const [key, value] of Object.entries(values)) {
    const checked = checkAnswer(key, value)
    if ('problem' in checked) return { problem: checked.problem }
    kept[key] = checked.value
  }
  if (question.multiSelect === true || namesChoice(question, raw)) return { values: kept }
  for (const [key, value] of Object.entries(kept)) {
    const problem = await verifyAnswer($, root, key, value, { ...known, ...kept })
    if (problem !== undefined) return { problem }
  }
  return { values: kept }
}

/**
 * Asks the questions in order, each answer's follow-ups right after it (D69), taking an
 * answer from `given` when the person gave it already. Every answer passes the answer rules
 * and the checks against the world; one that cannot be used is asked again with the reason,
 * up to three times, then left out with a note, never saved as it was. After the first
 * question nobody could answer, the rest are only collected, for the PM to relay. A Jira
 * tracker brings its own questions, read from the board, right after the tracker answer; the
 * board's statuses are then offered for the QA status questions too.
 */
async function askAll($: EngineInterface, root: string, questions: readonly Question[], given: Readonly<Record<string, Answer>>, suggest = (question: Question) => question) {
  const answers: Record<string, Answer> = {}
  const notes: string[] = []
  const unasked: Question[] = []
  const queue = [...questions]
  let board: string[] = []
  const askOne = async (asked: Question, known: Readonly<Record<string, Answer>> = {}) => {
    // A change-setup offers the note's answer first (D22); a setup asks the question as it is.
    let question = suggest(asked)
    let raw: Answer | undefined = given[question.key] ?? (unasked.length === 0 ? await askQuestion($, question) : undefined)
    for (let tries = 1; raw !== undefined; tries += 1) {
      const resolved = resolveAnswer(question, raw)
      const checked = await checkedValues($, root, question, raw, resolved.values, { ...given, ...answers, ...known })
      if ('values' in checked) {
        if (resolved.note !== undefined) notes.push(resolved.note)
        return checked.values
      }
      if (tries >= ASK_TRIES) {
        notes.push(`${question.key} is left unset: ${checked.problem}. \`/godmode setup\` asks it again.`)
        return {}
      }
      question = askedAgain(suggest(asked), checked.problem)
      raw = unasked.length === 0 ? await askQuestion($, question) : undefined
    }
    unasked.push(question)
    return undefined
  }
  for (let question = queue.shift(); question !== undefined; question = queue.shift()) {
    const values = await askOne(withBoardStatuses(question, board))
    if (values === undefined) continue
    Object.assign(answers, values)
    queue.unshift(...(question.followUps?.(answers) ?? []))
    if (question.key === 'tracker' && trackerKindOf(answers.tracker ?? '') === 'jira' && unasked.length === 0) {
      const jira = await jiraSetup($, given, askOne)
      Object.assign(answers, jira.answers)
      notes.push(...jira.notes)
      board = jira.boardStatuses
    }
  }
  return { answers, notes, unasked }
}

/** Where each area's detailed rules live, for the summary: the conventions folder and the files in it. */
const areaFilesOf = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>): AreaFiles => {
  const storage = answers.storage
  const conventionsDir = storage === undefined || storage === 'committed' ? 'docs/conventions' : `${REPO_FOLDER}/conventions`
  const workflow = facts.conventions.find(path => /git-workflow|contributing/i.test(path))
  const rules = typeof answers.ticketRules === 'string' ? answers.ticketRules : undefined
  return {
    conventionsDir,
    ...(facts.conventions.includes('.github/pull_request_template.md') ? { prTemplate: '.github/pull_request_template.md' } : {}),
    gitWorkflow: workflow ?? `${conventionsDir}/git-workflow.md`,
    ...(rules === undefined ? {} : { ticketRules: rules }),
    existing: facts.conventions,
  }
}

/** Logs the summary (D78), one line per call, under its heading. */
function logSummary($: EngineInterface, facts: ScanFacts, working: Readonly<Record<string, Answer>>, sources: Readonly<Record<string, Source>>, heading: string) {
  logLines($, [heading, ...summaryText(summaryLines(facts, working, sources, areaFilesOf(facts, working)))].join('\n'))
}

/** The question that asks each open key ("?") on the summary, in the order setup asks them. */
const openQuestionsOf = (facts: ScanFacts, scope: SetupScope, open: readonly string[], extras: readonly Question[], isFirstRound: boolean): Question[] => {
  const byKey: Record<string, Question> = { mergeApprovals: APPROVALS_QUESTION, qaMode: peopleQaQuestion(facts), attribution: ATTRIBUTION }
  const asked = open.flatMap(key => byKey[key] ?? [])
  if (scope === 'personal') return [...asked.filter(question => question.half === 'personal'), ...extras.filter(question => question.half === 'personal')]
  return isFirstRound ? [...gapQuestions(facts), ...extras, STORAGE, TRACKER, ...asked] : asked
}

/** The questions behind each part of the summary the person can change (D78); labels hold no comma, as a multi-select joins them with commas. */
const changeGroups = (facts: ScanFacts, scope: SetupScope): { label: string; questions: Question[] }[] => {
  const isFull = scope === 'full'
  return [
    { label: 'Who or care', questions: isFull ? [WHO_QUESTION, CARE_QUESTION] : [CARE_QUESTION] },
    { label: 'Merging', questions: isFull ? [APPROVALS_QUESTION, CI_QUESTION, AUTO_MERGE] : [AUTO_MERGE] },
    ...(isFull ? [{ label: 'QA', questions: [peopleQaQuestion(facts), QA_AGENT_QUESTION] }] : []),
    { label: isFull ? 'Tickets and the rest' : 'Attribution', questions: isFull ? [TRACKER, STORAGE, ATTRIBUTION] : [ATTRIBUTION] },
  ]
}

const SAVE = 'Save'
const CHANGE = 'Change something'

/** What the person said to the summary: save it, change some parts by name, or a change typed in their own words. */
type Confirm = { kind: 'save' } | { kind: 'groups'; picked: string[] } | { kind: 'typed'; text: string } | { kind: 'unasked' }

/** Asks the person to confirm the summary, and what to change when they want a change. */
async function askConfirm($: EngineInterface, groups: readonly { label: string }[]): Promise<Confirm> {
  let answer: string
  try {
    answer = await $.ui.ask('Save these settings, or change something first?', { options: [SAVE, CHANGE], header: 'Setup' })
  } catch {
    return { kind: 'unasked' }
  }
  if (answer === SAVE) return { kind: 'save' }
  let picked: string
  try {
    picked = await $.ui.ask('What should change? Pick the parts, or say it under Other.', { options: groups.map(group => group.label), header: 'Change', multiSelect: true })
  } catch {
    return { kind: 'unasked' }
  }
  const parts = picked.split(',').map(part => part.trim()).filter(part => part !== '')
  const named = parts.filter(part => groups.some(group => group.label === part))
  return named.length === parts.length && named.length > 0 ? { kind: 'groups', picked: named } : { kind: 'typed', text: picked }
}

/** How many times the summary may be changed before the setup saves what it has, saying so. */
const CHANGE_ROUNDS = 5

/** The setup stopped because nobody could answer: the questions left, as an outline for the PM to relay. */
const unaskedError = (unasked: readonly Question[], answers: Readonly<Record<string, Answer>>) =>
  new SetupError(
    [
      'godmode could not ask the person (a headless run, or the question was dismissed), so setup stops here. Nothing was written.',
      'Report these questions to the PM, who asks the person and dispatches the setup again with the answers as `given`:',
      ...unasked.flatMap(question => outline(question, answers)),
    ].join('\n'),
  )

/**
 * The setup's questions (D78). The scan already ran and is silent. Two questions come first,
 * Who and Care; with the scan and the live facts they pre-fill every other answer. One summary
 * shows each value and its source, then only the "?" items are asked, one question each, every
 * one with an answer that leaves no rule. The person confirms with "Save" or "Change something".
 * A personal setup (a teammate on a committed note) asks only what is theirs.
 */
async function askSetup($: EngineInterface, project: Project, facts: ScanFacts, scope: SetupScope, extras: readonly Question[], given: Readonly<Record<string, Answer>>) {
  const team = scope === 'personal' ? await teamAnswersOf($, project) : {}
  const known: Record<string, Answer> = { ...given }
  delete known.confirmed
  // The person's answers, each read through its question: asked, or given and resolved.
  const person: Record<string, Answer> = {}
  const notes: string[] = []
  const ask = async (questions: readonly Question[], known: Readonly<Record<string, Answer>>, suggest?: (question: Question) => Question) => {
    const round = await askAll($, project.root, questions, known, suggest)
    notes.push(...round.notes)
    if (round.unasked.length > 0) throw unaskedError(round.unasked, { ...team, ...person, ...round.answers })
    // Answers given as working keys are read as the person's too.
    for (const [key, value] of Object.entries(round.answers)) person[key] = value
  }
  await ask(scope === 'personal' ? [CARE_QUESTION] : [WHO_QUESTION, CARE_QUESTION], known)
  const live = await liveFactsOf($, facts).catch(() => NO_LIVE_FACTS)
  const settle = () => {
    const pre = prefill(facts, live, { ...team, ...person })
    const sources: Record<string, Source> = { ...pre.sources }
    for (const key of Object.keys(person)) sources[key] = 'you'
    for (const key of pre.open) if (!(key in person)) sources[key] = '?'
    if (scope === 'full') for (const key of [...gapQuestions(facts).map(question => question.key), 'storage', 'tracker']) if (!(key in person)) sources[key] = '?'
    return { working: { ...team, ...pre.values, ...person }, sources, open: pre.open.filter(key => !(key in person)) }
  }
  let state = settle()
  logSummary($, facts, state.working, state.sources, 'godmode found this, and your two answers pre-fill the rest. Each "?" is asked next:')
  await ask(openQuestionsOf(facts, scope, state.open, extras, true), known)
  // An answer given for an item the scan settled wins over the scan, read through its own question.
  Object.assign(person, leftoverGiven(facts, extras, known, person))
  state = settle()
  const groups = changeGroups(facts, scope)
  for (let round = 0; given.confirmed !== true && given.confirmed !== 'yes'; round += 1) {
    if (round >= CHANGE_ROUNDS) {
      notes.push('The summary was changed several times; the last version is saved, and `/godmode setup` changes it later.')
      break
    }
    logSummary($, facts, state.working, state.sources, 'godmode setup: what it will save.')
    const answer = await askConfirm($, groups)
    if (answer.kind === 'save') break
    if (answer.kind === 'unasked') {
      throw new SetupError(
        [
          'godmode could not ask the person to confirm the summary (a headless run, or the question was dismissed). Nothing was written.',
          'Report this summary to the PM, who shows it to the person and, on their yes, dispatches the setup again with these answers and `confirmed: true` as `given`:',
          ...summaryText(summaryLines(facts, state.working, state.sources, areaFilesOf(facts, state.working))),
          `given: ${JSON.stringify(person)}`,
        ].join('\n'),
      )
    }
    if (answer.kind === 'typed') {
      await saveRun($, run => ({ ...run, answers: mergeAnswers(run.answers ?? {}, toNoteAnswers(person)) }))
      throw new SetupError(
        [
          `The person wants this changed before saving: "${answer.text}". Nothing was written.`,
          `Report it to the PM, who works out the answers it means and dispatches the setup again with them over these as \`given\`: ${JSON.stringify(person)}`,
        ].join('\n'),
      )
    }
    const suggestions = suggestionsOf(state.working)
    const asked = groups.filter(group => answer.picked.includes(group.label)).flatMap(group => group.questions)
    for (const question of asked) delete person[question.key]
    await ask(asked, {}, question => withSuggestion(question, suggestions))
    state = settle()
    await ask(openQuestionsOf(facts, scope, state.open, extras, false), person)
    state = settle()
  }
  const composed = toNoteAnswers(state.working)
  const answers = scope === 'personal' ? Object.fromEntries(Object.entries(composed).filter(([key]) => isPersonalKey(key))) : composed
  return { answers, notes }
}

/**
 * The given answers no question asked this run: each read through its own question where it
 * has one (`"No attribution"` is false), else kept as given (a setting with no question).
 */
const leftoverGiven = (facts: ScanFacts, extras: readonly Question[], known: Readonly<Record<string, Answer>>, person: Readonly<Record<string, Answer>>) => {
  const questions = [WHO_QUESTION, CARE_QUESTION, APPROVALS_QUESTION, CI_QUESTION, AUTO_MERGE, peopleQaQuestion(facts), QA_AGENT_QUESTION, TRACKER, STORAGE, ATTRIBUTION, ...gapQuestions(facts), ...extras]
  const out: Record<string, Answer> = {}
  for (const [key, value] of Object.entries(known)) {
    if (key in person) continue
    const question = questions.find(candidate => candidate.key === key)
    const resolved = question === undefined ? { [key]: value } : resolveAnswer(question, value).values
    for (const [name, raw] of Object.entries(resolved)) {
      const checked = checkAnswer(name, raw)
      if ('value' in checked) out[name] = checked.value
    }
  }
  return out
}

/** The team's answers on a committed note, for a teammate's personal setup. */
async function teamAnswersOf($: EngineInterface, project: Project): Promise<Record<string, Answer>> {
  const found = await readNote($, project).catch(() => undefined)
  return found?.status === 'found' ? { ...found.shared.answers } : {}
}

/** Starts a setup run: clears what an earlier one left. The PM is told to dispatch the setup agent. */
export async function beginSetup($: EngineInterface, scope: SetupScope) {
  await update($, setupRun, () => ({ consented: [], written: [] }))
  await update($, setupReport, () => '')
  const what =
    scope === 'personal'
      ? 'This project\'s team setup is committed already, so only your own answers are missing (merging, approvals, attribution, the on-indicator).'
      : 'A setup agent scans the project, then asks you a few multiple-choice questions and sets up its conventions.'
  return {
    text: `godmode is setting up this project. ${what}`,
    context: [
      [
        `godmode is on in setup mode (scope: ${scope}). The project has no finished setup note yet, so the loop cannot start.`,
        `Dispatch the setup now, in the background, without being asked: one Agent call with subagent_type \`godmode:setup\`, description "godmode setup", and the prompt "Set up godmode for this project. Scope: ${scope}." godmode runs it on Opus, its floor.`,
        'Do not scan, read or write anything for the setup yourself: the setup agent does it in its own context, and asks the person its questions through godmode\'s own dialog.',
        'When it reports, relay the outcome to the person in one or two lines. If it says it could not ask (a headless run, or a dismissed question), ask the person those questions here in plain words, then dispatch `godmode:setup` again with their answers in the prompt, to pass as `given`.',
      ].join('\n'),
    ],
  }
}

/** No git (D54): godmode offers `git init` and runs it only on the person's yes. Resolves whether it ran. */
export async function offerGitInit($: EngineInterface, folder: string) {
  let answer: string
  try {
    answer = await $.ui.ask(
      `godmode needs git (branches, worktrees, PRs), and ${folder} is not a git repository. Run \`git init\` here?`,
      { options: ['Run git init', 'Not now'], header: 'git' },
    )
  } catch {
    return false
  }
  if (answer !== 'Run git init') return false
  const result = await $.process.run(['git', 'init'], { cwd: folder }).catch(() => undefined)
  return result?.exitCode === 0
}

// ---------------------------------------------------------------------------
// The tools

/** `setup_scan`: the facts, the templates on offer, and what the questionnaire will ask. */
export async function setupScan($: EngineInterface) {
  const project = await projectOf($)
  const facts = await scanProject($, project)
  await saveRun($, current => ({ ...current, facts }))
  const scope = await read($, setupScope)
  const templates = await listTemplates($)
  const presetFolders = presetFoldersFor(facts.stacks, Object.keys(templates.presets))
  const found = scope === 'personal' ? await readNote($, project).catch(() => undefined) : undefined
  const report = {
    scope,
    facts,
    templates: {
      required: templates.required.map(file => file.name),
      optional: templates.optional.map(file => file.name),
      presets: Object.fromEntries(Object.entries(templates.presets).map(([folder, files]) => [folder, files.map(file => file.name)])),
      presetsForThisProject: presetFolders,
      folder: `${$.plugin.root}/templates`,
    },
    questionnaire: questionsFor(facts, scope).map(question => question.key),
    teamNote: found?.status === 'found' ? { answers: found.shared.answers, conventions: found.shared.conventions.map(file => file.path) } : undefined,
  }
  return `godmode setup scan of ${project.root}. Read the existing conventions files it lists before judging them.\n${JSON.stringify(report, null, 2)}`
}

/** `setup_questionnaire`: asks each question in turn; stops at the first that cannot be asked. */
export async function setupQuestionnaire($: EngineInterface, input: Record<string, unknown>) {
  if ((await read($, mode)) === 'change-setup') return changeQuestionnaire($, input)
  const project = await projectOf($)
  const facts = await factsOf($, project)
  const scope = await read($, setupScope)
  const extras: Question[] = []
  const rawExtras = input.extra ?? []
  if (!Array.isArray(rawExtras)) throw new SetupError('`extra` must be a list of questions.')
  for (const raw of rawExtras) {
    if (!isRecord(raw)) throw new SetupError('Each extra question is an object with key, question and options.')
    const question = extraQuestion({
      key: String(raw.key ?? ''),
      question: String(raw.question ?? ''),
      options: Array.isArray(raw.options) ? raw.options.map(String) : [],
      header: typeof raw.header === 'string' ? raw.header : undefined,
    } satisfies ExtraQuestion)
    if (typeof question === 'string') throw new SetupError(question)
    extras.push(question)
  }
  // A teammate on a team's Jira picks their own Atlassian server when several are connected.
  if (scope === 'personal') {
    const found = await readNote($, project).catch(() => undefined)
    if (found?.status === 'found' && trackerKindOf(found.shared.answers.tracker ?? '') === 'jira') extras.push(...(await personalJiraQuestions($)))
  }
  const { answers, notes } = await askSetup($, project, facts, scope, extras, answersIn(input.given, 'given'))
  await saveRun($, current => ({ ...current, answers: mergeAnswers(current.answers ?? {}, answers) }))
  const shown = Object.entries(answers).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
  return ['The person confirmed:', ...shown, ...notes.map(note => `Note: ${note}`)].join('\n')
}

/** `setup_confirm`: the person's yes before weak conventions are improved in place (D32). */
export async function setupConfirm($: EngineInterface, input: Record<string, unknown>) {
  const change = typeof input.change === 'string' ? input.change.trim() : ''
  const why = typeof input.why === 'string' ? input.why.trim() : ''
  if (change === '' || why === '') throw new SetupError('`change` and `why` are both required, a line or two each.')
  const project = await projectOf($)
  const facts = await factsOf($, project)
  const files = (stringsIn(input.files, 'files') ?? facts.conventions).map(path => absoluteIn(project, path))
  let answer: string
  try {
    answer = await $.ui.ask(questionText(`Improve your existing conventions in place? ${change} Why: ${why}`), {
      options: ['Yes, improve them', 'No, keep them'],
      header: 'Conventions',
    })
  } catch {
    throw new SetupError('godmode could not ask the person (a headless run, or the question was dismissed). Adopt the conventions as they are, and report the change you would make to the PM.')
  }
  if (answer !== 'Yes, improve them') {
    return 'The person said no: adopt the existing conventions as they are. Fill only missing required pieces, in new files (setup_write_preset with `pieces`).'
  }
  await saveRun($, current => ({ ...current, consented: [...new Set([...current.consented, ...files])] }))
  return `The person said yes: you may now edit ${files.map(path => notePath(project, path)).join(', ')} in place, as described and no further.`
}

/** `setup_write_preset`: writes templates where the storage answer says; never overwrites (D3, D30, D31). */
export async function setupWritePreset($: EngineInterface, input: Record<string, unknown>) {
  if ((await read($, setupScope)) === 'personal') {
    throw new SetupError('This is a personal setup on a committed note: the team\'s conventions are written already. Nothing to write.')
  }
  const run = await runOf($)
  const storage = run.answers?.storage
  if (!STORAGE_MODES.includes(storage as StorageMode)) {
    throw new SetupError('Run setup_questionnaire first: the storage answer says where the conventions go.')
  }
  const mode = storage as StorageMode
  const project = await projectOf($)
  const facts = await factsOf($, project)
  const dir = conventionsDirOf(project, mode, await claudeDirOf($))
  if (dir === undefined) throw new SetupError('No home folder to keep the conventions outside the repo. Choose another storage.')
  const templates = await listTemplates($)
  if (templates.required.length === 0) throw new SetupError(`godmode ships no required templates at ${$.plugin.root}/templates/required, so there is nothing to write.`)

  const pick = (wanted: string[] | undefined, from: TemplateFile[], kind: string) => {
    if (wanted === undefined) return from
    const unknown = wanted.filter(name => !from.some(file => file.name === name))
    if (unknown.length > 0) throw new SetupError(`No ${kind} template named ${unknown.join(', ')}. The ${kind} templates are: ${from.map(file => file.name).join(', ') || 'none'}.`)
    return from.filter(file => wanted.includes(file.name))
  }
  const pieces = stringsIn(input.pieces, 'pieces')
  const required = pick(pieces, templates.required, 'required')
  const optional = pick(stringsIn(input.optional, 'optional') ?? [], templates.optional, 'optional')
  const askedStack = typeof input.stack === 'string' ? input.stack.trim() : undefined
  if (askedStack !== undefined && askedStack !== 'none' && templates.presets[askedStack] === undefined) {
    throw new SetupError(`No preset folder \`${askedStack}\`. The preset folders are: ${Object.keys(templates.presets).join(', ') || 'none'}.`)
  }
  const stacks = askedStack === 'none' ? [] : askedStack !== undefined ? [askedStack] : presetFoldersFor(facts.stacks, Object.keys(templates.presets))

  const answers = run.answers ?? {}
  const values = templateValues(facts, answers, { conventionsDir: notePath(project, dir), date: new Date(await $.clock.now()).toISOString().slice(0, 10) })
  // Each stack's notes go into the templates through their placeholders, one block per stack.
  const notes = new Map<string, string[]>()
  for (const stack of stacks) {
    for (const file of templates.presets[stack] ?? []) {
      const key = notesKey(file.name)
      const body = (await $.fs.read(file.path)).trim()
      notes.set(key, [...(notes.get(key) ?? []), stacks.length > 1 ? `**${stack}**\n\n${body}` : body])
    }
  }
  for (const [key, blocks] of notes) values[key] = blocks.join('\n\n')
  const isGitHub = isGitHubHost(facts, answers)
  const jobs = [
    ...required.map(file => ({ file, kind: 'required', target: presetTarget(project, mode, dir, file.name, isGitHub) })),
    ...optional.map(file => ({ file, kind: 'optional', target: presetTarget(project, mode, dir, file.name, isGitHub) })),
  ]
  if (mode === 'gitignored') await ensureExcluded($, project, gitignoreLines(mode))
  const lines: string[] = []
  const written: SetupRun['written'] = []
  for (const job of jobs) {
    const shown = notePath(project, job.target)
    if (await $.fs.exists(job.target)) {
      lines.push(`- kept ${shown} (it exists; read it and adapt it by hand if needed)`)
      continue
    }
    await $.fs.write(job.target, fillTemplate(await $.fs.read(job.file.path), values))
    written.push({ template: `${job.kind}/${job.file.name}`, path: job.target })
    lines.push(`- wrote ${shown} from ${job.kind}/${job.file.name}`)
  }
  if (stacks.length > 0) lines.push(`Stack notes from presets/${stacks.join(', presets/')} went into ${[...notes.keys()].map(key => `{{${key}}}`).join(' and ')}.`)
  await saveRun($, current => ({ ...current, written: [...current.written.filter(entry => !written.some(next => next.path === entry.path)), ...written] }))
  return [
    `Conventions in ${notePath(project, dir)} (${mode} storage):`,
    ...lines,
    'Read each written file and fill any `{{placeholder}}` left in it from what you know of the project.',
  ].join('\n')
}

/** The answers the note records, split into its two halves (D61). Precedence: scan, then the agent's, then the person's. */
export const noteAnswers = (facts: ScanFacts, agent: Readonly<Record<string, Answer>>, person: Readonly<Record<string, Answer>>) => {
  const scanned: Record<string, Answer> = {}
  const main = facts.stacks[0]
  if (main !== undefined) scanned.stack = main.language
  for (const key of COMMAND_KEYS) {
    const value = facts.commands[key]
    if (value !== undefined) scanned[commandKey(key)] = value
  }
  if (facts.git.baseBranch !== undefined) scanned.baseBranch = facts.git.baseBranch
  const all: Record<string, Answer> = { ...scanned, ...agent, ...person }
  const shared: Record<string, Answer> = {}
  const personal: Record<string, Answer> = {}
  for (const [key, value] of Object.entries(all)) {
    if (UNRECORDED_KEYS.includes(key)) continue
    // An empty answer ("No tests yet", "Decide later") records nothing.
    if (value === '') continue
    if (isPersonalKey(key)) personal[key] = value
    else shared[key] = value
  }
  return { shared, personal }
}

/**
 * Settings passed straight to `setup_finish` (`answers`), through the answer rules: a value
 * that cannot be used refuses the finish with the reason, so nothing unusable is saved.
 */
const checkedSettings = (settings: Readonly<Record<string, Answer>>) => {
  const kept: Record<string, Answer> = {}
  const problems: string[] = []
  for (const [key, value] of Object.entries(settings)) {
    const checked = checkAnswer(key, value)
    if ('problem' in checked) problems.push(`- ${key}: ${checked.problem}`)
    else kept[key] = checked.value
  }
  if (problems.length > 0) throw new SetupError(['These settings cannot be used, so nothing was saved:', ...problems, 'Correct each one, or leave it out, and call setup_finish again.'].join('\n'))
  return kept
}

/**
 * The answers checked against the world before they are saved (B): a problem refuses the
 * save, saying which answer and why, and how it is asked again; warnings go in the report.
 */
async function verifiedOrRefused($: EngineInterface, root: string, answers: Readonly<Record<string, Answer>>, again: string, keys?: ReadonlySet<string>) {
  const { problems, warnings } = await verifyAnswers($, root, answers, keys)
  if (problems.length === 0) return warnings
  throw new SetupError(
    ['These answers do not hold up, so nothing was saved:', ...problems.map(finding => `- ${finding.key} ${JSON.stringify(answers[finding.key])}: ${finding.problem}`), again].join('\n'),
  )
}

/** Writes the rules file from the answers, keeping the person's own section of the file it replaces. */
async function writeProjectRules($: EngineInterface, path: string, answers: Readonly<Record<string, Answer>>, files: AreaFiles) {
  const old = await $.fs.read(path).catch(() => undefined)
  await $.fs.write(path, projectRulesText(answers, files, ownRulesIn(old)))
}

/** The answers a note holds, as one line per half, for a report built from what was saved. */
const savedLine = (label: string, answers: Readonly<Record<string, Answer>>) =>
  `${label}: ${Object.entries(answers).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(', ') || 'none'}.`

/** The note as saved, read back, so the report says what is on disk and not what was meant to be. */
async function savedNote($: EngineInterface, project: Project) {
  const found = await readNote($, project).catch(() => undefined)
  if (found?.status !== 'found') throw new SetupError('godmode wrote the note but could not read it back. Run `/godmode` to check it.')
  return found
}

/** Switches to coding mode after a setup, and leaves the PM its one report. */
async function finishInto($: EngineInterface, report: string, personal: Readonly<Record<string, Answer>>, isChange = false) {
  // A change-setup re-checks no conventions, so the edits seen at switch-on stay listed.
  if (!isChange) await update($, recheck, () => [])
  await update($, setupScope, () => 'full')
  await update($, indicator, () => indicatorOf(personal.indicator))
  await update($, setupReport, () => report)
  await update($, mode, () => 'coding')
  // The side pane, when it is the person's indicator, opens now that the setup says so.
  await openGodmodePane($).catch(() => undefined)
  $.ui.toast(isChange ? 'godmode setup change is done: coding mode.' : 'godmode setup is done: coding mode.')
}

/** `setup_finish`: checks the required pieces (D31), writes the note (D20), switches to coding mode. */
export async function setupFinish($: EngineInterface, input: Record<string, unknown>) {
  if ((await read($, mode)) === 'change-setup') return changeFinish($, input)
  const run = await runOf($)
  if (run.answers === undefined) throw new SetupError('Run setup_questionnaire first: the note records the person\'s answers.')
  const project = await projectOf($)
  const facts = await factsOf($, project)
  const scope = await read($, setupScope)
  const agentAnswers = checkedSettings(answersIn(input.answers, 'answers'))
  const { shared, personal } = noteAnswers(facts, agentAnswers, run.answers)
  const again = 'Correct a setting you passed in `answers`, or leave it out; for a question\'s answer, call setup_questionnaire again with the other answers as `given` and that one left out, so the person is asked it again. Then call setup_finish again.'
  const warnings = await verifiedOrRefused($, project.root, { ...shared, ...personal }, again)

  if (scope === 'personal') {
    const found = await readNote($, project)
    if (found.status !== 'found') throw new SetupError('The team\'s committed note is gone, so this is no longer a personal setup. Run `/godmode` again for a full setup.')
    const path = await writePersonalNote($, found.dir, personal)
    const saved = await savedNote($, project)
    const report = [
      `godmode: your personal setup is done (${notePath(project, path)}). godmode is now in coding mode, and you are the PM.`,
      savedLine('Saved for you', saved.personal?.answers ?? {}),
      qaModeLine(found.shared.answers),
      ...warnings,
    ].join('\n')
    await finishInto($, report, personal)
    return `${report}\nStop here and report this in one or two lines.`
  }

  const storage = run.answers.storage
  if (!STORAGE_MODES.includes(storage as StorageMode)) throw new SetupError('The questionnaire has no storage answer. Run setup_questionnaire again.')
  const templates = await listTemplates($)
  const covered = answersIn(input.covered, 'covered')
  const coveredPaths: string[] = []
  const missing: string[] = []
  for (const file of templates.required) {
    const wrote = run.written.find(entry => entry.template === `required/${file.name}`)
    if (wrote !== undefined && (await $.fs.exists(wrote.path))) continue
    const cover = covered[file.name]
    if (typeof cover === 'string' && cover.trim() !== '' && (await $.fs.exists(absoluteIn(project, cover.trim())))) {
      coveredPaths.push(cover.trim())
      continue
    }
    missing.push(file.name)
  }
  if (missing.length > 0) {
    throw new SetupError(
      `Required pieces are missing (D31): ${missing.join(', ')}. Write them with setup_write_preset (\`pieces\`), or name the existing file that covers each in \`covered\`. Nothing was written.`,
    )
  }
  const listed = stringsIn(input.conventions, 'conventions') ?? facts.conventions
  // The plain-language rules file (D78), written from the answers into the conventions folder.
  const rulesDir = conventionsDirOf(project, storage as StorageMode, await claudeDirOf($))
  const rulesPath = rulesDir === undefined ? undefined : `${rulesDir}/${PROJECT_RULES_FILE}`
  if (rulesPath !== undefined) {
    const written = (template: string) => run.written.find(entry => entry.template === `required/${template}`)?.path
    const coveredBy = (template: string) => (typeof covered[template] === 'string' ? String(covered[template]) : undefined)
    const shown = (path: string | undefined) => (path === undefined ? undefined : notePath(project, absoluteIn(project, path)))
    const prTemplate = shown(written('pr-template.md') ?? coveredBy('pr-template.md') ?? facts.conventions.find(path => /pull_request_template/i.test(path)))
    const gitWorkflow = shown(written('git-workflow.md') ?? coveredBy('git-workflow.md'))
    const files: AreaFiles = {
      conventionsDir: notePath(project, rulesDir ?? ''),
      ...(prTemplate === undefined ? {} : { prTemplate }),
      ...(gitWorkflow === undefined ? {} : { gitWorkflow }),
      ...(typeof shared.ticketRules === 'string' ? { ticketRules: shared.ticketRules } : {}),
      existing: facts.conventions,
    }
    await writeProjectRules($, rulesPath, { ...shared, ...personal }, files)
  }
  const conventions = [
    ...new Set([...listed, ...coveredPaths, ...run.written.map(entry => entry.path), ...(rulesPath === undefined ? [] : [rulesPath])].map(path => notePath(project, absoluteIn(project, path)))),
  ]
  const dir = await writeNote(
    $,
    { storage: storage as StorageMode, sharedAnswers: shared, minimumModels: {}, conventions, personalAnswers: personal, models: {} },
    project,
  )
  // The report quotes the note as read back from disk, so it never claims a value that was not saved.
  const saved = await savedNote($, project)
  const report = [
    `godmode: setup is done. The note is in ${notePath(project, dir)} (${String(storage)} storage).`,
    `Conventions the loop follows: ${conventions.join(', ') || 'none'}.`,
    savedLine('Saved for the team', saved.shared.answers),
    savedLine('Saved for you', saved.personal?.answers ?? {}),
    qaModeLine(saved.shared.answers),
    ...warnings,
    'godmode is now in coding mode, and you are the PM.',
  ].join('\n')
  await finishInto($, report, personal)
  return `${report}\nStop here and report this to the PM in a few lines, quoting the saved values above as they are.`
}

// ---------------------------------------------------------------------------
// Change-setup mode (Step 11; D21, D22, D60): the same two tools, on a project with a note

type FoundNote = Extract<NoteLookup, { status: 'found' }>

const answersOfNote = (found: FoundNote) => ({ ...found.shared.answers, ...(found.personal?.answers ?? {}) })

/** Each half of a note as it was saved, before the answer rules repaired or left out a value. */
const savedHalves = (found: FoundNote) => ({
  shared: savedAnswers(found.shared.answers, found.repairs ?? [], found.issues ?? [], 'shared'),
  personal: savedAnswers(found.personal?.answers ?? {}, found.repairs ?? [], found.issues ?? [], 'personal'),
})

/** The note a change-setup changes; a refusal when there is none to change. */
async function noteToChange($: EngineInterface, project: Project) {
  const found = await readNote($, project)
  if (found.status !== 'found') throw new SetupError('This project has no readable setup note to change. `/godmode off`, then `/godmode`, runs a full setup.')
  return found
}

/**
 * `/godmode setup` (D21, D22): change-setup mode on a project with a note, with its one line
 * about the note's version (D60) and the PM's brief. With no readable note there is nothing
 * to change, so a full setup starts instead. `toolsLine` is the switch-on's own line, if any.
 */
export async function beginChangeSetup($: EngineInterface, found: NoteLookup | undefined, toolsLine?: string) {
  await update($, setupRun, () => ({ consented: [], written: [] }))
  if (found?.status !== 'found') {
    await update($, setupScope, () => 'full')
    await update($, mode, () => 'setup')
    const setup = await beginSetup($, 'full')
    const lines = ['This project has no godmode setup to change yet, so a full setup runs.', setup.text, toolsLine]
    return { text: lines.filter(line => line !== undefined).join('\n'), context: setup.context }
  }
  const noteVersion = found.shared.godmodeVersion
  const version = await godmodeVersionOf($).catch(() => noteVersion)
  const answers = answersOfNote(found)
  const pending = pendingUpdates(noteVersion, version, answers)
  const lines = ['godmode is in change-setup mode: say what you want to change.', updateOfferLine(noteVersion, version, pending), toolsLine]
  const brief = changeSetupBrief({ noteVersion, version, storage: found.shared.storage, dir: notePath(found.project, found.dir), answers, pending })
  const flagged = answerIssueLines(found.repairs ?? [], found.issues ?? [])
  const fix = flagged.length === 0 ? [] : [`${flagged.join(' ')} The \`check\` topic saves the repairs and asks again what cannot be used.`]
  return { text: lines.filter(line => line !== undefined).join('\n'), context: [[brief, ...fix].join('\n')] }
}

/**
 * `/godmode audit` (D75): the report, read-only. With nothing to fix it is one line and the
 * mode stays as it was; otherwise godmode goes to change-setup mode, so the fixes the person
 * picks go through setup_questionnaire and setup_finish and are saved only on their yes.
 */
export async function runAudit($: EngineInterface, found: FoundNote, switchToChange: () => Promise<string | undefined>) {
  const report = await auditNote($, found.project, found)
  const text = auditText(report, notePath(found.project, found.dir))
  if (report.issues.length === 0 && report.suggestions.length === 0) return { text }
  const toolsLine = await switchToChange()
  const change = await beginChangeSetup($, found, toolsLine)
  return { text: [text, toolsLine].filter(line => line !== undefined).join('\n'), context: [...change.context, auditBrief(report)] }
}

/** Asks whether to answer the questions new since the note's version (D60); `unasked` when nobody could answer. */
async function offerUpdate($: EngineInterface, noteVersion: string, version: string, whats: readonly string[]): Promise<'yes' | 'no' | 'unasked'> {
  try {
    const answer = await $.ui.ask(questionText(`godmode ${version} asks something new since this project's setup (${noteVersion}): ${whats.join('; ')}. Answer it now? Nothing changes until you do.`), {
      options: ['Answer now', 'Not now'],
      header: 'Update',
    })
    return answer === 'Answer now' ? 'yes' : 'no'
  } catch {
    return 'unasked'
  }
}

const BACK_TO_CODING = 'godmode is back in coding mode, and you are the PM.'

/**
 * Ends change-setup mode, whatever ended it: a save, a discard, a "Not now", nothing to ask
 * or save, or a question nobody could answer. Coding mode's gates hold again, and the PM's
 * report waits for its next prompt.
 */
async function endChangeSetup($: EngineInterface, found: FoundNote, report: string, personal: Readonly<Record<string, Answer>> = found.personal?.answers ?? {}) {
  await saveRun($, run => ({ ...run, change: undefined }))
  await finishInto($, report, personal, true)
}

/** Ends change-setup mode with nothing saved; resolves the tool's answer. */
async function changeEndedUnsaved($: EngineInterface, found: FoundNote, why: string) {
  const report = `godmode: ${why} ${BACK_TO_CODING}`
  await endChangeSetup($, found, report)
  return `${report}\nTell the person this in a line.`
}

/** `/godmode` typed in change-setup mode: the change ends unsaved, back in coding mode. Resolves the line to show. */
export async function leaveChangeSetup($: EngineInterface) {
  await saveRun($, run => ({ ...run, change: undefined }))
  await update($, setupScope, () => 'full')
  await update($, mode, () => 'coding')
  return 'godmode left change-setup mode with nothing saved: back in coding mode.'
}

/**
 * `setup_questionnaire` in change-setup mode: only the named topics and the questions they
 * lead to, the note's answers offered first. Nothing is saved: `setup_finish` does that.
 */
async function changeQuestionnaire($: EngineInterface, input: Record<string, unknown>) {
  const project = await projectOf($)
  const found = await noteToChange($, project)
  const requested = stringsIn(input.change, 'change') ?? []
  if (requested.length === 0) {
    throw new SetupError(`Say what changes in \`change\`, as topics: ${TOPIC_HELP}. A setting with no question of its own goes in setup_finish's \`answers\`.`)
  }
  const current = answersOfNote(found)
  const noteVersion = found.shared.godmodeVersion
  const version = await godmodeVersionOf($)
  const pending = pendingUpdates(noteVersion, version, current)
  const check = requested.includes('check') ? await checkNote($, project, found) : undefined
  let topics = [...new Set([...requested.filter(topic => topic !== 'check'), ...(check?.topics ?? [])])]
  if (check !== undefined && topics.length === 0) {
    if (!check.isRepaired) return changeEndedUnsaved($, found, `the setup checks out: ${check.lines.join(' ') || 'every saved answer holds'}`)
    await saveRun($, run => ({ ...run, change: { topics: [], dropped: [], answers: {}, isUpdate: false } }))
    return [...check.lines, 'Nothing is saved yet. Call setup_finish: it shows the person the repaired values and saves them only on their yes.'].join('\n')
  }
  if (topics.includes('update') && pending.length > 0) {
    const offered = await offerUpdate($, noteVersion, version, pending.map(entry => entry.what))
    if (offered === 'unasked') {
      await endChangeSetup($, found, `godmode: the setup change ended, as nobody could answer whether to take the new questions. Nothing changed. ${BACK_TO_CODING}`)
      throw new SetupError(`godmode could not ask the person whether to answer the new questions (a headless run, or the question was dismissed). Nothing changed. ${BACK_TO_CODING} \`/godmode setup\` offers the new questions again.`)
    }
    if (offered === 'no') topics = topics.filter(topic => topic !== 'update')
    if (topics.length === 0) return changeEndedUnsaved($, found, 'the person said not now to the new questions, so nothing changed. `/godmode setup` offers them again.')
  }
  // The ticket-filing rules are learned through ticket_rules, which asks and saves on its own (D74).
  const wantsTickets = topics.includes('tickets') || (topics.includes('update') && pending.some(entry => entry.topic === 'tickets'))
  const others = pending.filter(entry => entry.topic !== 'tickets')
  topics = topics.filter(topic => topic !== 'tickets')
  const isUpdate = topics.includes('update')
  if (wantsTickets && topics.every(topic => topic === 'update') && others.length === 0) {
    await saveRun($, run => ({ ...run, change: { topics: [], dropped: [], answers: {}, isUpdate } }))
    return TICKETS_LINE
  }
  const plan = changePlan(await factsOf($, project), topics, current, others.map(entry => entry.topic))
  if (typeof plan === 'string') throw new SetupError(plan)
  if (plan.questions.length === 0) {
    if (!isOlderVersion(noteVersion, version)) return changeEndedUnsaved($, found, `this project's setup is up to date with godmode ${version}: nothing new to ask, and nothing changed.`)
    await saveRun($, run => ({ ...run, change: { topics: [], dropped: [], answers: {}, isUpdate: true } }))
    return `godmode ${version} asks nothing new since this project's setup (${noteVersion}). setup_finish records the setup as up to date with ${version}, once the person says yes.`
  }
  const suggestions = suggestionsOf(current)
  const given = { ...plan.given, ...answersIn(input.given, 'given') }
  const asked = await askAll($, project.root, plan.questions, given, question => withSuggestion(question, suggestions))
  const { notes, unasked } = asked
  const answers = changedAnswers(current, plan.topics, asked.answers)
  if (unasked.length > 0) {
    throw new SetupError(
      [
        'godmode could not ask the person (a headless run, or the question was dismissed). Nothing was saved.',
        `Ask the person these questions in plain words, then call setup_questionnaire again with the same \`change\` and their answers as \`given\`:`,
        ...unasked.flatMap(question => outline(question, answers)),
      ].join('\n'),
    )
  }
  // Staying on Jira, a Jira answer the round could not settle (no server connected, a site left for later) keeps its old value.
  const staysOnJira = answers.tracker === 'jira' && current.tracker === 'jira'
  const dropped = [
    ...(staysOnJira ? plan.dropped.filter(key => !JIRA_KEYS.includes(key) || key in answers) : plan.dropped),
    ...(plan.topics.includes('start') ? MIGRATED_AWAY : []),
  ]
  // A round after "Change something" adds to the one before it, until setup_finish saves both.
  await saveRun($, run => {
    const before = run.change
    if (before === undefined) return { ...run, change: { topics: plan.topics, dropped, answers, isUpdate } }
    return {
      ...run,
      change: {
        topics: [...new Set([...before.topics, ...plan.topics])],
        dropped: [...new Set([...before.dropped, ...dropped])],
        answers: { ...before.answers, ...answers },
        isUpdate: before.isUpdate || isUpdate,
      },
    }
  })
  const shown = Object.entries(answers).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
  return [
    ...(check?.lines ?? []),
    'The person answered:',
    ...shown,
    ...notes.map(note => `Note: ${note}`),
    'Nothing is saved yet. Call setup_finish: it shows the person every change and saves only on their yes.',
    ...(wantsTickets ? [TICKETS_LINE] : []),
  ].join('\n')
}

/**
 * A change round's answers in the note's keys (D78): Who and Care from a note before them bring
 * its old answers mapped onto the merge conditions, and the merging and QA questions' working
 * answers become the conditions list and the QA mode, over the note's own values.
 */
const changedAnswers = (current: Readonly<Record<string, Answer>>, topics: readonly string[], round: Readonly<Record<string, Answer>>) => {
  const migrated = topics.includes('start') ? migratedAnswers(current) : {}
  const isWorking = Object.keys(round).some(key => WORKING_KEYS.includes(key) || key === 'qaMode')
  if (!isWorking) return { ...migrated, ...round }
  return toNoteAnswers({ ...workingAnswersOf(current), ...migrated, ...round })
}

/** What the PM is told for the `tickets` topic: ticket_rules asks the person and saves on their yes. */
const TICKETS_LINE =
  'For the ticket-filing rules, call mcp__godmode__ticket_rules with no arguments: it asks the person to scan the board and confirm, or to explain the flow, and saves the rules on their yes. Then call setup_finish to end the change.'

/**
 * `/godmode setup`'s `check` topic: the note's answers as the rules read them, then checked
 * against the world. Resolves the topics to ask again (an answer the rules cannot use, or
 * one that does not hold), whether the rules repaired any value (saved by setup_finish), and
 * the lines that say so; a free setting that does not hold is for the PM to correct.
 */
async function checkNote($: EngineInterface, project: Project, found: FoundNote) {
  const { repairs, findings, warnings } = await answerFindings($, project, found)
  const topics = [...new Set(findings.flatMap(entry => entry.topic ?? []))]
  const lines = [
    ...answerIssueLines(repairs, []),
    ...findings.map(entry =>
      entry.topic === undefined
        ? `${entry.key} does not hold (${entry.problem}): pass the right value in setup_finish's \`answers\`, after asking the person if you do not know it.`
        : `${entry.key} does not hold (${entry.problem}): its question is asked again.`,
    ),
    ...warnings,
  ]
  return { topics, isRepaired: repairs.length > 0, lines }
}

/** The conventions entries with each named file's fingerprint taken again, or added; the rest kept as they were. */
async function recheckedConventions($: EngineInterface, project: Project, kept: SharedNote['conventions'], edited: readonly string[]) {
  const conventions = [...kept]
  for (const path of edited) {
    const relative = notePath(project, absoluteIn(project, path))
    const print = await fingerprintOf($, project, relative)
    if (print === undefined) throw new SetupError(`${path} does not exist, so its fingerprint cannot be taken. Nothing was saved.`)
    const at = conventions.findIndex(file => file.path === relative)
    if (at === -1) conventions.push({ path: relative, fingerprint: print })
    else conventions[at] = { path: relative, fingerprint: print }
  }
  return conventions
}

/** What the PM is told once a change is saved. */
const changeReport = (where: string, lines: readonly string[], before: Readonly<Record<string, Answer>>, after: Readonly<Record<string, Answer>>, still: readonly string[]) => {
  const changed = (keys: readonly string[]) => keys.some(key => before[key] !== after[key])
  return [
    `godmode: the setup change is saved in ${where}: ${lines.join('; ')}.`,
    ...(changed(QA_KEYS) ? [qaModeLine(after)] : []),
    ...(qaModeOf(before) !== qaModeOf(after) ? ['Tickets already waiting in qa leave it only with a QA pass recorded, whatever the new mode.'] : []),
    ...(before.tracker !== after.tracker ? ['Tickets the old tracker holds stay there; the ticket tools now use the new one.'] : []),
    ...(still.length > 0 ? [`Still new since this project's setup: ${still.join('; ')}. \`/godmode setup\` offers it again.`] : []),
    BACK_TO_CODING,
  ].join('\n')
}

/**
 * `setup_finish` in change-setup mode: the round's answers and the PM's free settings over the
 * note, every other answer kept, each in its half (D61). The person sees every change and
 * nothing is written without their yes. The version is re-stamped once nothing new since it
 * is left unanswered (D60).
 */
async function changeFinish($: EngineInterface, input: Record<string, unknown>) {
  const project = await projectOf($)
  const found = await noteToChange($, project)
  const settings = checkedSettings(answersIn(input.answers, 'answers'))
  const owned = Object.keys(settings).filter(key => OWNED_KEYS.includes(key))
  if (owned.length > 0) {
    throw new SetupError(`${owned.map(key => `\`${key}\``).join(', ')} ${owned.length === 1 ? 'is' : 'are'} set by a question: call setup_questionnaire with its topic in \`change\` (${TOPIC_HELP}). Nothing was saved.`)
  }
  const edited = stringsIn(input.conventions, 'conventions') ?? []
  const change = (await runOf($)).change
  if (change === undefined && Object.keys(settings).length === 0 && edited.length === 0) {
    return changeEndedUnsaved($, found, 'nothing to save: no change was asked (setup_questionnaire with `change`), and no `answers` or `conventions` were passed. `/godmode setup` starts a change again.')
  }
  const next = applyChange(found.shared.answers, found.personal?.answers ?? {}, change?.dropped ?? [], change?.answers ?? {}, settings)
  // Compared with the note as saved, so a value the answer rules repaired is shown and saved too.
  const saved = savedHalves(found)
  const before = { ...saved.shared, ...saved.personal }
  const after = { ...next.shared, ...next.personal }
  const changedKeys = new Set(Object.keys({ ...before, ...after }).filter(key => before[key] !== after[key]))
  const warnings = await verifiedOrRefused(
    $,
    project.root,
    after,
    'Ask the person again: call setup_questionnaire with the topic of each answer in `change`, or correct a setting you passed in `answers`. Then call setup_finish again.',
    changedKeys,
  )
  const noteVersion = found.shared.godmodeVersion
  const version = await godmodeVersionOf($)
  const still = pendingUpdates(noteVersion, version, after)
  const conventions = await recheckedConventions($, project, found.shared.conventions, edited)
  const isSharedChanged = !sameAnswers(saved.shared, next.shared)
  const isRestamped = (isSharedChanged || change?.isUpdate === true) && still.length === 0 && isOlderVersion(noteVersion, version)
  const rechecked = conventions.filter(file => !found.shared.conventions.some(old => old.path === file.path && old.fingerprint === file.fingerprint))
  const lines = [
    ...answerChanges(before, after),
    ...rechecked.map(file => `conventions: ${file.path} checked again`),
    ...(isRestamped ? [`godmode version: ${noteVersion} -> ${version}`] : []),
  ]
  if (lines.length === 0) return changeEndedUnsaved($, found, 'the setup change left every answer as it was, so nothing was saved.')

  const isShared = isSharedChanged || rechecked.length > 0 || isRestamped
  const team = found.shared.storage === 'committed' && isShared ? ' The team\'s half is committed: the others get it once the change is committed.' : ''
  let answer: string
  try {
    // The rules as they will stand (D78), then the changes, each in log lines above the dialog, so the question itself is never cut off.
    if (isRulesChange(change?.topics ?? [])) {
      const facts = await factsOf($, project)
      const marked: Record<string, Source> = Object.fromEntries(Object.keys(after).map(key => [key, changedKeys.has(key) ? 'you' : 'saved']))
      logSummary($, facts, { ...workingAnswersOf(after), ...after }, marked, 'The project rules after this change:')
    }
    logLines($, `The setup changes to save:\n${lines.map(line => `- ${line}`).join('\n')}`)
    answer = await $.ui.ask(`Save the setup changes shown above?${team}`, { options: [SAVE, CHANGE, 'Discard'], header: 'Save setup' })
  } catch {
    await endChangeSetup($, found, `godmode: the setup change ended, as nobody could answer whether to save it. Nothing was saved. ${BACK_TO_CODING}`)
    throw new SetupError(`godmode could not ask the person whether to save (a headless run, or the question was dismissed). Nothing was saved. ${BACK_TO_CODING} Tell the person the changes in plain words; \`/godmode setup\` starts the change again once they can answer.`)
  }
  if (answer === CHANGE) {
    return 'The person wants to change something before saving; nothing is saved yet, and this round is kept. Ask them what, in a line, then call setup_questionnaire with its topic in `change`, then setup_finish again.'
  }
  if (answer !== SAVE) return changeEndedUnsaved($, found, 'the person discarded the setup change, so nothing was saved.')

  const writtenAt = new Date(await $.clock.now()).toISOString()
  // The rules file follows the note (D78): written again whenever the team's half changes.
  const saving = isSharedChanged ? await rewriteProjectRules($, project, found, next.shared, conventions) : conventions
  if (isShared) {
    await writeSharedNote($, found.dir, { ...found.shared, godmodeVersion: isRestamped ? version : noteVersion, writtenAt, answers: next.shared, conventions: saving })
  }
  if (!sameAnswers(saved.personal, next.personal)) await writePersonalNote($, found.dir, next.personal, found.personal?.models ?? {})
  const report = [changeReport(notePath(project, found.dir), lines, before, after, still.map(entry => entry.what)), ...warnings].join('\n')
  await endChangeSetup($, found, report, next.personal)
  return `${report}\nTell the person this in a line or two.`
}

/** The change topics that move the project rules, so the summary is shown before the save. */
const RULES_TOPICS: readonly string[] = ['start', 'who', 'care', 'merging', 'qa', 'autoMerge', 'prApproval', 'tracker']

const isRulesChange = (topics: readonly string[]) => topics.some(topic => RULES_TOPICS.includes(topic))

/**
 * Writes the rules file again from the note's new team answers (D78), where the note keeps it,
 * else in the conventions folder, and resolves the conventions with its new fingerprint.
 */
async function rewriteProjectRules($: EngineInterface, project: Project, found: FoundNote, shared: Readonly<Record<string, Answer>>, conventions: SharedNote['conventions']) {
  const listed = conventions.find(file => file.path.endsWith(PROJECT_RULES_FILE))?.path
  const dir = conventionsDirOf(project, found.shared.storage, await claudeDirOf($))
  const path = listed === undefined ? (dir === undefined ? undefined : `${dir}/${PROJECT_RULES_FILE}`) : absoluteIn(project, listed)
  if (path === undefined) return conventions
  const facts = await factsOf($, project)
  const find = (pattern: RegExp) => conventions.find(file => pattern.test(file.path))?.path
  const prTemplate = find(/pull_request_template|pr-template/i)
  const gitWorkflow = find(/git-workflow/i)
  const files: AreaFiles = {
    conventionsDir: notePath(project, path.replace(/\/[^/]*$/, '')),
    ...(prTemplate === undefined ? {} : { prTemplate }),
    ...(gitWorkflow === undefined ? {} : { gitWorkflow }),
    ...(typeof shared.ticketRules === 'string' ? { ticketRules: shared.ticketRules } : {}),
    existing: facts.conventions,
  }
  await writeProjectRules($, path, shared, files)
  return recheckedConventions($, project, conventions, [path])
}

/** Takes the setup's report for the PM, once (D64: carried by `prompt.submit`, which runs on every account). */
export async function takeSetupReport($: EngineInterface) {
  const report = await read($, setupReport)
  if (report === '') return undefined
  await update($, setupReport, () => '')
  return report
}

/** Serves one setup tool: only in setup mode, with a refusal the model can read. */
export async function serveSetupTool($: EngineInterface, name: SetupToolName, input: Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so its setup tools do nothing. The person switches it on with `/godmode`.' }
  const current = await read($, mode)
  const isChange = current === 'change-setup' && (name === 'setup_questionnaire' || name === 'setup_finish')
  if (current === 'change-setup' && !isChange) {
    return { deny: `In change-setup mode only setup_questionnaire (with \`change\`) and setup_finish serve; ${name} belongs to a first setup.` }
  }
  if (current !== 'setup' && !isChange) return { deny: 'godmode is not in setup mode, so its setup tools do nothing. A change to the setup goes through `/godmode setup`.' }
  try {
    if (name === 'setup_scan') return { result: await setupScan($) }
    if (name === 'setup_questionnaire') return { result: await setupQuestionnaire($, input) }
    if (name === 'setup_confirm') return { result: await setupConfirm($, input) }
    if (name === 'setup_write_preset') return { result: await setupWritePreset($, input) }
    return { result: await setupFinish($, input) }
  } catch (error) {
    if (error instanceof SetupError) return { deny: error.message }
    return { deny: `godmode's ${name} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

/**
 * In setup mode, an edit to an existing conventions file waits for the person's yes
 * (D32): adopted as they are, or improved in place once `setup_confirm` got a yes.
 */
export async function setupEditRefusal($: EngineInterface, e: { tool: string } & Record<string, unknown>) {
  if (!EDIT_TOOLS.includes(e.tool)) return undefined
  if ((await read($, isOn)) !== true || (await read($, mode)) !== 'setup') return undefined
  const path = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : undefined
  const run = await runOf($)
  if (path === undefined || run.facts === undefined) return undefined
  const root = run.facts.root
  const existing = run.facts.conventions.map(file => `${root}/${file}`)
  if (!existing.includes(path) || run.consented.includes(path)) return undefined
  return `${path} is one of the project's own conventions files. godmode adopts existing conventions as they are, or improves them in place only after the person says yes (D32): call setup_confirm with what would change and why, in a line or two each, then edit. Missing pieces go in new files (setup_write_preset).`
}
