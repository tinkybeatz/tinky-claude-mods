import { APPROVAL_POLICIES } from './answers'
import type { ApprovalPolicy } from './answers'
import { prNumberOf } from './host'
import { qaModeOf } from './role'
import type { QaMode } from './role'
import { effectiveModel, MODEL_RANK } from './storage'
import type { AgentRole, Answer, ModelTier, PersonalNote, SharedNote } from './storage'
import type { TicketHeader } from './tickets'

/*
 * The loop's rules as plain data and pure functions (Step 7, D37): which writes ask the person,
 * how a shell command reads as loop actions, what the main thread may do. Nothing here
 * takes `$`; `loop.ts` applies these rules to the session.
 */

/**
 * The controlled actions (D74). Reads are never restricted and every other write is free;
 * these run only on the person's explicit ask for that one target, which the PM records with
 * `allow_once`. Merging is not among them: the verdict and QA gates and the auto-merge
 * setting hold it.
 */
export const CONTROLLED = ['approve-pr', 'close-pr', 'delete-branch', 'force-push', 'edit-ticket', 'host-write'] as const

export type ControlledAction = (typeof CONTROLLED)[number]

/** How a controlled action reads in a refusal. */
export const CONTROLLED_WORDS: Readonly<Record<ControlledAction, string>> = {
  'approve-pr': 'approving a PR',
  'close-pr': 'closing a PR',
  'delete-branch': 'deleting a branch godmode did not create',
  'force-push': 'force-pushing over a reviewed commit',
  'edit-ticket': 'moving or editing a ticket that is neither godmode\'s nor created by you',
  'host-write': 'a raw write through the git host\'s API',
}

/** One controlled action on one target: a PR number, a branch, a ticket key or an API endpoint; `reason` when the target's owner could not be told. */
export type Controlled = { action: ControlledAction; target: string; reason?: string }

