import { prNumberOf } from './host'
import { effectiveModel } from './storage'
import type { AgentRole, Answer, ModelTier, PersonalNote, SharedNote } from './storage'

/*
 * The loop's rules as plain data and pure functions (Step 7, D37): what a preset allows,
 * how a shell command reads as loop actions, what the main thread may do. Nothing here
 * takes `$`; `loop.ts` applies these rules to the session.
 */

/** The four permission presets (D18). */
export type PresetName = 'full-freedom' | 'free' | 'local-only' | 'locked'

export const PRESETS: readonly PresetName[] = ['full-freedom', 'free', 'local-only', 'locked']

/**
 * What a rule says about an action (D13). `ask` always means asking the person directly
 * (`$.ui.ask`), never Claude Code's own permission check, which auto mode could settle
 * without them (D66).
 */
export type Level = 'allow' | 'ask' | 'never'

const LEVEL_RANK: Readonly<Record<Level, number>> = { allow: 0, ask: 1, never: 2 }

export const strictest = (levels: readonly Level[]): Level =>
  levels.reduce<Level>((worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst), 'allow')

/** The writes the presets gate (D13, D18). */
export type Action =
  | 'edit'
  | 'git-write'
  | 'push'
  | 'force-push'
  | 'pr-open'
  | 'pr-comment'
  | 'pr-approve'
  | 'pr-ready'
  | 'pr-merge'
  | 'pr-edit'
  | 'host-write'

export const ACTIONS: readonly Action[] = [
  'edit',
  'git-write',
  'push',
  'force-push',
  'pr-open',
  'pr-comment',
  'pr-approve',
  'pr-ready',
  'pr-merge',
  'pr-edit',
  'host-write',
]

/** How an action reads in a question or a refusal. */
export const ACTION_WORDS: Readonly<Record<Action, string>> = {
  edit: 'edit files',
  'git-write': 'change the repo locally (commit, merge, rebase, reset, ...)',
  push: 'push',
  'force-push': 'force-push',
  'pr-open': 'open a PR',
  'pr-comment': 'comment on or review a PR',
  'pr-approve': 'approve a PR',
  'pr-ready': 'mark a PR ready',
  'pr-merge': 'merge a PR',
  'pr-edit': 'edit, close or reopen a PR',
  'host-write': 'write to the git host through its API',
}

const everyAction = (level: Level) => Object.fromEntries(ACTIONS.map(action => [action, level])) as Record<Action, Level>

/**
 * Each preset's level per action (D18). Free acts alone on the person's own PRs, and asks
 * before approving a PR, force-pushing, or a raw host API write. Auto-merge is a separate
 * switch, off in every preset (D53).
 */
export const PRESET_LEVELS: Readonly<Record<PresetName, Readonly<Record<Action, Level>>>> = {
  'full-freedom': everyAction('allow'),
  free: { ...everyAction('allow'), 'force-push': 'ask', 'pr-approve': 'ask', 'host-write': 'ask' },
  'local-only': { ...everyAction('ask'), edit: 'allow' },
  locked: everyAction('ask'),
}

/** What a preset does to a write on someone else's PR (D16, D17, D18). */
export const OTHERS_PRS_LEVEL: Readonly<Record<PresetName, Level>> = {
  'full-freedom': 'allow',
  free: 'ask',
  'local-only': 'ask',
  locked: 'ask',
}

