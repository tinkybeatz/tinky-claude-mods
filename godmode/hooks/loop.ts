import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, ToolCallInput, ToolCallResult, ToolSpec } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, PendingReview } from '../types'
import { chooseHost, HostError, hostFor, prNumberOf } from './host'
import type { GitHost, HostKind, PullRequest } from './host'
import {
  ACTION_WORDS,
  attributionIn,
  carriesText,
  classifyShell,
  howToChange,
  isInside,
  mainThreadVerdict,
  normalisePath,
  permissionKey,
  relativeTo,
  roleOf,
  SCRATCH_FOLDERS,
  SETTING,
  settingsOf,
  spawnModel,
  strictest,
  ticketIn,
} from './rules'
import type { Level, LoopSettings, ShellStep } from './rules'
import { readNote } from './storage'
import type { Answer, NoteLookup, Project } from './storage'
import { backendFor, slugOf, TICKET_STATUSES, trackerOf } from './tickets'
import type { TicketBackend } from './tickets'

/*
 * The loop hooks of Step 7 (D35-D38, D47, D48, D52, D53, D58, D62, D63, D66), applied to
 * the session. The rules themselves are in `rules.ts`. Every helper here that takes `$`
 * is a function declaration: the engine follows `$` past an import only into those.
 */

// The same state as `register.tsx`'s atoms: `validate` reads a state source only from this file.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)
const pendingReviews = atom({ plugin: 'godmode', key: 'pendingReviews' } as const, [] as PendingReview[])
const mainThreadReads = atom({ plugin: 'godmode', key: 'mainThreadReads' } as const, 0)

type FoundNote = Extract<NoteLookup, { status: 'found' }>

/** What the loop hooks know of the project while godmode is on: its note and settings. */
export type LoopContext = {
  project: Project
  note: FoundNote
  /** Shared answers, then personal ones over them (D61). */
  answers: Record<string, Answer>
  settings: LoopSettings
  /** The git host, chosen once per context. */
  host?: { host: GitHost; kind: HostKind } | { error: string }
}

/**
 * What the hooks keep between calls, for one load of the module. Every tool call passes
 * the gate, so the note and the open PRs are read again only when their copy is stale.
 */
export type LoopCache = {
  context?: { at: number; value?: LoopContext }
  sweep?: { at: number; prs: PullRequest[] }
  /** The person's own login on the host, once looked up; null when it could not be. */
  login?: string | null
}

/** How long a read of the note stays fresh. `/godmode` reads it again at once. */
export const CONTEXT_TTL_MS = 15_000

const RUNNING_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const short = (commit: string) => commit.slice(0, 7)

const firstLine = (text: string, length = 120) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > length ? `${line.slice(0, length - 3)}...` : line
}

/** The note's settings, read again once stale. Undefined while there is no readable note (setup mode). */
export async function loopContextOf($: EngineInterface, cache: LoopCache): Promise<LoopContext | undefined> {
  const now = await $.clock.now()
  if (cache.context !== undefined && now - cache.context.at < CONTEXT_TTL_MS) return cache.context.value
  const found = await readNote($).catch(() => undefined)
  let value: LoopContext | undefined
  if (found?.status === 'found') {
    const answers = { ...found.shared.answers, ...(found.personal?.answers ?? {}) }
    value = { project: found.project, note: found, answers, settings: settingsOf(answers) }
  }
  cache.context = { at: now, value }
  return value
}

/** The project's git host (D54, D55), or why there is none to use. */
async function hostOf($: EngineInterface, context: LoopContext) {
  if (context.host !== undefined) return context.host
  try {
    const choice = await chooseHost($, context.project, context.answers)
    context.host = { host: hostFor($, choice.kind, context.project, context.note.dir), kind: choice.kind }
  } catch (error) {
    context.host = { error: messageOf(error) }
  }
  return context.host
}

/** The open PRs and their files (D47); a copy younger than the refresh setting serves unless `isFresh`. */
export async function openPullRequests($: EngineInterface, cache: LoopCache, context: LoopContext, isFresh = false) {
  const now = await $.clock.now()
  if (!isFresh && cache.sweep !== undefined && now - cache.sweep.at < context.settings.contentionRefreshMs) return cache.sweep.prs
  const choice = await hostOf($, context)
  if ('error' in choice) throw new HostError(choice.error)
  const prs = await choice.host.listOpen()
  cache.sweep = { at: now, prs }
  return prs
}

