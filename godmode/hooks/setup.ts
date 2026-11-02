import { atom, read, update } from 'claude-code'
import type { EngineInterface, ToolSpec } from 'claude-code'

import type { GodmodeMode, ScanFacts, SetupRun, SetupScope } from '../types'
import { indicatorOf } from './indicator'
import { extraQuestion, isPersonalKey, questionsFor, resolveAnswer } from './questionnaire'
import type { ExtraQuestion, Question } from './questionnaire'
import { COMMAND_KEYS, presetFoldersFor, scanProject } from './scan'
import {
  claudeDirOf,
  conventionsDirOf,
  ensureExcluded,
  gitignoreLines,
  notePath,
  presetTarget,
  projectOf,
  readNote,
  STORAGE_MODES,
  writeNote,
  writePersonalNote,
} from './storage'
import type { Answer, Project, StorageMode } from './storage'

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
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'mode' as 'mode' | 'hint' | 'band')

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
      'godmode setup, step 2: ask the person the setup questions, one multiple-choice dialog each: only the gaps the scan left, then permissions, storage, tracker, attribution, QA and the on-indicator. Add a question only for a real gap the scan could not settle; never about reference repos. `given` holds answers the person already gave (relayed by the PM), which are not asked again.',
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
        given: { type: 'object', description: 'Answers the person already gave, by key (`permissions`, `storage`, `tracker`, ...).' },
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
      'godmode setup, last step: write the setup note with a fingerprint of each conventions file, so the next /godmode starts in coding mode, and switch godmode to coding mode. Every required template must be written or covered by an existing file named in `covered`.',
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

/** The command answers' keys, as the note records them: `testCommand`, `startCommand`, ... */
export const commandKey = (key: string) => `${key}Command`

/** Where PRs live, as the questionnaire and the scan settled it. */
const isGitHubHost = (facts: ScanFacts, answers: Readonly<Record<string, Answer>>) =>
  answers.gitHost === 'github' || (answers.gitHost === undefined && facts.git.host === 'github')

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
    return await $.ui.ask(question.question, { options: question.choices.map(choice => choice.label), header: question.header })
  } catch {
    return undefined
  }
}

/** Starts a setup run: clears what an earlier one left. The PM is told to dispatch the setup agent. */
export async function beginSetup($: EngineInterface, scope: SetupScope) {
  await update($, setupRun, () => ({ consented: [], written: [] }))
  await update($, setupReport, () => '')
  const what =
    scope === 'personal'
      ? 'This project\'s team setup is committed already, so only your own answers are missing (permissions, attribution, the on-indicator).'
      : 'A setup agent scans the project, then asks you a few multiple-choice questions and sets up its conventions.'
  return {
    text: `godmode is setting up this project. ${what}`,
    context: [
      [
        `godmode is on in setup mode (scope: ${scope}). The project has no finished setup note yet, so the loop cannot start.`,
        `Dispatch the setup now, in the background, without being asked: one Agent call with subagent_type \`godmode:setup\`, description "godmode setup", and the prompt "Set up godmode for this project. Scope: ${scope}." godmode runs it on Opus.`,
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
  const given = answersIn(input.given, 'given')
  const answers: Record<string, Answer> = {}
  const notes: string[] = []
  const unasked: Question[] = []
  for (const question of questionsFor(facts, scope, extras)) {
    const raw = given[question.key] ?? (unasked.length === 0 ? await askQuestion($, question) : undefined)
    if (raw === undefined) {
      unasked.push(question)
      continue
    }
    const resolved = resolveAnswer(question, raw)
    Object.assign(answers, resolved.values)
    if (resolved.note !== undefined) notes.push(resolved.note)
  }
  await saveRun($, current => ({ ...current, answers: { ...(current.answers ?? {}), ...answers } }))
  if (unasked.length > 0) {
    const lines = unasked.map(question => `- ${question.key}: ${question.question} (${question.choices.map(choice => choice.label).join(' / ')})`)
    throw new SetupError(
      [
        'godmode could not ask the person (a headless run, or the question was dismissed), so setup stops here. Nothing was written.',
        'Report these questions to the PM, who asks the person and dispatches the setup again with the answers as `given`:',
        ...lines,
      ].join('\n'),
    )
  }
  const shown = Object.entries(answers).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
  return ['The person answered:', ...shown, ...notes.map(note => `Note: ${note}`)].join('\n')
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
    answer = await $.ui.ask(`Improve your existing conventions in place? ${change} Why: ${why}`, {
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
    if (key === 'storage') continue
    // An empty answer ("No tests yet", "Decide later") records nothing.
    if (value === '') continue
    if (isPersonalKey(key)) personal[key] = value
    else shared[key] = value
  }
  return { shared, personal }
}

/** Switches to coding mode after a setup, and leaves the PM its one report. */
async function finishInto($: EngineInterface, report: string, personal: Readonly<Record<string, Answer>>) {
  await update($, recheck, () => [])
  await update($, setupScope, () => 'full')
  await update($, indicator, () => indicatorOf(personal.indicator))
  await update($, setupReport, () => report)
  await update($, mode, () => 'coding')
  $.ui.toast('godmode setup is done: coding mode.')
}

/** `setup_finish`: checks the required pieces (D31), writes the note (D20), switches to coding mode. */
export async function setupFinish($: EngineInterface, input: Record<string, unknown>) {
  const run = await runOf($)
  if (run.answers === undefined) throw new SetupError('Run setup_questionnaire first: the note records the person\'s answers.')
  const project = await projectOf($)
  const facts = await factsOf($, project)
  const scope = await read($, setupScope)
  const agentAnswers = answersIn(input.answers, 'answers')
  const { shared, personal } = noteAnswers(facts, agentAnswers, run.answers)

  if (scope === 'personal') {
    const found = await readNote($, project)
    if (found.status !== 'found') throw new SetupError('The team\'s committed note is gone, so this is no longer a personal setup. Run `/godmode` again for a full setup.')
    const path = await writePersonalNote($, found.dir, personal)
    const report = `godmode: your personal setup is done (${notePath(project, path)}): permissions ${String(personal.permissions ?? 'unset')}. godmode is now in coding mode, and you are the PM.`
    await finishInto($, report, personal)
    return `${report} Stop here and report this in one or two lines.`
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
  const conventions = [...new Set([...listed, ...coveredPaths, ...run.written.map(entry => entry.path)].map(path => notePath(project, absoluteIn(project, path))))]
  const dir = await writeNote(
    $,
    { storage: storage as StorageMode, sharedAnswers: shared, minimumModels: {}, conventions, personalAnswers: personal, models: {} },
    project,
  )
  const report = [
    `godmode: setup is done. The note is in ${notePath(project, dir)} (${String(storage)} storage).`,
    `Conventions the loop follows: ${conventions.join(', ') || 'none'}.`,
    `Tracker: ${String(shared.tracker ?? 'none')}; permissions: ${String(personal.permissions ?? 'unset')}; QA: ${shared.qa === true ? 'on' : 'off'}; tests: ${String(shared.testCommand ?? 'none found')}.`,
    'godmode is now in coding mode, and you are the PM.',
  ].join('\n')
  await finishInto($, report, personal)
  return `${report}\nStop here and report this to the PM in a few lines.`
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
  if ((await read($, mode)) !== 'setup') return { deny: 'godmode is not in setup mode, so its setup tools do nothing. A change to the setup goes through `/godmode setup`.' }
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