/** Every loop rule as a setting (D26, D37), read from the setup note's answers. */
export type LoopSettings = {
  preset: PresetName
  /** Set when the note's preset answer was missing or unknown, to say so in a refusal. */
  presetNote?: string
  /** The preset's levels with the note's `permission.<action>` overrides applied. */
  levels: Readonly<Record<Action, Level>>
  /** The level of a write on someone else's PR. */
  othersPrs: Level
  /** False blocks commit messages and PR texts that carry AI attribution (D15). */
  isAttributionAllowed: boolean
  /** Arming auto-merge, off unless the person turns it on (D53). */
  isAutoMergeOn: boolean
  /** Agents running at once (D58). */
  agentCap: number
  /** The main thread keeps to talking, tickets, dispatch and status checks (D63). */
  isThinMainThread: boolean
  /** Files the main thread may read per prompt before reading is a researcher's job (D63). */
  mainThreadReadLimit: number
  /** Extra tools the main thread may use, by name. */
  mainThreadTools: readonly string[]
  /** PRs are opened as drafts (D53). */
  isDraftsOnly: boolean
  /** No ready or merge without a clean verdict at the PR's current commit (D53). */
  isMergeGateOn: boolean
  /** The open PRs' files go into a dev brief, and a dev agent's edit to one is blocked (D47, D48). */
  isContentionOn: boolean
  /** How long a sweep of the open PRs stays fresh for the edit check, in milliseconds. */
  contentionRefreshMs: number
  /** A dev agent edits only inside its worktree (D38). */
  isWorktreeGuardOn: boolean
  /** A dev agent starts only on a ticket the person said go for (D52). */
  requiresReadyTicket: boolean
  /** A dev agent's draft PR tells the PM to start the review (D35). */
  isReviewStartOn: boolean
  /** Only a reviewer agent records a review verdict. */
  verdictFromReviewerOnly: boolean
  /** Where ticket worktrees go: absolute, or relative to the repo root. */
  worktreeFolder?: string
  /** The branch new ticket branches start from; found from `origin/HEAD` when unset. */
  baseBranch?: string
  /** The start of a new ticket branch's name. */
  branchPrefix: string
}

/** The answers' names for each setting, for messages that say how to change one. */
export const SETTING = {
  preset: 'permissions',
  attribution: 'attribution',
  autoMerge: 'autoMerge',
  agentCap: 'agentCap',
  thinMainThread: 'thinMainThread',
  mainThreadReadLimit: 'mainThreadReadLimit',
  mainThreadTools: 'mainThreadTools',
  draftsOnly: 'draftsOnly',
  mergeGate: 'mergeGate',
  contention: 'contention',
  contentionRefreshSeconds: 'contentionRefreshSeconds',
  worktreeGuard: 'worktreeGuard',
  requireReadyTicket: 'requireReadyTicket',
  reviewStart: 'reviewStart',
  verdictFromReviewerOnly: 'verdictFromReviewerOnly',
  worktreeFolder: 'worktreeFolder',
  baseBranch: 'baseBranch',
  branchPrefix: 'branchPrefix',
  othersPrs: 'permission.others-prs',
} as const

/** `permission.<action>` overrides one action's level. */
export const permissionKey = (action: Action) => `permission.${action}`

/** The preset a note names when it names none it knows; every write but an edit asks. */
export const DEFAULT_PRESET: PresetName = 'local-only'

const booleanOf = (value: Answer | undefined, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    if (['yes', 'true', 'on', '1'].includes(word)) return true
    if (['no', 'false', 'off', '0'].includes(word)) return false
  }
  return fallback
}

const numberOf = (value: Answer | undefined, fallback: number, minimum: number) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(number) && number >= minimum ? number : fallback
}

const textOf = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const levelOf = (value: Answer | undefined): Level | undefined => {
  const word = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '-') : undefined
  if (word === 'allow' || word === 'allowed') return 'allow'
  if (word === 'ask' || word === 'ask-me') return 'ask'
  if (word === 'never') return 'never'
  return undefined
}

/** `Full freedom`, `full_freedom`, `local only` and the like as a preset name. */
export const presetOf = (value: Answer | undefined): PresetName | undefined => {
  const word = typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : undefined
  return PRESETS.find(preset => preset === word)
}