/** The person's own login on GitHub, so Free can tell their PRs from others' (D18). */
async function ownLogin($: EngineInterface, cache: LoopCache, context: LoopContext) {
  if (cache.login !== undefined) return cache.login ?? undefined
  const result = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { cwd: context.project.root }).catch(() => undefined)
  const login = result?.exitCode === 0 ? result.stdout.trim() : ''
  cache.login = login === '' ? null : login
  return cache.login ?? undefined
}

/** Whether a PR is someone else's: only when both its author and the person's login are known. */
async function isOthersPr($: EngineInterface, cache: LoopCache, context: LoopContext, pr: string) {
  const choice = await hostOf($, context)
  if ('error' in choice || choice.kind !== 'github') return false
  const find = (prs: readonly PullRequest[]) => prs.find(candidate => candidate.ref === pr || candidate.branch === pr)
  const found = find(await openPullRequests($, cache, context).catch(() => [])) ?? find(await openPullRequests($, cache, context, true).catch(() => []))
  const me = await ownLogin($, cache, context)
  return found !== undefined && found.author !== '' && me !== undefined && found.author !== me
}

// ---------------------------------------------------------------------------
// Review verdicts (D53)

export type Verdict = 'clean' | 'change-request' | 'blocker'

export const VERDICTS: readonly Verdict[] = ['clean', 'change-request', 'blocker']

/** A verdict counts only at the commit it was given at (D53). */
export type VerdictRecord = { verdict: Verdict; headCommit: string; at: string; agentId?: string; summary?: string }

/** Verdicts outlive the session, so a resumed loop still knows what was reviewed; kept per project. */
const verdictsKey = (project: Project) => `verdicts:${project.id}`

const isVerdictRecord = (value: unknown): value is VerdictRecord =>
  typeof value === 'object' &&
  value !== null &&
  VERDICTS.includes((value as VerdictRecord).verdict) &&
  typeof (value as VerdictRecord).headCommit === 'string'

export async function readVerdicts($: EngineInterface, project: Project): Promise<Record<string, VerdictRecord>> {
  const value = await $.store.get(verdictsKey(project))
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, VerdictRecord] => isVerdictRecord(entry[1])))
}