/** A target as an unlock and a step compare it, without case: `#12` is `12`, `origin/x` is `x`. */
export const targetKey = (target: string) => target.trim().replace(/^#/, '').replace(/^origin\//, '').toLowerCase()

/** The refusal of a controlled action nobody unlocked (D74). */
export const controlledRefusal = (held: readonly Controlled[]) => {
  const whats = held.map(entry => `${CONTROLLED_WORDS[entry.action]} (${entry.target}${entry.reason === undefined ? '' : `: ${entry.reason}`})`).join(' and ')
  const calls = held.map(entry => `allow_once (action: ${entry.action}, target: ${entry.target})`).join(', ')
  return `This is a controlled action: ${whats}. It runs only when the person asks for it explicitly: ask for it explicitly and it goes through. When the person has asked for exactly this, the PM records their words with mcp__godmode__${calls}, then it runs again. An agent never records an ask itself. Nothing ran.`
}

/** The writes the loop reads in a shell line (D13). */
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

/** Every loop rule as a setting (D26, D37), read from the setup note's answers. */
export type LoopSettings = {
  /** Approving a PR: never unasked, or once review and QA passed (D74). */
  prApproval: ApprovalPolicy
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
  /** How the project is tested (D69); `human-pr` adds a QA pass to the ready and merge gate. */
  qaMode: QaMode
  /** In a human QA mode, the QA agent tests before people do (D71). */
  isQaBotFirst: boolean
  /** Fix rounds on one ticket before the PM stops and asks (D56); a human QA fail counts too. */
  fixRoundLimit: number
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
  prApproval: 'prApproval',
  attribution: 'attribution',
  autoMerge: 'autoMerge',
  agentCap: 'agentCap',
  thinMainThread: 'thinMainThread',
  mainThreadReadLimit: 'mainThreadReadLimit',
  mainThreadTools: 'mainThreadTools',
  draftsOnly: 'draftsOnly',
  mergeGate: 'mergeGate',
  qaMode: 'qaMode',
  fixRoundLimit: 'fixRoundLimit',
  contention: 'contention',
  contentionRefreshSeconds: 'contentionRefreshSeconds',
  worktreeGuard: 'worktreeGuard',
  requireReadyTicket: 'requireReadyTicket',
  reviewStart: 'reviewStart',
  verdictFromReviewerOnly: 'verdictFromReviewerOnly',
  worktreeFolder: 'worktreeFolder',
  baseBranch: 'baseBranch',
  branchPrefix: 'branchPrefix',
} as const

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

/** The loop settings from a note's answers, shared then personal; anything unset takes its default. */
export const settingsOf = (answers: Readonly<Record<string, Answer>>): LoopSettings => {
  const tools = textOf(answers[SETTING.mainThreadTools])
  // A note's old `permissions` preset (D18) is no longer read (D74).
  return {
    prApproval: APPROVAL_POLICIES.find(policy => policy === answers[SETTING.prApproval]) ?? 'ask',
    isAttributionAllowed: booleanOf(answers[SETTING.attribution], true),
    isAutoMergeOn: booleanOf(answers[SETTING.autoMerge], false),
    agentCap: Math.floor(numberOf(answers[SETTING.agentCap], 5, 1)),
    isThinMainThread: booleanOf(answers[SETTING.thinMainThread], true),
    mainThreadReadLimit: Math.floor(numberOf(answers[SETTING.mainThreadReadLimit], 2, 0)),
    mainThreadTools: tools === undefined ? [] : tools.split(',').map(tool => tool.trim()).filter(tool => tool !== ''),
    isDraftsOnly: booleanOf(answers[SETTING.draftsOnly], true),
    isMergeGateOn: booleanOf(answers[SETTING.mergeGate], true),
    qaMode: qaModeOf(answers),
    isQaBotFirst: booleanOf(answers.qaBotFirst, false),
    fixRoundLimit: Math.floor(numberOf(answers[SETTING.fixRoundLimit], 3, 1)),
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
  /** A raw host API call (`gh api`) that merges or marks ready: gated as that PR step, asked as a host write. */
  isApi?: boolean
  /** The branches `git branch -d` or `git push --delete` removes. */
  deletes?: string[]
  /** The branch a push names (`git push origin x`), when it names one. */
  branch?: string
  /** A raw host API call's endpoint (`repos/o/r/pulls/12/reviews`). */
  endpoint?: string
}

/**
 * The words of one simple command; quotes group words, and are dropped. A quote the chain
 * split cut in two (`bash -c "a && b"`) is dropped from the word's ends too.
 */
export const wordsOf = (segment: string) =>
  [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? (match[3] ?? '').replace(/^["']+|["']+$/g, ''))

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

/**
 * A simple command's words with leading `FOO=bar`, `sudo`, `(` and the like left out, and
 * the program by its name alone: `/usr/bin/gh` is `gh`.
 */
const commandWords = (segment: string) => {
  const words = wordsOf(segment.replace(/^[({]+/, ''))
  let start = 0
  while (start < words.length && (WRAPPERS.has(words[start] ?? '') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? ''))) start += 1
  const [program, ...args] = words.slice(start)
  return program === undefined ? [] : [program.replace(/^.*\//, ''), ...args]
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

/** A git command as a loop action, or undefined when it writes nothing the loop reads. */
const gitStep = (words: readonly string[]): ShellStep | undefined => {
  const { sub, args } = gitParts(words)
  const step = (action: Action, extra: Partial<ShellStep> = {}): ShellStep => ({ action, verb: `git ${sub}`, bodyFiles: [], ...extra })
  if (sub === 'push') {
    const isForce = hasAny(args, ['-f', '--force', '--force-with-lease', '--force-if-includes']) || args.some(arg => /^\+[^+]/.test(arg))
    const named = args.filter(arg => !arg.startsWith('-'))
    // `git push origin --delete a b`, or `git push origin :a`.
    const deletes = hasAny(args, ['-d', '--delete']) ? named.slice(1) : named.flatMap(arg => /^:(.+)$/.exec(arg)?.[1] ?? [])
    const branch = named[1]?.replace(/^\+/, '').split(':').at(-1)
    return step(isForce ? 'force-push' : 'push', { ...(deletes.length === 0 ? {} : { deletes }), ...(branch === undefined || branch === '' ? {} : { branch }) })
  }
  if (sub === 'commit') return step('git-write', { bodyFiles: valuesOf(args, ['-F', '--file']) })
  if (GIT_WRITES.has(sub)) return step('git-write')
  if (sub === 'checkout' || sub === 'switch') {
    return hasAny(args, ['--', '.', '-f', '--force', '-B', '-C', '--discard-changes']) ? step('git-write') : undefined
  }
  if (sub === 'stash') return ['list', 'show'].includes(args[0] ?? '') ? undefined : step('git-write')
  if (sub === 'branch') {
    if (hasAny(args, ['-d', '-D', '--delete'])) return step('git-write', { deletes: args.filter(arg => !arg.startsWith('-')) })
    return hasAny(args, ['-m', '-M', '--move', '-f', '--force', '-c', '-C', '--copy']) ? step('git-write') : undefined
  }
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

/** gh's own options that take a value, written before the command group or the subcommand. */
const GH_GLOBAL_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])

/** The gh command group, its subcommand and their arguments, past gh's own options (`gh -R o/r pr merge`, `gh pr -R o/r merge`). */
const ghParts = (words: readonly string[]) => {
  let index = 1
  const take = () => {
    while (index < words.length && (words[index] ?? '').startsWith('-')) index += GH_GLOBAL_VALUE_OPTIONS.has(words[index] ?? '') ? 2 : 1
    index += 1
    return words[index - 1] ?? ''
  }
  const group = take()
  // `gh api` takes its endpoint and options straight after the group.
  if (group === 'api') return { group, sub: '', args: words.slice(index) }
  const sub = take()
  return { group, sub, args: words.slice(index) }
}

/** The GitHub GraphQL mutations that arm auto-merge, merge or mark ready, as the PR steps they stand for. */
const GRAPHQL_PR_STEPS: readonly { pattern: RegExp; action: 'pr-ready' | 'pr-merge'; isAuto: boolean }[] = [
  { pattern: /\benablePullRequestAutoMerge\b/, action: 'pr-merge', isAuto: true },
  { pattern: /\bmergePullRequest\b/, action: 'pr-merge', isAuto: false },
  { pattern: /\bmarkPullRequestReadyForReview\b/, action: 'pr-ready', isAuto: false },
]

/**
 * A `gh api` call as a loop action. A REST merge (`PUT .../pulls/12/merge`) or a GraphQL
 * mutation that merges, arms auto-merge or marks ready is that PR step, so the verdict and
 * QA gates hold it as they hold `gh pr merge`. A GraphQL call names the PR by node id, so
 * its number stays unknown. `text` is the whole shell line, since a query can span lines.
 */
const ghApiStep = (args: readonly string[], text: string): ShellStep | undefined => {
  const method = valuesOf(args, ['-X', '--method'])[0]?.toUpperCase()
  const merged = args.map(arg => /(?:^|\/)pulls\/(\d+)\/merge\/?$/.exec(arg)?.[1]).find(number => number !== undefined)
  if (method === 'PUT' && merged !== undefined) return { action: 'pr-merge', verb: 'gh api', pr: merged, isAuto: false, isApi: true, bodyFiles: [] }
  if (args.some(arg => arg === 'graphql' || /\/graphql$/.test(arg))) {
    const found = GRAPHQL_PR_STEPS.find(candidate => candidate.pattern.test(text))
    if (found !== undefined) return { action: found.action, verb: 'gh api', isAuto: found.isAuto, isApi: true, bodyFiles: [] }
  }
  const hasFields = hasAny(args, ['-f', '-F', '--field', '--raw-field', '--input'])
  const isMutation = args.some(arg => /^\s*mutation\b/.test(arg) || /query=\s*mutation\b/.test(arg))
  const isWrite = method !== undefined ? method !== 'GET' && method !== 'HEAD' : hasFields || isMutation
  const endpoint = args.find(arg => !arg.startsWith('-') && arg.includes('/'))
  return isWrite ? { action: 'host-write', verb: 'gh api', bodyFiles: [], ...(endpoint === undefined ? {} : { endpoint }) } : undefined
}

/** A gh command as a loop action, or undefined when it writes nothing the loop reads. `text` is the whole shell line. */
const ghStep = (words: readonly string[], text = words.join(' ')): ShellStep | undefined => {
  const { group, sub, args } = ghParts(words)
  if (group === 'api') return ghApiStep(args, text)
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

const SHELLS = new Set(['bash', 'sh', 'zsh'])

/** The script of `bash -c '...'` (or `-lc`, `-ec`), whose commands run as if typed. */
const shellScriptOf = (words: readonly string[]) => {
  const flag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word))
  return flag === -1 ? undefined : words.slice(flag + 1).join(' ')
}

/** The writes in a shell line; `text` is the outermost line, which a `bash -c` script came from. */
const stepsIn = (command: string, text: string): ShellStep[] =>
  pipelinesOf(command).flatMap(chain =>
    chain.flatMap(segment => {
      const words = commandWords(segment)
      const program = words[0] ?? ''
      if (SHELLS.has(program)) {
        const script = shellScriptOf(words)
        return script === undefined ? [] : stepsIn(script, text)
      }
      const step = program === 'git' ? gitStep(words) : program === 'gh' ? ghStep(words, text) : undefined
      return step === undefined ? [] : [step]
    }),
  )

/** Every write the loop reads in a shell line, in order. */
export const classifyShell = (command: string): ShellStep[] => stepsIn(command, command)

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
// QA modes (D69): what the gates read from a ticket

/** A ticket as the QA rules read it. */
export type QaTicket = Pick<TicketHeader, 'id' | 'status' | 'visibleChange' | 'qaResult'>

const shortCommit = (commit: string) => commit.slice(0, 7)

/** Whether people test the project's changes, on the PR or on staging (D69). */
export const isHumanQaMode = (qaMode: QaMode) => qaMode === 'human-pr' || qaMode === 'human-staging'

/**
 * Whether people test a ticket before it is done: a human QA mode, and a change a user
 * would see. A ticket with no visible change skips human QA, as it skips bot QA (D36).
 */
export const waitsOnPeople = (qaMode: QaMode, ticket: Pick<TicketHeader, 'visibleChange'>) => isHumanQaMode(qaMode) && ticket.visibleChange

/** The way out of qa without a pass: the main thread's override, on the person's word. */
export const OVERRIDE_HINT =
  'If the person says the ticket should move on anyway, the main thread moves it with ticket_move and an `override` reason, which is written in the ticket.'

/** Whether a QA pass holds at a commit: only at the commit it was given at, as a verdict does (D53). */
export const hasQaPassAt = (result: TicketHeader['qaResult'], head: string | undefined) =>
  head !== undefined && result?.result === 'passed' && result.commit === head

const RECORD_PASS = 'Once the person or a tester says it passed, record that with ticket_move (qaResult: passed)'

const qaRule = () => `To change how this project is tested, ${howToChange(SETTING.qaMode)}.`

/**
 * Why a PR may not be marked ready or merged in `human-pr` before people passed it at its
 * current commit (D69), or undefined when QA does not hold it. `ticket` is the PR's ticket,
 * undefined when no ticket names the PR.
 */
export const qaGateRefusal = (settings: LoopSettings, pr: string, doing: string, ticket: QaTicket | undefined, head: string): string | undefined => {
  if (settings.qaMode !== 'human-pr') return undefined
  const label = `PR #${pr}`
  if (ticket === undefined) {
    return `In this project people test a PR before it is ${doing} (QA mode human-pr), and no ticket names ${label}, so godmode cannot tell whether it waits on QA. Set the PR on its ticket with ticket_move (pr: ${pr}), then try again. Nothing ran. ${qaRule()}`
  }
  if (!waitsOnPeople(settings.qaMode, ticket) || hasQaPassAt(ticket.qaResult, head)) return undefined
  const result = ticket.qaResult
  if (result !== undefined && result.commit !== head) {
    return `${ticket.id}'s QA ${result.result} was recorded at commit ${shortCommit(result.commit)}, and ${label} is now at ${shortCommit(head)}: a new commit needs a new QA pass before it is ${doing}. Move ${ticket.id} to qa (ticket_move status: qa) and ask the testers to test again. ${RECORD_PASS}. Nothing ran. ${qaRule()}`
  }
  if (result?.result === 'failed') {
    return `QA failed for ${ticket.id} at ${label}'s current commit ${shortCommit(head)}, so it cannot be ${doing}. Run the fix round, have the change reviewed again, and send it back to the testers; it is ${doing} only once they pass the new commit. Nothing ran. ${qaRule()}`
  }
  if (ticket.status !== 'qa') {
    const first = settings.isQaBotFirst ? ', once the QA agent passed it,' : ''
    return `In this project people test a PR before it is ${doing} (QA mode human-pr), and ${ticket.id} is not waiting in qa yet (it is in ${ticket.status}). Move it to qa${first} with ticket_move (status: qa) and tell the testers. ${RECORD_PASS}. Nothing ran. ${qaRule()}`
  }
  return `${label} is waiting on people's QA (QA mode human-pr): ${ticket.id} has no pass recorded at its current commit ${shortCommit(head)}, so it cannot be ${doing}. ${RECORD_PASS}; a fail is recorded with qaResult: failed and starts a fix round. Nothing ran. ${qaRule()}`
}

/**
 * Why a move needs a QA pass it lacks, or undefined (D69). A ticket leaves `qa` only with a
 * pass at its PR's current commit, whatever the mode (build default); in a human mode a
 * visible change is not done without one either. `head` is undefined when the ticket names
 * no PR.
 */
export const qaMoveRefusal = (qaMode: QaMode, ticket: QaTicket, result: TicketHeader['qaResult'], head: string | undefined) => {
  if (hasQaPassAt(result, head)) return undefined
  const why =
    ticket.status === 'qa'
      ? `${ticket.id} is waiting in qa, and leaves it only with a QA pass recorded at its PR's current commit.`
      : `${ticket.id} is a visible change in QA mode ${qaMode}, so it is done only once people passed it; it waits in qa${qaMode === 'human-staging' ? ' after the merge' : ''} until then.`
  const detail =
    head === undefined
      ? ` ${ticket.id} names no PR or branch, so there is no commit to hold a pass: set its PR with ticket_move (pr). ${OVERRIDE_HINT}`
      : result !== undefined && result.commit !== head
        ? ` Its last QA result (${result.result}) was recorded at ${shortCommit(result.commit)}, and the PR is now at ${shortCommit(head)}: a new commit needs a new pass.`
        : ''
  const fail = qaMode === 'human-staging' ? '' : ' A fail is recorded with qaResult: failed and sends it back for a fix round.'
  return `${why}${detail} ${RECORD_PASS}.${fail} Nothing changed.`
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
    const { group, sub } = ghParts(words)
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

/** The PR actions the PM itself takes: relaying a verdict, marking ready, merging on the person's go; never a raw API call. */
const isPmLoopAction = (words: readonly string[]) => {
  const step = words[0] === 'gh' ? ghStep(words) : undefined
  return step !== undefined && step.isApi !== true && ['pr-comment', 'pr-ready', 'pr-merge'].includes(step.action)
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

export type MainThreadCall = { tool: string; command?: unknown; run_in_background?: unknown; file_path?: unknown }

/** godmode's own folders the PM reads its role and rules from: under the plugin's root, never a project's. */
const OWN_FOLDERS: readonly string[] = ['agents', 'rules']

/** Whether a read is of godmode's own role or rule files, which the PM may read beyond the per-prompt limit. */
const isOwnFile = (path: unknown, pluginRoot: string | undefined) =>
  typeof path === 'string' && pluginRoot !== undefined && OWN_FOLDERS.some(folder => isInside(path, `${pluginRoot}/${folder}`))

/** What the main thread may do, or why not. */
export type MainThreadVerdict = { isAllowed: true; isRead?: boolean } | { isAllowed: false; reason: string }

/**
 * Whether the main thread may make a call (D63): talking, the ticket tools, dispatching
 * agents and shells, quick status checks, and a couple of reads per prompt. Reading
 * godmode's own role and rules (under `pluginRoot`) is the PM's job, so it never counts.
 */
export const mainThreadVerdict = (call: MainThreadCall, settings: LoopSettings, readsThisPrompt: number, pluginRoot?: string): MainThreadVerdict => {
  const { tool } = call
  if (MAIN_THREAD_TOOLS.has(tool) || tool.startsWith('mcp__godmode__') || settings.mainThreadTools.includes(tool)) return { isAllowed: true }
  const refuse = (what: string, setting: string = SETTING.thinMainThread): MainThreadVerdict => ({
    isAllowed: false,
    reason: `godmode keeps the main thread thin: ${what} is work for an agent, not the PM. Dispatch a researcher, a dev agent or a background shell to do it, and keep this thread for talking, tickets and dispatch. If the person asked for it, do it that way now: their ask is never a reason to refuse. To loosen the rule, ${howToChange(setting)}.`,
  })
  if (tool === 'Read') {
    if (isOwnFile(call.file_path, pluginRoot)) return { isAllowed: true }
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

/** The tier of an alias or a full model id; undefined for a model godmode cannot rank. */
export const tierOf = (model: string): ModelTier | undefined => {
  const name = model.toLowerCase()
  return (['fable', 'opus', 'sonnet', 'haiku'] as const).find(tier => name.includes(tier))
}

/**
 * The model a role's spawn runs on (D39, D62, D74): the role's model is a floor. A request
 * at or above it stands, up to Fable (the PM may pick Opus for a hard ticket); one below,
 * or none, takes the floor. A model godmode cannot rank takes the floor too, as it could
 * sit below it or above Fable.
 */
export const spawnModel = (
  requested: string | undefined,
  role: AgentRole,
  note?: { shared?: Pick<SharedNote, 'minimumModels'>; personal?: Pick<PersonalNote, 'models'> },
): string => {
  const floor = effectiveModel(role, note)
  if (requested === undefined || requested === '' || requested === 'inherit') return floor
  const tier = tierOf(requested)
  if (tier === undefined) return floor
  return MODEL_RANK[tier] < MODEL_RANK[floor] ? floor : requested
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