/** The loop settings from a note's answers, shared then personal; anything unset takes its default. */
export const settingsOf = (answers: Readonly<Record<string, Answer>>): LoopSettings => {
  const named = presetOf(answers[SETTING.preset])
  const preset = named ?? DEFAULT_PRESET
  const levels = { ...PRESET_LEVELS[preset] }
  for (const action of ACTIONS) {
    const override = levelOf(answers[permissionKey(action)])
    if (override !== undefined) levels[action] = override
  }
  const tools = textOf(answers[SETTING.mainThreadTools])
  return {
    preset,
    presetNote:
      named === undefined
        ? `the setup note names no preset godmode knows (\`${String(answers[SETTING.preset] ?? 'none')}\`), so it uses ${DEFAULT_PRESET}`
        : undefined,
    levels,
    othersPrs: levelOf(answers[SETTING.othersPrs]) ?? OTHERS_PRS_LEVEL[preset],
    isAttributionAllowed: booleanOf(answers[SETTING.attribution], true),
    isAutoMergeOn: booleanOf(answers[SETTING.autoMerge], false),
    agentCap: Math.floor(numberOf(answers[SETTING.agentCap], 5, 1)),
    isThinMainThread: booleanOf(answers[SETTING.thinMainThread], true),
    mainThreadReadLimit: Math.floor(numberOf(answers[SETTING.mainThreadReadLimit], 2, 0)),
    mainThreadTools: tools === undefined ? [] : tools.split(',').map(tool => tool.trim()).filter(tool => tool !== ''),
    isDraftsOnly: booleanOf(answers[SETTING.draftsOnly], true),
    isMergeGateOn: booleanOf(answers[SETTING.mergeGate], true),
    isContentionOn: booleanOf(answers[SETTING.contention], true),
    contentionRefreshMs: numberOf(answers[SETTING.contentionRefreshSeconds], 60, 0) * 1000,
    isWorktreeGuardOn: booleanOf(answers[SETTING.worktreeGuard], true),
    requiresReadyTicket: booleanOf(answers[SETTING.requireReadyTicket], true),
    isReviewStartOn: booleanOf(answers[SETTING.reviewStart], true),
    verdictFromReviewerOnly: booleanOf(answers[SETTING.verdictFromReviewerOnly], true),
    worktreeFolder: textOf(answers[SETTING.worktreeFolder]),
    baseBranch: textOf(answers[SETTING.baseBranch]),
    branchPrefix: textOf(answers[SETTING.branchPrefix]) ?? 'godmode/',
  }
}

/** How a refusal says to change a setting. */
export const howToChange = (setting: string) => `the person can change this with \`/godmode setup\` (setting \`${setting}\`)`

// ---------------------------------------------------------------------------
// Shell commands as loop actions

/** One command of a shell line that the rules care about. */
export type ShellStep = {
  action: Action
  /** `git commit`, `gh pr create`, ...: what it is, for messages. */
  verb: string
  /** The PR the command names: a number, or a branch as `gh` takes it. */
  pr?: string
  /** `gh pr create --draft`. */
  isDraft?: boolean
  /** `gh pr merge --auto`. */
  isAuto?: boolean
  /** `gh pr ready --undo`, `gh pr merge --disable-auto`: a step back, never gated by a verdict. */
  isUndo?: boolean
  /** Files the command reads its message or body from (`git commit -F`, `gh pr create --body-file`). */
  bodyFiles: string[]
}

/** The words of one simple command; quotes group words, and are dropped. */
export const wordsOf = (segment: string) =>
  [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '')

/**
 * A shell line split into its chains (`&&`, `||`, `;`, new lines), each a pipeline of
 * simple commands. Quoting is not parsed: a quoted `;` splits too, which only ever makes
 * a check stricter.
 */
export const pipelinesOf = (command: string) =>
  command
    .split(/&&|\|\||;|\n/)
    .map(chain => chain.split('|').map(part => part.trim()).filter(part => part !== ''))
    .filter(chain => chain.length > 0)

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'exec', 'nohup', '(', '{'])