/** A PR named by number, link or `#12`, as the host takes it. */
const prRefOf = (value: unknown) => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  return text === '' ? undefined : (prNumberOf(text) ?? text.replace(/^#/, ''))
}

/** The `review_verdict` tool: a reviewer records its verdict at the PR's current commit. */
export const REVIEW_VERDICT_TOOL: ToolSpec & { name: 'review_verdict' } = {
  name: 'review_verdict',
  description:
    'Record your review verdict on a PR, at its current head commit: clean, change-request or blocker. Only a reviewer agent records one. A PR is marked ready or merged only with a clean verdict at its current commit, so a new commit needs a new review.',
  inputSchema: {
    type: 'object',
    properties: {
      pr: { type: 'string', description: 'The PR number (or the branch, on a project with no PR host).' },
      verdict: { type: 'string', enum: [...VERDICTS] },
      summary: { type: 'string', description: 'One or two lines: why this verdict.' },
    },
    required: ['pr', 'verdict'],
  },
  isDeferred: false,
}

/** Serves `review_verdict`: checks who calls, reads the PR's head commit, records the verdict there. */
export async function serveReviewVerdict($: EngineInterface, cache: LoopCache, e: { agentId?: string } & Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so it records no verdict. The person switches it on with `/godmode`.' }
  const context = await loopContextOf($, cache)
  if (context === undefined) return { deny: 'godmode is not set up in this project yet, so it has nowhere to record a verdict.' }
  const caller = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
  if (context.settings.verdictFromReviewerOnly && caller?.role !== 'reviewer') {
    return {
      deny: `Only a reviewer agent records a verdict, so a PR is never cleared by the agent that wrote it or by the PM. Dispatch a godmode:reviewer on the PR. To change the rule, ${howToChange(SETTING.verdictFromReviewerOnly)}.`,
    }
  }
  const pr = prRefOf(e.pr)
  if (pr === undefined) return { deny: '`pr` is required: the PR number.' }
  const verdict = VERDICTS.find(candidate => candidate === e.verdict)
  if (verdict === undefined) return { deny: `\`${String(e.verdict)}\` is not a verdict; use one of ${VERDICTS.join(', ')}.` }
  const choice = await hostOf($, context)
  if ('error' in choice) return { deny: `godmode could not reach the git host to read PR #${pr}'s head commit: ${choice.error}` }
  let headCommit: string
  try {
    headCommit = await choice.host.headCommit(pr)
  } catch (error) {
    return { deny: `godmode could not read PR #${pr}'s head commit (${messageOf(error)}), so no verdict was recorded.` }
  }
  const summary = typeof e.summary === 'string' && e.summary.trim() !== '' ? e.summary.trim() : undefined
  const record: VerdictRecord = { verdict, headCommit, at: new Date(await $.clock.now()).toISOString(), agentId: e.agentId, summary }
  await $.store.set(verdictsKey(context.project), { ...(await readVerdicts($, context.project)), [pr]: record })
  const then = verdict === 'clean' ? ' It may now be marked ready; a new commit needs a new review.' : ' The PR stays a draft until a fix round and a clean review.'
  return { result: `Recorded ${verdict} for PR #${pr} at ${short(headCommit)}.${then}` }
}

/** Why a PR may not be marked ready or merged yet, or undefined when its verdict clears it (D53). */
async function verdictRefusal($: EngineInterface, context: LoopContext, step: ShellStep) {
  const doing = step.action === 'pr-ready' ? 'marked ready' : 'merged'
  if (step.pr === undefined) {
    return `Name the PR by number (\`${step.verb} 12\`) so godmode can check its review verdict before it is ${doing}. Nothing ran.`
  }
  const label = `PR #${step.pr}`
  const choice = await hostOf($, context)
  if ('error' in choice) return `godmode could not reach the git host to check ${label}'s review (${choice.error}). Nothing ran.`
  let head: string
  try {
    head = await choice.host.headCommit(step.pr)
  } catch (error) {
    return `godmode could not read ${label}'s head commit (${messageOf(error)}), so it cannot check its review verdict. Nothing ran; try again once the host answers.`
  }
  const record = (await readVerdicts($, context.project))[step.pr]
  const rule = `To change the rule, ${howToChange(SETTING.mergeGate)}.`
  if (record === undefined) {
    return `${label} has no review verdict, so it cannot be ${doing}. Dispatch a godmode:reviewer on it; the reviewer records its verdict with review_verdict. ${rule}`
  }
  if (record.headCommit !== head) {
    return `${label}'s last verdict (${record.verdict}) was given at commit ${short(record.headCommit)}, and the PR is now at ${short(head)}. Every new commit is reviewed again: dispatch a godmode:reviewer on the new commit. ${rule}`
  }
  if (record.verdict !== 'clean') {
    return `${label}'s verdict at its current commit is ${record.verdict}, not clean, so it cannot be ${doing}. Send the findings to the dev agent for a fix round, then review again. ${rule}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The tool-call gate

/** What the gate decided: a refusal, or what `afterToolCall` needs once the call ran. */
export type ToolDecision =
  | { deny: string }
  | { deny?: undefined; isMain: boolean; agentId?: string; agent?: DispatchedAgent; opensPr: boolean }

const who = (agentId: string | undefined, agent: DispatchedAgent | undefined) =>
  agentId === undefined ? 'The PM (main thread)' : `A ${agent?.role ?? ''}${agent?.role === undefined ? '' : ' '}agent (${agentId})`

/** The texts a commit or PR command carries: the command line and any file it reads its body from. */
async function textsOf($: EngineInterface, command: string, step: ShellStep) {
  const texts = [command]
  for (const path of step.bodyFiles) {
    if (!path.startsWith('/')) continue
    const text = await $.fs.read(path).catch(() => undefined)
    if (text !== undefined) texts.push(text)
  }
  return texts
}

/** The hard rules a shell step meets before any preset: drafts, attribution, auto-merge, the verdict gate. */
async function shellRefusal($: EngineInterface, context: LoopContext, step: ShellStep, command: string) {
  const { settings } = context
  if (step.action === 'pr-open' && settings.isDraftsOnly && step.isDraft !== true) {
    return `godmode opens every PR as a draft: add \`--draft\` to \`gh pr create\` and run it again. A PR leaves draft only once a clean review is recorded at its current commit. To change the rule, ${howToChange(SETTING.draftsOnly)}.`
  }
  if (!settings.isAttributionAllowed && carriesText(step)) {
    for (const text of await textsOf($, command, step)) {
      const line = attributionIn(text)
      if (line !== undefined) {
        const what = step.verb === 'git commit' ? 'commit message' : 'PR text'
        return `This project's setup turns AI attribution off, and the ${what} carries \`${line}\`. Remove that line and run it again. To allow attribution, ${howToChange(SETTING.attribution)}.`
      }
    }
  }
  if (step.action === 'pr-merge' && step.isAuto === true && step.isUndo !== true && !settings.isAutoMergeOn) {
    return `Auto-merge is off: a PR is merged only once the person says so. Tell them the PR is ready for their go instead. To arm auto-merge on its own, ${howToChange(SETTING.autoMerge)}.`
  }
  if ((step.action === 'pr-ready' || step.action === 'pr-merge') && step.isUndo !== true && settings.isMergeGateOn) {
    return verdictRefusal($, context, step)
  }
  return undefined
}

/** Why a dev agent's edit is refused: outside its worktree (D38), or a file another open PR holds (D48). */
async function devEditRefusal($: EngineInterface, cache: LoopCache, context: LoopContext, agent: DispatchedAgent, path: string) {
  const { settings } = context
  if (agent.worktree === undefined) return undefined
  const isScratch = SCRATCH_FOLDERS.some(folder => isInside(path, folder))
  if (settings.isWorktreeGuardOn && !isInside(path, agent.worktree) && !isScratch) {
    const copy = isInside(path, context.project.root) ? ` (here, ${normalisePath(`${agent.worktree}/${relativeTo(path, context.project.root)}`)})` : ''
    return `You are a dev agent working in your worktree ${agent.worktree}, and ${path} is outside it. Edit the file inside your worktree${copy} instead. To change the rule, ${howToChange(SETTING.worktreeGuard)}.`
  }
  if (!settings.isContentionOn || !isInside(path, agent.worktree)) return undefined
  let prs: readonly PullRequest[]
  try {
    prs = await openPullRequests($, cache, context)
  } catch (error) {
    if (cache.sweep === undefined) {
      return `godmode could not list the open PRs to check that no other PR holds ${path} (${messageOf(error)}). Nothing was edited; try again shortly. To change the rule, ${howToChange(SETTING.contention)}.`
    }
    prs = cache.sweep.prs
  }
  const file = relativeTo(path, agent.worktree)
  const holder = prs.find(pr => pr.branch !== agent.branch && pr.files.includes(file))
  if (holder === undefined) return undefined
  return `\`${file}\` is held by open PR #${holder.ref} (${holder.title}${holder.author === '' ? '' : `, by ${holder.author}`}), so editing it now could collide with that work. Stop and report this to the PM; do not work around it. The file frees up when that PR merges or closes. To change the rule, ${howToChange(SETTING.contention)}.`
}

/** Asks the person directly (D66): never Claude Code's own permission check, which auto mode could settle alone. */
async function askPerson($: EngineInterface, question: string): Promise<'yes' | 'no' | 'unasked'> {
  try {
    const answer = await $.ui.ask(question, { options: ['Allow', 'Deny'], header: 'godmode' })
    return answer === 'Allow' ? 'yes' : 'no'
  } catch {
    return 'unasked'
  }
}

/**
 * The gate every tool call passes while godmode is on: the thin main thread (D63), the
 * dev agent's worktree and held files (D38, D48), drafts, attribution and the verdict
 * gate (D15, D53), then the permission preset (D18), whose "ask" asks the person (D66).
 */
export async function decideToolCall($: EngineInterface, cache: LoopCache, e: ToolCallInput): Promise<ToolDecision> {
  const isMain = e.agentId === undefined
  if ((await read($, isOn)) !== true) return { isMain, opensPr: false }
  const input = e as unknown as Record<string, unknown> & { tool: string }
  const context = await loopContextOf($, cache)
  const settings = context?.settings ?? settingsOf({})
  const agent = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
  const allowed: ToolDecision = { isMain, agentId: e.agentId, agent, opensPr: false }

  if (isMain && settings.isThinMainThread && (await read($, mode)) === 'coding') {
    const verdict = mainThreadVerdict(input, settings, await read($, mainThreadReads))
    if (!verdict.isAllowed) return { deny: verdict.reason }
    if (verdict.isRead === true) await update($, mainThreadReads, count => count + 1)
  }
  // No readable note (setup mode): the presets and loop rules are not known yet.
  if (context === undefined) return allowed

  const asks: { level: Level; what: string; key: string }[] = []
  let excerpt = ''
  if (EDIT_TOOLS.includes(input.tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (path !== undefined && agent?.role === 'dev') {
      const refusal = await devEditRefusal($, cache, context, agent, path)
      if (refusal !== undefined) return { deny: refusal }
    }
    excerpt = path ?? input.tool
    asks.push({ level: settings.levels.edit, what: ACTION_WORDS.edit, key: permissionKey('edit') })
  }
  if (input.tool === 'Bash' && typeof input.command === 'string') {
    const command = input.command
    excerpt = firstLine(command)
    for (const step of classifyShell(command)) {
      const refusal = await shellRefusal($, context, step, command)
      if (refusal !== undefined) return { deny: refusal }
      let level = settings.levels[step.action]
      let what = ACTION_WORDS[step.action]
      if (step.pr !== undefined && step.action !== 'pr-open' && (await isOthersPr($, cache, context, step.pr))) {
        level = strictest([level, settings.othersPrs])
        what = `${what} (PR #${step.pr} is someone else's)`
      }
      asks.push({ level, what, key: permissionKey(step.action) })
      if (step.action === 'pr-open') allowed.opensPr = true
    }
  }

  const level = strictest(asks.map(ask => ask.level))
  if (level === 'allow') return allowed
  const gated = asks.filter(ask => ask.level === level)
  const whats = [...new Set(gated.map(ask => ask.what))].join(' and ')
  const presetLine = `the ${settings.preset} permission preset${settings.presetNote === undefined ? '' : ` (${settings.presetNote})`}`
  if (level === 'never') {
    return {
      deny: `${presetLine} never allows this: ${whats}. Nothing ran. To change it, ${howToChange(gated[0]?.key ?? SETTING.preset)}.`,
    }
  }
  const answer = await askPerson($, `godmode: ${who(e.agentId, agent)} wants to ${whats}: \`${excerpt}\`. Allow it?`)
  if (answer === 'yes') return allowed
  if (answer === 'no') return { deny: `The person said no to this (${whats}). Nothing ran. Do not retry it; say what you needed it for.` }
  return {
    deny: `Under ${presetLine}, this needs the person's yes (${whats}), and godmode could not ask them: nobody to ask in a headless run, or the question was dismissed. Nothing ran. Ask them in your reply, or ${howToChange(SETTING.preset)}.`,
  }
}

/** A tool result's text as the model would read it. */
const outputOf = (result: ToolCallResult) => {
  if (result.deny !== undefined) return ''
  if (typeof result.text === 'string') return result.text
  const value = result.result as { stdout?: unknown } | undefined
  return typeof value?.stdout === 'string' ? value.stdout : ''
}

/** The tickets backend, or undefined where it cannot be reached; for best-effort bookkeeping. */
function backendOrNothing($: EngineInterface, context: LoopContext): TicketBackend | undefined {
  try {
    return backendFor($, trackerOf(context.note.shared.answers), context.note.dir)
  } catch {
    return undefined
  }
}

/** Takes the draft PRs waiting for a review start, and says what the PM does next (D35). */
export async function takePendingReviews($: EngineInterface) {
  const pending = await read($, pendingReviews)
  if (pending.length === 0) return undefined
  await update($, pendingReviews, () => [])
  const lines = pending.map(
    review =>
      `- PR #${review.pr}${review.url === undefined ? '' : ` (${review.url})`}${review.ticket === undefined ? '' : ` for ${review.ticket}`}, opened by dev agent ${review.agentId}`,
  )
  return [
    `godmode: ${pending.length === 1 ? 'a dev agent opened a draft PR' : 'dev agents opened draft PRs'}. Start each review now, without waiting to be asked: dispatch one godmode:reviewer agent per PR.`,
    ...lines,
    'The reviewer records its verdict with review_verdict. A PR is marked ready or merged only with a clean verdict at its current commit.',
  ].join('\n')
}

/**
 * What the gate adds once a call ran: a dev agent's new draft PR is queued for review (D35);
 * a main-thread result carries the queue to the PM.
 */
export async function afterToolCall(
  $: EngineInterface,
  cache: LoopCache,
  decision: ToolDecision,
  result: ToolCallResult,
): Promise<ToolCallResult> {
  if (decision.deny !== undefined || result.deny !== undefined || result.isError === true) return result
  if ((await read($, isOn)) !== true) return result
  const context = await loopContextOf($, cache)
  const extra: string[] = []
  const { agent, agentId } = decision
  if (decision.opensPr && agent?.role === 'dev' && agentId !== undefined && context?.settings.isReviewStartOn === true) {
    const url = /https?:\/\/\S+?\/pull\/\d+/.exec(outputOf(result))?.[0]
    const pr = url === undefined ? undefined : prNumberOf(url)
    if (pr !== undefined) {
      const review: PendingReview = { pr, url, agentId, ticket: agent.ticket }
      await update($, pendingReviews, queue => [...queue.filter(entry => entry.pr !== pr), review])
      if (agent.ticket !== undefined) await backendOrNothing($, context)?.move(agent.ticket, { pr: url, status: 'review' }).catch(() => undefined)
      extra.push(`godmode recorded draft PR #${pr} and tells the PM to start its review. Your part is done: stop here and report the PR link.`)
    }
  }
  if (decision.isMain) {
    const told = await takePendingReviews($)
    if (told !== undefined) extra.push(told)
  }
  return extra.length === 0 ? result : { ...result, context: [...(result.context ?? []), ...extra] }
}

// ---------------------------------------------------------------------------
// Dispatch (D52, D58, D62) and the dev brief (D38, D47)

export type SpawnPlan = { deny: string } | { deny?: undefined; input: AgentSpawnInput; record?: DispatchedAgent }

const parentOf = (path: string) => normalisePath(path).replace(/\/[^/]*$/, '') || '/'
const baseNameOf = (path: string) => normalisePath(path).split('/').at(-1) ?? 'repo'

/** A ticket's worktree: under the `worktreeFolder` setting, else beside the repo in `<repo>-worktrees/`. */
export const worktreePathOf = (project: Project, settings: LoopSettings, ticket: string) => {
  const folder =
    settings.worktreeFolder === undefined
      ? `${parentOf(project.root)}/${baseNameOf(project.root)}-worktrees`
      : settings.worktreeFolder.startsWith('/')
        ? settings.worktreeFolder
        : `${project.root}/${settings.worktreeFolder}`
  return normalisePath(`${folder}/${ticket}`)
}

/** The ticket's worktree, made on its branch when it is not there yet; a string says why it could not be. */
async function ensureWorktree($: EngineInterface, project: Project, settings: LoopSettings, path: string, branch: string) {
  if (await $.fs.exists(path)) return undefined
  const git = (args: string[]) => $.process.run(['git', ...args], { cwd: project.root })
  const hasBranch = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
  let base = settings.baseBranch
  if (!hasBranch && base === undefined) {
    const origin = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    base = origin.exitCode === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim() : 'HEAD'
  }
  const args = hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base ?? 'HEAD']
  const made = await git(args)
  if (made.exitCode === 0) return undefined
  return `godmode could not make the ticket's worktree (\`git ${args.join(' ')}\`: ${firstLine(made.stderr || made.stdout, 300)}). The dev agent did not start; fix that, then dispatch again.`
}

const HELD_LIST_LIMIT = 200

/** What godmode adds to a dev agent's brief: its ticket, worktree, and the files other PRs hold (D38, D47). */
export const devBrief = (ticket: { id: string; title: string }, worktree: string, branch: string, held: readonly PullRequest[] | undefined) => {
  const lines = [
    '---',
    'From godmode (added to this brief by the mod):',
    `- Ticket: ${ticket.id}, "${ticket.title}".`,
    `- Your worktree: ${worktree}, on branch ${branch}. Work, run commands and commit only there: an edit outside it is refused.`,
  ]
  if (held !== undefined) {
    const files = held.flatMap(pr => pr.files.map(file => `  - ${file} (PR #${pr.ref}${pr.author === '' ? '' : `, ${pr.author}`})`))
    if (files.length === 0) {
      lines.push('- No other open PR holds a file right now. If one opens while you work, an edit to a file it holds is refused: stop and report then.')
    } else {
      lines.push('- Files other open PRs hold. Do not edit them; an edit to one is refused. If the ticket needs one, stop and report to the PM:')
      lines.push(...files.slice(0, HELD_LIST_LIMIT))
      if (files.length > HELD_LIST_LIMIT) lines.push(`  - ... and ${files.length - HELD_LIST_LIMIT} more`)
    }
  }
  lines.push(
    '- When the work is done, push the branch and open the PR as a draft (`gh pr create --draft`), then stop and report its link: the review starts from there.',
  )
  return lines.join('\n')
}

/** A dev agent's dispatch: a ready ticket (D52), its worktree, and the contention sweep in its brief (D47). */
async function planDevSpawn($: EngineInterface, cache: LoopCache, context: LoopContext, e: AgentSpawnInput): Promise<SpawnPlan> {
  const { settings, project } = context
  let backend: TicketBackend
  try {
    backend = backendFor($, trackerOf(context.note.shared.answers), context.note.dir)
  } catch (error) {
    return { deny: `godmode cannot read the tickets to check this dispatch: ${messageOf(error)}` }
  }
  const id = ticketIn(e.prompt, backend.tracker === 'none')
  if (id === undefined) {
    return { deny: 'A dev agent builds one ticket, and this brief names none. Name the ticket (e.g. T-3) in the brief, then dispatch again.' }
  }
  const ticket = (await backend.list({ statuses: TICKET_STATUSES })).find(header => header.id.toUpperCase() === id)
  if (ticket === undefined) return { deny: `The brief names ${id}, and there is no such ticket. File it first, or fix the id.` }
  if (ticket.status === 'done') return { deny: `${ticket.id} is done; a dev agent does not start on a done ticket.` }
  if (settings.requiresReadyTicket && !ticket.ready) {
    return {
      deny: `${ticket.id} is not marked ready: a dev agent starts only on a ticket the person said go for. Once they have, mark it with ticket_move (ready: true) and dispatch again. To change the rule, ${howToChange(SETTING.requireReadyTicket)}.`,
    }
  }
  const branch = ticket.branch ?? `${settings.branchPrefix}${ticket.id.toLowerCase()}-${slugOf(ticket.title)}`
  const worktree = worktreePathOf(project, settings, ticket.id)
  const refusal = await ensureWorktree($, project, settings, worktree, branch)
  if (refusal !== undefined) return { deny: refusal }
  if (ticket.branch === undefined) await backend.move(ticket.id, { branch }).catch(() => undefined)

  let held: PullRequest[] | undefined
  if (settings.isContentionOn) {
    try {
      held = (await openPullRequests($, cache, context, true)).filter(pr => pr.branch !== branch && pr.files.length > 0)
    } catch (error) {
      return {
        deny: `godmode could not list the open PRs and their files (${messageOf(error)}), so the dev agent did not start: without that list it could edit a file another PR holds. Try again once the host answers. To change the rule, ${howToChange(SETTING.contention)}.`,
      }
    }
  }
  return {
    input: { ...e, prompt: `${e.prompt}\n\n${devBrief(ticket, worktree, branch, held)}`, cwd: worktree },
    record: { role: 'dev', ticket: ticket.id, worktree, branch },
  }
}

/**
 * Every spawn while godmode is on: the agent cap (D58), the role's model floor (D62), and
 * for a dev agent its ticket, worktree and brief (D38, D47, D52).
 */
export async function planSpawn($: EngineInterface, cache: LoopCache, e: AgentSpawnInput): Promise<SpawnPlan> {
  if ((await read($, isOn)) !== true) return { input: e }
  const context = await loopContextOf($, cache)
  const settings = context?.settings ?? settingsOf({})
  const running = (await $.agent.list()).filter(agent => RUNNING_STATUSES.includes(agent.status))
  if (running.length >= settings.agentCap) {
    const names = running.map(agent => agent.description || agent.type).slice(0, 8).join('; ')
    return {
      deny: `godmode runs at most ${settings.agentCap} agents at once, and ${running.length} are running (${names}). Wait for one to finish or stop one, then dispatch again. To change the cap, ${howToChange(SETTING.agentCap)}.`,
    }
  }
  const role = roleOf(e.subagentType)
  if (role === undefined) return { input: e }
  // A workflow's agent can only be refused, not rewritten.
  if (e.workflow !== undefined) return { input: e, record: { role } }
  const model = spawnModel(e.model, role, context?.note)
  const input = model === e.model ? e : { ...e, model }
  if (role !== 'dev' || context === undefined || (await read($, mode)) !== 'coding') return { input, record: { role } }
  return planDevSpawn($, cache, context, input)
}

/** Remembers a started agent's role, so its tool calls meet its role's rules. */
export async function recordAgent($: EngineInterface, agentId: string, record: DispatchedAgent) {
  await update($, agents, known => ({ ...known, [agentId]: record }))
}