/** A simple command's words with leading `FOO=bar`, `sudo`, `(` and the like left out. */
const commandWords = (segment: string) => {
  const words = wordsOf(segment.replace(/^[({]+/, ''))
  let start = 0
  while (start < words.length && (WRAPPERS.has(words[start] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? ''))) start += 1
  return words.slice(start)
}

/** git's own options before the subcommand, the ones that take a value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

/** The git subcommand and its arguments, past git's own options. */
const gitParts = (words: readonly string[]) => {
  let index = 1
  while (index < words.length && (words[index] ?? '').startsWith('-')) index += GIT_VALUE_OPTIONS.has(words[index] ?? '') ? 2 : 1
  return { sub: words[index] ?? '', args: words.slice(index + 1) }
}

const hasAny = (args: readonly string[], flags: readonly string[]) =>
  args.some(arg => flags.includes(arg) || flags.some(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`)))

/** The value after a flag (`-F file`, `--file=file`), for each time it appears. */
const valuesOf = (args: readonly string[], flags: readonly string[]) =>
  args.flatMap((arg, index) => {
    const inline = flags.find(flag => flag.startsWith('--') && arg.startsWith(`${flag}=`))
    if (inline !== undefined) return [arg.slice(inline.length + 1)]
    return flags.includes(arg) && args[index + 1] !== undefined ? [args[index + 1] as string] : []
  })

const GIT_WRITES = new Set(['commit', 'merge', 'rebase', 'reset', 'revert', 'cherry-pick', 'am', 'clean', 'restore', 'rm', 'mv', 'update-ref', 'filter-branch', 'filter-repo', 'replace', 'apply'])

/** A git command as a loop action, or undefined when it writes nothing the presets gate. */
const gitStep = (words: readonly string[]): ShellStep | undefined => {
  const { sub, args } = gitParts(words)
  const step = (action: Action, extra: Partial<ShellStep> = {}): ShellStep => ({ action, verb: `git ${sub}`, bodyFiles: [], ...extra })
  if (sub === 'push') {
    const isForce = hasAny(args, ['-f', '--force', '--force-with-lease', '--force-if-includes']) || args.some(arg => /^\+[^+]/.test(arg))
    return step(isForce ? 'force-push' : 'push')
  }
  if (sub === 'commit') return step('git-write', { bodyFiles: valuesOf(args, ['-F', '--file']) })
  if (GIT_WRITES.has(sub)) return step('git-write')
  if (sub === 'checkout' || sub === 'switch') {
    return hasAny(args, ['--', '.', '-f', '--force', '-B', '-C', '--discard-changes']) ? step('git-write') : undefined
  }
  if (sub === 'stash') return ['list', 'show'].includes(args[0] ?? '') ? undefined : step('git-write')
  if (sub === 'branch') return hasAny(args, ['-d', '-D', '--delete', '-m', '-M', '--move', '-f', '--force', '-c', '-C', '--copy']) ? step('git-write') : undefined
  if (sub === 'tag') {
    if (hasAny(args, ['-l', '--list'])) return undefined
    return args.some(arg => !arg.startsWith('-')) || hasAny(args, ['-d', '--delete']) ? step('git-write') : undefined
  }
  if (sub === 'worktree') return ['add', 'remove', 'move', 'prune'].includes(args[0] ?? '') ? step('git-write') : undefined
  return undefined
}

/** `gh pr` options that take a value, so the PR named after them is found. */
const GH_VALUE_OPTIONS = new Set([
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-t',
  '--title',
  '--subject',
  '-R',
  '--repo',
  '-B',
  '--base',
  '-H',
  '--head',
  '--match-head-commit',
  '-A',
  '--author-email',
  '--add-label',
  '--remove-label',
  '--add-reviewer',
  '--remove-reviewer',
  '--add-assignee',
  '--remove-assignee',
  '-c',
  '--comment',
  '-r',
  '--reason',
  '-m',
  '--milestone',
])

/** The PR a `gh pr <sub>` command names: its number (from a link too), or a branch. */
const prArgument = (args: readonly string[]) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg.startsWith('-')) {
      if (GH_VALUE_OPTIONS.has(arg)) index += 1
      continue
    }
    return prNumberOf(arg) ?? arg.replace(/^#/, '')
  }
  return undefined
}

/** A gh command as a loop action, or undefined when it writes nothing the presets gate. */
const ghStep = (words: readonly string[]): ShellStep | undefined => {
  const [, group = '', sub = '', ...args] = words
  if (group === 'api') {
    const rest = words.slice(2)
    const method = valuesOf(rest, ['-X', '--method'])[0]?.toUpperCase()
    const hasFields = hasAny(rest, ['-f', '-F', '--field', '--raw-field', '--input'])
    const isMutation = rest.some(arg => /^\s*mutation\b/.test(arg) || /query=\s*mutation\b/.test(arg))
    const isWrite = method !== undefined ? method !== 'GET' && method !== 'HEAD' : hasFields || isMutation
    return isWrite ? { action: 'host-write', verb: 'gh api', bodyFiles: [] } : undefined
  }
  if (group !== 'pr') return undefined
  const verb = `gh pr ${sub}`
  const bodyFiles = valuesOf(args, ['-F', '--body-file'])
  if (sub === 'create' || sub === 'new') {
    return { action: 'pr-open', verb, isDraft: hasAny(args, ['-d', '--draft']), bodyFiles }
  }
  const pr = prArgument(args)
  if (sub === 'comment') return { action: 'pr-comment', verb, pr, bodyFiles }
  if (sub === 'review') return { action: hasAny(args, ['-a', '--approve']) ? 'pr-approve' : 'pr-comment', verb, pr, bodyFiles }
  if (sub === 'ready') return { action: 'pr-ready', verb, pr, isUndo: hasAny(args, ['--undo']), bodyFiles }
  if (sub === 'merge') {
    return { action: 'pr-merge', verb, pr, isAuto: hasAny(args, ['--auto']), isUndo: hasAny(args, ['--disable-auto']), bodyFiles }
  }
  if (['edit', 'close', 'reopen', 'lock', 'unlock'].includes(sub)) return { action: 'pr-edit', verb, pr, bodyFiles }
  return undefined
}

/** Every write the presets gate in a shell line, in order. */
export const classifyShell = (command: string): ShellStep[] =>
  pipelinesOf(command).flatMap(chain =>
    chain.flatMap(segment => {
      const words = commandWords(segment)
      const step = words[0] === 'git' ? gitStep(words) : words[0] === 'gh' ? ghStep(words) : undefined
      return step === undefined ? [] : [step]
    }),
  )

/** The verbs whose text is a commit message or a PR text, where attribution is looked for (D15). */
export const carriesText = (step: ShellStep) =>
  step.verb === 'git commit' || ['pr-open', 'pr-comment', 'pr-approve', 'pr-edit', 'pr-merge'].includes(step.action)

const ATTRIBUTION: readonly RegExp[] = [
  /co-authored-by:[^\n]*\b(?:claude|anthropic)\b[^\n]*/i,
  /generated (?:with|by) \[?claude(?: code)?\]?/i,
  /noreply@anthropic\.com/i,
]

/** The AI attribution line in a text, when it carries one (D15). */
export const attributionIn = (text: string) => {
  for (const pattern of ATTRIBUTION) {
    const found = pattern.exec(text)?.[0]
    if (found !== undefined) return found.trim()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The thin main thread (D63)

/** The main thread's own tools: talking, dispatching, its task list, and loading tools. */
export const MAIN_THREAD_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'Agent',
  'Task',
  'SendMessage',
  'TaskStop',
  'TaskOutput',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TodoWrite',
  'Monitor',
  'ToolSearch',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'ScheduleWakeup',
  'ListAgents',
])

/** Status checks: a git or gh read of the loop's state, never of the code. */
const isStatusCheck = (words: readonly string[]) => {
  const [program = '', ...rest] = words
  if (program === 'pwd' || program === 'date') return true
  if (program === 'ls') return !rest.some(arg => /^-[A-Za-z]*R/.test(arg) || arg === '--recursive')
  if (program === 'git') {
    const { sub, args } = gitParts(words)
    if (['status', 'rev-parse', 'fetch', 'describe', 'ls-remote', 'remote', 'shortlog'].includes(sub)) return sub !== 'remote' || !['add', 'remove', 'rm', 'rename', 'set-url'].includes(args[0] ?? '')
    if (sub === 'log') return !hasAny(args, ['-p', '--patch', '-L', '-u'])
    if (sub === 'diff' || sub === 'show') return hasAny(args, ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--no-patch', '-s'])
    if (sub === 'branch') return gitStep(words) === undefined
    if (sub === 'worktree') return args[0] === 'list'
    if (sub === 'stash') return args[0] === 'list'
    if (sub === 'rev-list') return hasAny(args, ['--count'])
    return false
  }
  if (program === 'gh') {
    const [group = '', sub = ''] = rest
    if (group === 'pr') return ['list', 'view', 'status', 'checks'].includes(sub)
    if (group === 'run') return ['list', 'view', 'watch'].includes(sub)
    if (group === 'auth' || group === 'repo') return sub === 'status' || sub === 'view'
    return false
  }
  return false
}

/** What may read a status check's output: filters, never a file. */
const isFilter = (words: readonly string[]) => {
  const [program = '', ...rest] = words
  if (['head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'column', 'jq', 'tr'].includes(program)) {
    return program !== 'jq' || rest.filter(arg => !arg.startsWith('-')).length <= 1
  }
  if (program === 'grep' || program === 'rg') return rest.filter(arg => !arg.startsWith('-')).length <= 1
  return false
}

/** The PR actions the PM itself takes: relaying a verdict, marking ready, merging on the person's go. */
const isPmLoopAction = (words: readonly string[]) => {
  const step = words[0] === 'gh' ? ghStep(words) : undefined
  return step !== undefined && ['pr-comment', 'pr-ready', 'pr-merge'].includes(step.action)
}

/** Whether a shell line is a quick status check (or the PM's own PR action) the main thread may run. */
export const isMainThreadShell = (command: string) => {
  // A redirect writes a file, a substitution runs a second command: neither is a status check.
  const plain = command.replace(/\d?>&\d/g, '').replace(/\d?>\s*\/dev\/null/g, '')
  if (/[<>`]|\$\(/.test(plain)) return false
  const chains = pipelinesOf(plain)
  return (
    chains.length > 0 &&
    chains.every(chain => {
      const [first = [], ...filters] = chain.map(commandWords)
      return (isStatusCheck(first) || isPmLoopAction(first)) && filters.every(isFilter)
    })
  )
}

export type MainThreadCall = { tool: string; command?: unknown; run_in_background?: unknown }

/** What the main thread may do, or why not. */
export type MainThreadVerdict = { isAllowed: true; isRead?: boolean } | { isAllowed: false; reason: string }

/**
 * Whether the main thread may make a call (D63): talking, the ticket tools, dispatching
 * agents and shells, quick status checks, and a couple of reads per prompt.
 */
export const mainThreadVerdict = (call: MainThreadCall, settings: LoopSettings, readsThisPrompt: number): MainThreadVerdict => {
  const { tool } = call
  if (MAIN_THREAD_TOOLS.has(tool) || tool.startsWith('mcp__godmode__') || settings.mainThreadTools.includes(tool)) return { isAllowed: true }
  const refuse = (what: string, setting: string = SETTING.thinMainThread): MainThreadVerdict => ({
    isAllowed: false,
    reason: `godmode keeps the main thread thin: ${what} is work for an agent, not the PM. Dispatch a researcher or a shell to do it, and keep this thread for talking, tickets and dispatch. To loosen the rule, ${howToChange(setting)}.`,
  })
  if (tool === 'Read') {
    if (readsThisPrompt < settings.mainThreadReadLimit) return { isAllowed: true, isRead: true }
    return refuse(
      `reading more than ${settings.mainThreadReadLimit} file${settings.mainThreadReadLimit === 1 ? '' : 's'} in one prompt`,
      SETTING.mainThreadReadLimit,
    )
  }
  if (tool === 'Bash') {
    if (call.run_in_background === true) return { isAllowed: true }
    const command = typeof call.command === 'string' ? call.command : ''
    if (isMainThreadShell(command)) return { isAllowed: true }
    return refuse(`running \`${command.split('\n')[0]?.slice(0, 80) ?? ''}\` (only quick git and gh status checks run here; a background shell is fine)`)
  }
  if (['Edit', 'Write', 'NotebookEdit'].includes(tool)) return refuse('editing files')
  if (['Grep', 'Glob', 'LSP'].includes(tool)) return refuse('searching code')
  if (['WebFetch', 'WebSearch'].includes(tool)) return refuse('research on the web')
  return refuse(`\`${tool}\``, SETTING.mainThreadTools)
}

// ---------------------------------------------------------------------------
// Roles, models and paths

export const ROLES: readonly AgentRole[] = ['dev', 'reviewer', 'setup', 'researcher', 'qa']

/** The godmode role of an agent type: `godmode:dev` or a bare `dev`; undefined for any other. */
export const roleOf = (subagentType: string): AgentRole | undefined => {
  const name = subagentType.replace(/^godmode:/, '')
  return ROLES.find(role => role === name)
}

const TIER_RANK: Readonly<Record<ModelTier, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/** The tier of an alias or a full model id; undefined for a model godmode cannot rank. */
export const tierOf = (model: string): ModelTier | undefined => {
  const name = model.toLowerCase()
  return (['opus', 'sonnet', 'haiku'] as const).find(tier => name.includes(tier))
}

/**
 * The model a role's spawn runs on (D39, D62): the role's model is a floor. A request at
 * or above it stands (the PM may pick Opus for a hard ticket); one below, or none, takes
 * the floor. A model godmode cannot rank stands as asked.
 */
export const spawnModel = (
  requested: string | undefined,
  role: AgentRole,
  note?: { shared?: Pick<SharedNote, 'minimumModels'>; personal?: Pick<PersonalNote, 'models'> },
): string => {
  const floor = effectiveModel(role, note)
  if (requested === undefined || requested === '' || requested === 'inherit') return floor
  const tier = tierOf(requested)
  if (tier === undefined) return requested
  return TIER_RANK[tier] < TIER_RANK[floor] ? floor : requested
}

/** A path with `.` and `..` resolved and no trailing slash. */
export const normalisePath = (path: string) => {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Whether `path` is `folder` or inside it. */
export const isInside = (path: string, folder: string) => {
  const [inner, outer] = [normalisePath(path), normalisePath(folder)]
  return inner === outer || inner.startsWith(`${outer}/`)
}

/** `path` relative to `folder`, which holds it. */
export const relativeTo = (path: string, folder: string) => normalisePath(path).slice(normalisePath(folder).length + 1)

/** The system's scratch folders: writing there edits no project. */
export const SCRATCH_FOLDERS: readonly string[] = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

/**
 * The first ticket id a brief names: `T-3` for markdown tickets (D50), else a tracker key
 * like `ABC-12`.
 */
export const ticketIn = (brief: string, isMarkdown = true) =>
  (isMarkdown ? /\b(T-\d+)\b/i : /\b([A-Z][A-Z0-9]+-\d+)\b/).exec(brief)?.[1]?.toUpperCase()
