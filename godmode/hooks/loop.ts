import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, ToolCallInput, ToolCallResult, ToolSpec } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, IndicatorStyle, PendingReview, Unlock } from '../types'
import { chooseHost, HostError, hostFor, prNumberOf } from './host'
import type { GitHost, HostKind, PullRequest } from './host'
import {
  ASKS,
  attributionIn,
  carriesText,
  classifyShell,
  isHumanQaMode,
  isInside,
  mainThreadVerdict,
  normalisePath,
  OVERRIDE_HINT,
  qaMoveRefusal,
  qaPassState,
  relativeTo,
  riskyRefusal,
  roleOf,
  SCRATCH_FOLDERS,
  settingsOf,
  spawnModel,
  targetKey,
  ticketIn,
  waitsOnPeople,
} from './rules'
import type { AskAction, LoopSettings, Risky, ShellStep } from './rules'
import { approversOf } from './code-review'
import { jiraOwnership, jiraStatusOf } from './jira'
import { checkMergeConditions, heldLine, missingLine, readPrView, ticketKeyIn } from './merge-check'
import type { ConditionCheck, PrView } from './merge-check'
import { conditionWords } from './project-rules'
import { qaSignalsOf } from './role'
import { readNote } from './storage'
import type { Answer, NoteLookup, Project } from './storage'
import { indicatorOf } from './indicator'
import { backendFor, normaliseId, openTicketsOf, slugOf, TICKET_STATUSES, TicketError, trackerOf } from './tickets'
import type { MoveCheck, QaResult, TicketBackend, TicketChange, TicketHeader } from './tickets'

/*
 * The loop hooks of Step 7 (D35-D38, D47, D48, D52, D53, D58, D62, D63, D66) and the QA
 * mode gates of Step 13 (D69), applied to the session. The rules themselves are in `rules.ts`. Every helper here that takes `$`
 * is a function declaration: the engine follows `$` past an import only into those.
 */

// The same state as `register.tsx`'s atoms: `validate` reads a state source only from this file.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)
const pendingReviews = atom({ plugin: 'godmode', key: 'pendingReviews' } as const, [] as PendingReview[])
const mainThreadReads = atom({ plugin: 'godmode', key: 'mainThreadReads' } as const, 0)
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'mode' as IndicatorStyle)
const unlocks = atom({ plugin: 'godmode', key: 'unlocks' } as const, [] as Unlock[])

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
  /** The person's own login on the host, once read; a failed read is never kept (D78). */
  login?: string
}

/** How long a read of the note stays fresh. `/godmode` reads it again at once. */
export const CONTEXT_TTL_MS = 15_000

export const RUNNING_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

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
    // A change-setup may have changed the on-indicator's style (D68).
    const style = indicatorOf(found.personal?.answers.indicator)
    if ((await read($, indicator)) !== style) await update($, indicator, () => style)
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

/**
 * The person's own login on GitHub, read live (D78): a read that fails is tried again once,
 * and a failure is never kept, so the next call reads again. A login read is kept for this load.
 */
export async function ownLogin($: EngineInterface, cache: LoopCache, context: LoopContext) {
  if (cache.login !== undefined) return cache.login
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await $.process.run(['gh', 'api', 'user', '--jq', '.login'], { cwd: context.project.root }).catch(() => undefined)
    const login = result?.exitCode === 0 ? result.stdout.trim() : ''
    if (login !== '') {
      cache.login = login
      return login
    }
  }
  return undefined
}

/** Whose a PR is, read live: the person's own (or godmode's, which runs as the person), someone else's, or unknown with why. */
export type PrOwner = { kind: 'mine' } | { kind: 'others'; author: string } | { kind: 'unknown'; reason: string }

/**
 * Who opened a PR (D78): its author against the person's own login, both read live. A PR
 * godmode opened is the person's too, as godmode works through their `gh`. Only GitHub has PRs to own.
 */
export async function prOwnerOf($: EngineInterface, cache: LoopCache, context: LoopContext, pr: string, view?: PrView): Promise<PrOwner> {
  const choice = await hostOf($, context)
  if ('error' in choice || choice.kind !== 'github') return { kind: 'mine' }
  const find = (prs: readonly PullRequest[]) => prs.find(candidate => candidate.ref === pr || candidate.branch === pr)
  let author = view?.author ?? find(await openPullRequests($, cache, context).catch(() => []))?.author
  if (author === undefined || author === '') {
    const read = await readPrView($, context.project.root, pr)
    if ('error' in read) return { kind: 'unknown', reason: read.error }
    author = read.author
  }
  const me = await ownLogin($, cache, context)
  if (me === undefined) return { kind: 'unknown', reason: 'gh could not read your own login' }
  if (author === '') return { kind: 'unknown', reason: `gh named no author for PR #${pr}` }
  return author.toLowerCase() === me.toLowerCase() ? { kind: 'mine' } : { kind: 'others', author }
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
      deny: 'Only a reviewer agent records a verdict, so godmode\'s own work is never cleared by the agent that wrote it or by the PM. Dispatch a godmode:reviewer on the PR, which records its verdict here.',
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
  const then =
    verdict === 'clean'
      ? await afterCleanReview($, context, pr)
      : ` The PR stays a draft until a fix round and a clean review.${verdict === 'change-request' ? await changeRequestLine($, context, pr, headCommit) : ''}`
  return { result: `Recorded ${verdict} for PR #${pr} at ${short(headCommit)}.${then}` }
}

// ---------------------------------------------------------------------------
// QA modes (D69, D71)

/** Every ticket whose PR (or branch) is `pr`, since one PR can carry several, or why the tickets could not be read. */
async function ticketsOfPr($: EngineInterface, context: LoopContext, pr: string): Promise<{ tickets: TicketHeader[] } | { error: string }> {
  try {
    const tickets = await openTicketsOf($, trackerOf(context.note.shared.answers), context.note.dir)
    return { tickets: tickets.filter(ticket => (ticket.pr !== undefined && prRefOf(ticket.pr) === pr) || ticket.branch === pr) }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

const idsOf = (tickets: readonly TicketHeader[]) => tickets.map(ticket => ticket.id).join(', ')

/**
 * Moves a ticket to qa; resolves undefined when it could not, else the line telling the PM
 * to mirror the move in a tracker godmode cannot reach (Other, D25), if any.
 */
async function moveToQa($: EngineInterface, context: LoopContext, ticket: string): Promise<{ mirror?: string } | undefined> {
  const backend = backendOrNothing($, context)
  if (backend === undefined) return undefined
  return backend.move(ticket, { status: 'qa' }).then(
    () => ({ mirror: backend.mirror?.(`move ${ticket} to qa`) }),
    () => undefined,
  )
}

/** What a PR godmode marked ready waits on next: the project's merge conditions, and who says "merge". */
const conditionsNext = (settings: LoopSettings, pr: string) => {
  const conditions = settings.mergeConditions
  const what = conditions.length === 0 ? 'The project sets no merge conditions' : `It merges once the project's conditions hold, checked live: ${conditions.map(conditionWords).join(', ')}`
  const who = settings.isAutoMergeOn ? 'godmode merges it then, on its own' : `the person says "merge" (\`gh pr merge ${pr}\`)`
  return ` ${what}; ${who}.`
}

/**
 * What follows a clean review of godmode's own PR (D78): godmode's QA agent first where it
 * tries godmode's visible changes, then the PR is marked ready, and the project's merge
 * conditions take over. Where people test the PR, its visible changes move to qa for them.
 */
async function afterCleanReview($: EngineInterface, context: LoopContext, pr: string) {
  const { settings } = context
  const found = await ticketsOfPr($, context, pr)
  const tickets = 'error' in found ? [] : found.tickets
  const visible = tickets.filter(ticket => ticket.visibleChange)
  const isAgentFirst = settings.qaMode === 'bot' || (isHumanQaMode(settings.qaMode) && settings.isQaBotFirst)
  if (isAgentFirst && visible.length > 0) {
    return ` Next godmode's QA agent tests ${idsOf(visible)} at this commit; once it passes, mark PR #${pr} ready (\`gh pr ready ${pr}\`).`
  }
  const lines = [` Mark PR #${pr} ready now (\`gh pr ready ${pr}\`); a new commit needs a new review.${conditionsNext(settings, pr)}`]
  const rule = settings.humanReview
  const named = rule === undefined ? [] : rule.reviewers.split(/[\s,]+/).filter(part => part !== '')
  if (named.length > 0) lines.push(`Request ${named.join(', ')} as reviewers (\`gh pr edit ${pr} --add-reviewer ${named.join(',')}\`).`)
  if (settings.qaMode === 'human-pr') lines.push(...(await toPeopleQa($, context, visible)))
  return lines.join(' ')
}

/** Moves each visible change to qa for the people who test the PR (D69); resolves what was done, and any line to mirror by hand. */
async function toPeopleQa($: EngineInterface, context: LoopContext, tickets: readonly TicketHeader[]) {
  const lines: string[] = []
  for (const ticket of tickets) {
    if (ticket.status === 'qa' || ticket.status === 'done') {
      lines.push(`${ticket.id} waits in qa for people to test it.`)
      continue
    }
    const moved = await moveToQa($, context, ticket.id)
    lines.push(moved === undefined ? `godmode could not move ${ticket.id} to qa, so the PM moves it: people test the PR now.` : `godmode moved ${ticket.id} to qa: people test the PR now.`)
    if (moved?.mirror !== undefined) lines.push(moved.mirror)
  }
  return lines
}

/** After a merge in `human-staging`, each visible change the PR carries goes to qa, not done: people test it on staging (D69). */
async function afterStagingMerge($: EngineInterface, context: LoopContext, pr: string) {
  const found = await ticketsOfPr($, context, pr)
  const tickets = 'error' in found ? [] : found.tickets
  const rule = 'people test it on staging after the merge, and it leaves qa once their pass is recorded with ticket_move (qaResult: passed)'
  const lines: string[] = []
  for (const ticket of tickets) {
    if (!waitsOnPeople(context.settings.qaMode, ticket) || ticket.status === 'qa' || ticket.status === 'done') continue
    const moved = await moveToQa($, context, ticket.id)
    lines.push(moved === undefined ? `Move ${ticket.id} to qa, not done: ${rule}.` : `godmode moved ${ticket.id} to qa, not done: ${rule}.`)
    if (moved?.mirror !== undefined) lines.push(moved.mirror)
  }
  return lines
}

/** A PR's head commit, or why it could not be read. */
async function headOf($: EngineInterface, context: LoopContext, pr: string): Promise<{ head: string } | { error: string }> {
  const choice = await hostOf($, context)
  if ('error' in choice) return { error: `godmode could not reach the git host to read PR #${pr}'s head commit: ${choice.error}` }
  try {
    return { head: await choice.host.headCommit(pr) }
  } catch (error) {
    return { error: `godmode could not read PR #${pr}'s head commit (${messageOf(error)})` }
  }
}

// ---------------------------------------------------------------------------
// The QA agent's result (D35, D71)

export type BotQaResult = 'pass' | 'fail'

export const BOT_QA_RESULTS: readonly BotQaResult[] = ['pass', 'fail']

/**
 * The way past the QA agent when the app cannot run: the person's word, recorded by the
 * main thread alone, with their reason. It stands in for a pass at the commit it was
 * recorded at, never for a fail.
 */
export const QA_SKIPPED = 'skipped'

/**
 * The QA agent's last result on a ticket, or the person's skip. Like a verdict, it holds
 * only at the commit it was given at (D53).
 */
export type BotQaRecord = { result: BotQaResult | typeof QA_SKIPPED; commit: string; at: string; agentId?: string; summary?: string }

/** Kept per project and ticket across sessions, like the review verdicts, so a resumed loop still counts the round. */
const botQaKey = (project: Project) => `qaVerdicts:${project.id}`

const isBotQaRecord = (value: unknown): value is BotQaRecord =>
  typeof value === 'object' &&
  value !== null &&
  [...BOT_QA_RESULTS, QA_SKIPPED].includes((value as BotQaRecord).result) &&
  typeof (value as BotQaRecord).commit === 'string'

export async function readBotQa($: EngineInterface, project: Project): Promise<Record<string, BotQaRecord>> {
  const value = await $.store.get(botQaKey(project))
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, BotQaRecord] => isBotQaRecord(entry[1])))
}

/** A ticket's last QA agent result, as the key that counts its fix round, when it failed. */
async function botQaFailOf($: EngineInterface, project: Project, ticket: string) {
  const record = (await readBotQa($, project))[ticket]
  return record?.result === 'fail' ? `qa@${record.commit}` : undefined
}

/** Whether the QA agent's pass, or the person's skip, holds for a ticket at `head`. */
export const isBotQaClearAt = (record: BotQaRecord | undefined, head: string) =>
  record !== undefined && record.commit === head && (record.result === 'pass' || record.result === QA_SKIPPED)

/** Whether a commit someone named is `head`: the full id, or a prefix of 7 characters or more. */
const isSameCommit = (named: string, head: string) => {
  const a = named.trim().toLowerCase()
  const b = head.trim().toLowerCase()
  return a.length >= 7 && (a.startsWith(b) || b.startsWith(a))
}

/** The `qa_verdict` tool: the QA agent records its result on a ticket at the commit it tested, its PR's current one. */
export const QA_VERDICT_TOOL: ToolSpec & { name: 'qa_verdict' } = {
  name: 'qa_verdict',
  description:
    'Record your QA result on a ticket: pass or fail, at the commit you tested (`commit`), which must still be its PR\'s head commit. Only the godmode QA agent records a pass or a fail. A fail starts a fix round on the ticket; a pass holds only at this commit, so a new commit needs a new test. The main thread alone records `skipped`, when the app cannot run and the person said to go on without the QA agent, with their reason as `summary`.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket: { type: 'string', description: 'The id of the ticket you tested, e.g. T-3.' },
      result: { type: 'string', enum: [...BOT_QA_RESULTS, QA_SKIPPED] },
      commit: { type: 'string', description: 'The commit you tested (`git rev-parse HEAD` where you ran the app). Required for pass and fail.' },
      summary: { type: 'string', description: 'One or two lines: what passed, or what failed; for skipped, the person\'s reason.' },
    },
    required: ['ticket', 'result'],
  },
  isDeferred: false,
}

/**
 * What follows the QA agent's pass in the project's QA mode: in `human-pr` a visible change
 * moves to qa for people to test (D71), as it does after a clean review without the pre-pass.
 */
async function afterBotPass($: EngineInterface, context: LoopContext, ticket: TicketHeader) {
  const { settings } = context
  const pr = ticket.pr === undefined ? undefined : prRefOf(ticket.pr)
  const ready = pr === undefined ? ' With a clean review at this commit, its PR may now be marked ready.' : ` With a clean review at this commit, mark PR #${pr} ready now (\`gh pr ready ${pr}\`).${conditionsNext(settings, pr)}`
  if (settings.qaMode !== 'human-pr' || !ticket.visibleChange) return ready
  return `${ready} ${(await toPeopleQa($, context, [ticket])).join(' ')}`
}

/** Serves `qa_verdict`: checks who calls, reads the commit of the ticket's PR (or branch), records the result there. */
export async function serveQaVerdict($: EngineInterface, cache: LoopCache, e: { agentId?: string } & Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so it records no QA result. The person switches it on with `/godmode`.' }
  const context = await loopContextOf($, cache)
  if (context === undefined) return { deny: 'godmode is not set up in this project yet, so it has nowhere to record a QA result.' }
  if (e.result === QA_SKIPPED) return serveQaSkip($, context, e)
  const caller = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
  if (caller?.role !== 'qa') {
    return {
      deny: 'Only the godmode QA agent records a result with qa_verdict, so a change is never passed by the agent that wrote it, its reviewer or the PM. Dispatch a godmode:qa on the ticket. People\'s QA results are recorded by the main thread with ticket_move (qaResult).',
    }
  }
  const result = BOT_QA_RESULTS.find(candidate => candidate === e.result)
  if (result === undefined) return { deny: `\`${String(e.result)}\` is not a QA result; use one of ${BOT_QA_RESULTS.join(', ')}.` }
  const named = typeof e.commit === 'string' ? e.commit.trim() : ''
  if (named === '') return { deny: '`commit` is required: the commit you tested (`git rev-parse HEAD` where you ran the app). No QA result was recorded.' }
  const tested = await testedTicketOf($, context, e.ticket)
  if ('deny' in tested) return tested
  const { ticket, commit } = tested
  if (!isSameCommit(named, commit)) {
    return {
      deny: `${ticket.id}'s PR has moved on: you tested ${short(named)}, and its head is now ${short(commit)}. A QA result counts only at the commit it was given at, so none was recorded. Report this to the PM: the new commit needs its own test.`,
    }
  }
  const summary = typeof e.summary === 'string' && e.summary.trim() !== '' ? e.summary.trim() : undefined
  const record: BotQaRecord = { result, commit, at: new Date(await $.clock.now()).toISOString(), agentId: e.agentId, summary }
  await $.store.set(botQaKey(context.project), { ...(await readBotQa($, context.project)), [ticket.id]: record })
  const then =
    result === 'pass'
      ? `${await afterBotPass($, context, ticket)} A new commit needs a new test.`
      : ` The PM sends your findings to the dev agent as a fix round.${await roundLine($, context, ticket.id, `qa@${commit}`)}`
  return { result: `Recorded QA ${result} for ${ticket.id} at ${short(commit)}.${then}` }
}

/**
 * The person's skip of the QA agent (main thread only): the app cannot run, and they said
 * to go on. It stands in for a pass at the PR's current commit; never over a fail there.
 */
async function serveQaSkip($: EngineInterface, context: LoopContext, e: { agentId?: string } & Record<string, unknown>) {
  if (e.agentId !== undefined) {
    return { deny: 'Only the main thread records a skipped QA, on the person\'s word. Report to the PM why the app cannot be tested.' }
  }
  const reason = typeof e.summary === 'string' ? e.summary.trim() : ''
  if (reason === '') return { deny: 'A skip needs the person\'s reason as `summary`: why the QA agent cannot test this. Nothing was recorded.' }
  const tested = await testedTicketOf($, context, e.ticket)
  if ('deny' in tested) return tested
  const { ticket, commit } = tested
  const last = (await readBotQa($, context.project))[ticket.id]
  if (last?.result === 'fail' && last.commit === commit) {
    return { deny: `The QA agent failed ${ticket.id} at this commit ${short(commit)}. A skip is for an app that cannot run, not for a failed test: run the fix round. Nothing was recorded.` }
  }
  const record: BotQaRecord = { result: QA_SKIPPED, commit, at: new Date(await $.clock.now()).toISOString(), summary: `skipped by the person: ${reason}` }
  await $.store.set(botQaKey(context.project), { ...(await readBotQa($, context.project)), [ticket.id]: record })
  return {
    result: `Recorded that the person skipped the QA agent on ${ticket.id} at ${short(commit)}: ${reason}. It holds only at this commit.${await afterBotPass($, context, ticket)}`,
  }
}

/**
 * Why a visible change may not move on before the QA agent passed it at `head`, or
 * undefined: in `bot` before its PR is marked ready or merged, in `human-pr` with the QA
 * agent first before it moves to qa (D35, D71). A fail at `head` always holds it.
 */
const botQaRefusal = (ticket: Pick<TicketHeader, 'id'>, record: BotQaRecord | undefined, head: string, what: string) => {
  if (isBotQaClearAt(record, head)) return undefined
  if (record?.result === 'fail' && record.commit === head) {
    return `The QA agent failed ${ticket.id} at the current commit ${short(head)}, so ${what}. Send its findings to the dev agent for a fix round, then have the fix reviewed and tested again. Nothing changed.`
  }
  const stale = record === undefined ? '' : ` Its last QA result (${record.result}) is from commit ${short(record.commit)}.`
  return `${ticket.id} is a visible change, and the QA agent has not passed it at the current commit ${short(head)}, so ${what}.${stale} Dispatch a godmode:qa on ${ticket.id} at this commit. If the app cannot run and the person says to go on without it, record their word with qa_verdict (ticket: ${ticket.id}, result: ${QA_SKIPPED}, summary: their reason). Nothing changed.`
}

/** The ticket a QA result names, and the head commit of its PR (or branch) to record it at; or why there is none. */
async function testedTicketOf($: EngineInterface, context: LoopContext, named: unknown): Promise<{ ticket: TicketHeader; commit: string } | { deny: string }> {
  const text = typeof named === 'string' ? named : ''
  const wanted = normaliseId(text) ?? text.trim().toUpperCase()
  if (wanted === '') return { deny: '`ticket` is required: the id of the ticket you tested.' }
  const backend = backendOrNothing($, context)
  const tickets = backend === undefined ? undefined : await backend.list({ statuses: TICKET_STATUSES }).catch(() => undefined)
  if (tickets === undefined) return { deny: 'godmode could not read the tickets, so no QA result was recorded. Try again shortly.' }
  const ticket = tickets.find(header => header.id.toUpperCase() === wanted)
  if (ticket === undefined) return { deny: `There is no ticket ${wanted}, so no QA result was recorded. Check the id in your brief.` }
  // With no PR (a local-branch host, D54), the branch stands for it.
  const ref = ticket.pr === undefined ? ticket.branch : prRefOf(ticket.pr)
  if (ref === undefined) return { deny: `${ticket.id} names no PR or branch, so godmode has no commit to record your result at. Report it to the PM.` }
  const head = await headOf($, context, ref)
  if ('error' in head) return { deny: `${head.error}, so no QA result was recorded. Try again once the host answers.` }
  return { ticket, commit: head.head }
}

// ---------------------------------------------------------------------------
// The fix-round limit (D56)

/**
 * One ticket's fix rounds: one count whatever started the round, a change-request review,
 * a QA agent fail or a human QA fail (build default); the rounds the person allowed past
 * the limit; and the results already counted, a change-request as `<pr>@<commit>`, a QA
 * agent fail as `qa@<commit>` and a human QA fail as `human@<commit>`, so a second dispatch
 * for the same result, or the same fail recorded again, is the same round.
 */
export type FixRounds = { count: number; extra: number; counted: string[] }

/** Fix rounds per ticket, kept across sessions per project like the verdicts. */
const fixRoundsKey = (project: Project) => `fixRounds:${project.id}`

const NO_FIX_ROUNDS: FixRounds = { count: 0, extra: 0, counted: [] }

/** How many counted verdicts a ticket keeps: enough to tell this round's verdict from the last ones. */
const COUNTED_KEPT = 20

/** A stored entry as `FixRounds`; a bare number is a count kept before the limit was enforced. */
const fixRoundsOf = (value: unknown): FixRounds => {
  if (typeof value === 'number') return { ...NO_FIX_ROUNDS, count: value }
  if (typeof value !== 'object' || value === null) return NO_FIX_ROUNDS
  const entry = value as Partial<Record<keyof FixRounds, unknown>>
  return {
    count: typeof entry.count === 'number' ? entry.count : 0,
    extra: typeof entry.extra === 'number' ? entry.extra : 0,
    counted: Array.isArray(entry.counted) ? entry.counted.filter((key): key is string => typeof key === 'string') : [],
  }
}

async function readAllFixRounds($: EngineInterface, project: Project) {
  const value = await $.store.get(fixRoundsKey(project))
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export async function readFixRounds($: EngineInterface, project: Project, ticket: string) {
  return fixRoundsOf((await readAllFixRounds($, project))[ticket])
}

/** Writes a ticket's entry; undefined clears it. */
async function writeFixRounds($: EngineInterface, project: Project, ticket: string, entry: FixRounds | undefined) {
  const { [ticket]: old, ...others } = await readAllFixRounds($, project)
  if (entry === undefined && old === undefined) return
  await $.store.set(fixRoundsKey(project), entry === undefined ? others : { ...others, [ticket]: entry })
}

/** The rounds a ticket may have: the limit, and what the person allowed past it. */
export const allowedOf = (settings: LoopSettings, entry: FixRounds) => settings.fixRoundLimit + entry.extra

const roundOf = (count: number, allowed: number) => `fix round ${count} of ${allowed}`

/** What follows a round past the limit, for the answers that count one. */
const pastLimitLine = (ticket: string, allowed: number) =>
  ` That is past the fix-round limit (${allowed}): stop and ask the person what to do before starting it, saying what keeps failing. godmode refuses a fix round on ${ticket}, a dev dispatch or a message to its dev agent, until they say to go on; then allow more rounds with ticket_move (id: ${ticket}, moreFixRounds: 1 or more).`

/**
 * Counts one more fix round on a ticket for the result counted as `key`; a human QA fail
 * counts too (build default). The same result recorded again is the same round. Resolves
 * the count and the rounds allowed.
 */
export async function addFixRound($: EngineInterface, context: LoopContext, ticket: string, key: string) {
  const entry = await readFixRounds($, context.project, ticket)
  if (entry.counted.includes(key)) return { count: entry.count, allowed: allowedOf(context.settings, entry) }
  const counted = { ...entry, count: entry.count + 1, counted: [...entry.counted, key].slice(-COUNTED_KEPT) }
  await writeFixRounds($, context.project, ticket, counted)
  return { count: counted.count, allowed: allowedOf(context.settings, counted) }
}

/** The person's go after the limit stopped a ticket: more rounds on that ticket only. */
async function allowMoreFixRounds($: EngineInterface, context: LoopContext, ticket: string, more: number) {
  const entry = await readFixRounds($, context.project, ticket)
  const raised = { ...entry, extra: entry.extra + more }
  await writeFixRounds($, context.project, ticket, raised)
  return `${ticket} may now have up to ${allowedOf(context.settings, raised)} fix rounds (${raised.count} so far); godmode dispatches its next fix round again.`
}

/** A ticket's last review verdict, as the key that counts it, when it asks for changes. */
async function changeRequestOf($: EngineInterface, project: Project, ticket: Pick<TicketHeader, 'pr'>) {
  const pr = ticket.pr === undefined ? undefined : prRefOf(ticket.pr)
  if (pr === undefined) return undefined
  const record = (await readVerdicts($, project))[pr]
  return record?.verdict === 'change-request' ? `${pr}@${record.headCommit}` : undefined
}

/**
 * What a change-request verdict says of the fix round it starts, per ticket the PR carries.
 * The round is counted when the dev agent is dispatched for it.
 */
async function changeRequestLine($: EngineInterface, context: LoopContext, pr: string, headCommit: string) {
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found || found.tickets.length === 0) return ''
  const lines: string[] = []
  for (const ticket of found.tickets) lines.push(await roundLine($, context, ticket.id, `${pr}@${headCommit}`))
  return lines.join('')
}

/** The round a result counted as `key` starts on a ticket, before the dispatch that counts it. */
async function roundLine($: EngineInterface, context: LoopContext, ticket: string, key: string) {
  const entry = await readFixRounds($, context.project, ticket)
  const count = entry.count + (entry.counted.includes(key) ? 0 : 1)
  const allowed = allowedOf(context.settings, entry)
  return ` For ${ticket} this is ${roundOf(count, allowed)}.${count > allowed ? pastLimitLine(ticket, allowed) : ''}`
}

/** How a refused fix round started, for its refusal: a dev dispatch, or a message to the ticket's dev agent (D35). */
type FixRoundStart = { stopped: string; retry: string }

const BY_DISPATCH: FixRoundStart = { stopped: 'the dev agent did not start', retry: 'dispatch again' }
const BY_MESSAGE: FixRoundStart = { stopped: 'the message did not reach the dev agent', retry: 'send it again' }

/**
 * The fix-round gate of a dev dispatch, or of a message to the ticket's dev agent (D56). Either
 * on a ticket whose PR's last verdict asks for changes, whose last QA agent result failed, or
 * whose people's QA failed before the merge, is a fix round: a change-request or QA agent fail
 * not counted yet is counted here, once whichever of them started the round, and a round past
 * the limit is refused until the main thread allows more. Resolves the refusal, or undefined.
 */
async function fixRoundRefusal($: EngineInterface, context: LoopContext, ticket: TicketHeader, start: FixRoundStart = BY_DISPATCH) {
  const { settings, project } = context
  const keys = [await changeRequestOf($, project, ticket), await botQaFailOf($, project, ticket.id)].filter((key): key is string => key !== undefined)
  const isQaFail = ticket.qaResult?.result === 'failed' && settings.qaMode !== 'human-staging'
  if (keys.length === 0 && !isQaFail) return undefined
  const entry = await readFixRounds($, project, ticket.id)
  const fresh = keys.filter(key => !entry.counted.includes(key))
  const count = entry.count + (fresh.length > 0 ? 1 : 0)
  const allowed = allowedOf(settings, entry)
  if (count > allowed) {
    return `This would be ${roundOf(count, allowed)} on ${ticket.id}, past the fix-round limit, so ${start.stopped}. Stop and ask the person what to do, saying what keeps failing. If they say to go on, allow more rounds with ticket_move (id: ${ticket.id}, moreFixRounds: 1 or more), then ${start.retry}.`
  }
  if (fresh.length > 0) await writeFixRounds($, project, ticket.id, { ...entry, count, counted: [...entry.counted, ...fresh].slice(-COUNTED_KEPT) })
  return undefined
}

/**
 * The dev agent a SendMessage recipient names: by the agent id godmode recorded at its
 * dispatch, or by the name it was dispatched with, with or without the ` [ref]` a listing
 * appends. The latest dispatch wins where two carried one name.
 */
const devAgentAddressed = (known: Record<string, DispatchedAgent>, to: string) => {
  const addresses = [to.trim(), to.replace(/\s*\[[^\]]*\]\s*$/, '').trim()]
  for (const address of addresses) {
    const byId = known[address]
    if (byId?.role === 'dev') return byId
  }
  return Object.values(known).findLast(agent => agent.role === 'dev' && agent.name !== undefined && addresses.includes(agent.name))
}

/**
 * The fix-round gate of a main-thread SendMessage (D35, D56): a change-request's fix round
 * goes to the same dev agent by message, which never meets `agent.spawn`, so it is counted
 * and limited here as a dispatch would be. A message to anyone else, or with no round
 * pending, passes. So does one whose ticket cannot be read: unlike a dispatch, a message
 * may be about anything, and refusing every one would cut the PM off from its agents.
 */
async function messageFixRoundRefusal($: EngineInterface, context: LoopContext, to: unknown) {
  if (typeof to !== 'string') return undefined
  const agent = devAgentAddressed(await read($, agents), to)
  const id = agent?.ticket?.toUpperCase()
  if (id === undefined) return undefined
  const backend = backendOrNothing($, context)
  const tickets = backend === undefined ? [] : await backend.list({ statuses: TICKET_STATUSES }).catch(() => [])
  const ticket = tickets.find(header => header.id.toUpperCase() === id)
  if (ticket === undefined || ticket.status === 'done') return undefined
  return fixRoundRefusal($, context, ticket, BY_MESSAGE)
}

/** A merged PR ends its tickets' fix rounds: a fail after it is a new ticket (D72). */
async function clearFixRoundsOfPr($: EngineInterface, context: LoopContext, pr: string) {
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found) return
  for (const ticket of found.tickets) await writeFixRounds($, context.project, ticket.id, undefined).catch(() => undefined)
}

/** What the answer to a recorded QA result says next, per mode. */
async function qaRecordedLine($: EngineInterface, context: LoopContext, ticket: TicketHeader, result: QaResult, status: string) {
  const at = `${ticket.id} at ${short(result.commit)}`
  if (result.result === 'passed') {
    const original = ticket.fixFor === undefined ? '' : ` ${ticket.id} fixes ${ticket.fixFor}, so ${ticket.fixFor} may now move from qa to done.`
    return `Recorded QA passed for ${at}. It holds only at this commit: a new commit needs a new pass.${original}`
  }
  if (context.settings.qaMode === 'human-staging') {
    return `Recorded QA failed for ${at}. The change is already merged, so its fix is a new ticket that carries the testers' reason (D72): file it with ticket_create (fixFor: ${ticket.id}). ${ticket.id} stays in qa until a pass is recorded, or until its fix ticket records one.`
  }
  const { count, allowed } = await addFixRound($, context, ticket.id, `human@${result.commit}`)
  const stop = count > allowed ? pastLimitLine(ticket.id, allowed) : ''
  return `Recorded QA failed for ${at}: it is back in ${status} for ${roundOf(count, allowed)} on this ticket. Send the testers' findings to the dev agent; once the fix is reviewed clean, ${ticket.id} goes back to qa.${stop}`
}

/**
 * The QA rules of a ticket move (D69), for the ticket tools. A QA result is recorded at the
 * PR's current commit, or the branch's head where the ticket names no PR (D54); a fail
 * before the merge sends the ticket back to doing for a fix round; a ticket leaves qa, or
 * closes a visible change in a human mode, only with a pass at that commit, its fix
 * ticket's pass (D72), or the main thread's override. The main thread's close ends the
 * ticket's fix-round count, and its `moreFixRounds` lets a ticket the limit stopped go on (D56).
 */
export function ticketMoveCheck($: EngineInterface, cache: LoopCache): MoveCheck {
  return async (id, change, qaWord, options = {}) => {
    const { override } = options
    const context = await loopContextOf($, cache)
    if (context === undefined) {
      if (qaWord !== undefined) throw new TicketError('godmode is not set up in this project yet, so it has no PR commit to record a QA result at.')
      if (options.moreFixRounds !== undefined) throw new TicketError('godmode is not set up in this project yet, so it counts no fix rounds.')
      return { change }
    }
    const wanted = normaliseId(id) ?? id.trim().toUpperCase()
    const tickets = await openTicketsOf($, trackerOf(context.note.shared.answers), context.note.dir, { id: wanted, withFixes: change.status === 'done' })
    const ticket = tickets.find(header => header.id.toUpperCase() === wanted)
    // Someone else's Jira ticket is a risky action under "careful" (D78): the person created it, godmode filed it, or they ask.
    if (ticket === undefined && trackerOf(context.note.shared.answers) === 'jira' && context.settings.care === 'careful') {
      const owner = await jiraOwnership($, context.project, wanted)
      if (!owner.isOwn) {
        const held = await withAsks($, [{ action: 'others-ticket', target: wanted, state: owner.why }])
        if (held.length > 0) throw new TicketError(riskyRefusal(held))
      }
    }
    // No such ticket: the move itself says so.
    if (ticket === undefined) return { change }
    const { qaMode } = context.settings
    const isFixRound = qaWord === 'failed' && qaMode !== 'human-staging'
    const status = isFixRound ? (change.status ?? 'doing') : change.status
    if (qaWord === 'failed' && status === 'done') {
      throw new TicketError(`A QA fail does not close ${ticket.id}: record qaResult: failed without status done. Nothing changed.`)
    }
    const isLeavingQa = ticket.status === 'qa' && status !== undefined && status !== 'qa'
    const isClosingUntested =
      status === 'done' && ticket.status !== 'done' && waitsOnPeople(qaMode, { visibleChange: ticket.visibleChange || change.visibleChange === true })
    // A fix ticket filed after a staging fail (D72) closes its original once it passed.
    const fix =
      isLeavingQa && status === 'done' ? tickets.find(header => header.fixFor?.toUpperCase() === ticket.id.toUpperCase() && header.qaResult?.result === 'passed') : undefined
    const needsPass = !isFixRound && override === undefined && fix === undefined && (isLeavingQa || isClosingUntested)
    const pr = change.pr ?? ticket.pr
    const branch = change.branch ?? ticket.branch
    // With no PR (a local-branch host, D54), the branch stands for it.
    const ref = pr === undefined ? branch : prRefOf(pr)
    let head: string | undefined
    if (ref !== undefined && (qaWord !== undefined || needsPass)) {
      const read = await headOf($, context, ref)
      if ('error' in read) {
        if (pr === undefined) {
          throw new TicketError(
            `${ticket.id} names no PR, and godmode could not read the head commit of its branch \`${ref}\`: the branch may have been deleted, so there is no commit to hold a QA result. Nothing changed. ${OVERRIDE_HINT}`,
          )
        }
        throw new TicketError(`${read.error}, so the QA rules could not be checked. Nothing changed; try again once the host answers.`)
      }
      head = read.head
    }
    if (qaWord !== undefined && head === undefined) {
      throw new TicketError(
        `${ticket.id} names no PR or branch, so godmode has no commit to record its QA result at. Set its PR with ticket_move (pr), then record the result again. Nothing changed.`,
      )
    }
    const recorded: QaResult | undefined = qaWord !== undefined && head !== undefined ? { result: qaWord, commit: head } : undefined
    const botFirst = await botFirstRefusal($, context, ticket, status, change, override, ref)
    if (botFirst !== undefined) throw new TicketError(botFirst)
    if (needsPass) {
      const refusal = qaMoveRefusal(qaMode, ticket, recorded ?? ticket.qaResult, head)
      if (refusal !== undefined) throw new TicketError(refusal)
    }
    const next: TicketChange = { ...change, ...(status === undefined ? {} : { status }), ...(recorded === undefined ? {} : { qaResult: recorded }) }
    const lines: (() => Promise<string | undefined>)[] = []
    if (recorded !== undefined) lines.push(() => qaRecordedLine($, context, ticket, recorded, status ?? ticket.status))
    if (fix !== undefined && override === undefined) lines.push(async () => `${ticket.id} closes on its fix ticket ${fix.id}'s QA pass.`)
    const { moreFixRounds } = options
    if (moreFixRounds !== undefined) lines.push(() => allowMoreFixRounds($, context, ticket.id, moreFixRounds))
    // Only the main thread's close ends the count: an agent closing its own ticket would lift the limit.
    if (options.isMain === true && status === 'done' && ticket.status !== 'done') {
      lines.push(async () => {
        await writeFixRounds($, context.project, ticket.id, undefined).catch(() => undefined)
        return undefined
      })
    }
    if (lines.length === 0) return { change: next }
    return {
      change: next,
      written: async () => {
        const said: string[] = []
        for (const line of lines) {
          const text = await line()
          if (text !== undefined) said.push(text)
        }
        return said.length === 0 ? undefined : said.join('\n')
      },
    }
  }
}

/**
 * In `human-pr` with the QA agent first (D71), a visible change moves to qa only once the
 * QA agent passed it, or the person skipped it, at its PR's current commit. The main
 * thread's override is the person's word too, but never over a QA agent fail at that
 * commit, as a skip is not.
 */
async function botFirstRefusal(
  $: EngineInterface,
  context: LoopContext,
  ticket: TicketHeader,
  status: string | undefined,
  change: TicketChange,
  override: string | undefined,
  ref: string | undefined,
) {
  const { settings } = context
  if (settings.qaMode !== 'human-pr' || !settings.isQaBotFirst) return undefined
  if (status !== 'qa' || ticket.status === 'qa' || !(change.visibleChange ?? ticket.visibleChange)) return undefined
  const isOverride = override !== undefined
  const what = `it does not move to qa for people to test yet (QA mode human-pr, the QA agent first)`
  if (ref === undefined) return isOverride ? undefined : `${ticket.id} names no PR or branch, so godmode cannot check the QA agent's pass, and ${what}. Set its PR with ticket_move (pr). Nothing changed.`
  const read = await headOf($, context, ref)
  if ('error' in read) return isOverride ? undefined : `${read.error}, so the QA agent's pass could not be checked. Nothing changed; try again once the host answers.`
  const record = (await readBotQa($, context.project))[ticket.id]
  if (!isOverride) return botQaRefusal(ticket, record, read.head, what)
  if (record?.result !== 'fail' || record.commit !== read.head) return undefined
  return `${botQaRefusal(ticket, record, read.head, what)} An override is for an app the QA agent cannot run, never for a failed test.`
}

// ---------------------------------------------------------------------------
// The tool-call gate

/** What the gate decided: a refusal, or what `afterToolCall` needs once the call ran. */
export type ToolDecision =
  | { deny: string }
  | { deny?: undefined; isMain: boolean; agentId?: string; agent?: DispatchedAgent; opensPr: boolean; merges: string[]; notes: string[] }

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

const doingOf = (step: ShellStep) => (step.action === 'pr-ready' ? 'marked ready' : step.action === 'pr-approve' ? 'approved' : 'merged')

/** Why a merge or ready that names no PR is refused: godmode cannot tell which PR to read. */
const unnamedPrRefusal = (step: ShellStep) => {
  const doing = doingOf(step)
  const plain = step.action === 'pr-ready' ? 'gh pr ready 12' : 'gh pr merge 12'
  if (step.isApi === true) return `godmode cannot tell which PR this \`gh api\` call would have ${doing}, so it cannot read the PR's live state first. Run \`${plain}\` with the PR's number instead. Nothing ran.`
  return `Name the PR by number (\`${step.verb} 12\`), so godmode can read its live state before it is ${doing}. Nothing ran.`
}

/**
 * godmode's own work on a PR (D78): its review verdict, and its QA agent's pass where it tries
 * godmode's visible changes, at the PR's current commit. They apply only to a PR godmode made
 * (a ticket of its names the PR, or its reviewer gave a verdict on it): `isOwn` false for any other.
 */
async function ownLoopState($: EngineInterface, context: LoopContext, pr: string, head: string): Promise<{ isOwn: boolean; missing: string[] }> {
  const record = (await readVerdicts($, context.project))[pr]
  const found = await ticketsOfPr($, context, pr)
  const tickets = 'error' in found ? [] : found.tickets
  if (record === undefined && tickets.length === 0) return { isOwn: false, missing: [] }
  const missing: string[] = []
  const { settings } = context
  if (settings.isMergeGateOn) {
    if (record === undefined) missing.push(`godmode's review has no verdict on PR #${pr}: dispatch a godmode:reviewer on it`)
    else if (record.headCommit !== head) missing.push(`godmode's last verdict (${record.verdict}) was at ${short(record.headCommit)} and PR #${pr} is now at ${short(head)}: dispatch a godmode:reviewer on the new commit`)
    else if (record.verdict !== 'clean') missing.push(`godmode's review at ${short(head)} is ${record.verdict}: send the findings to the dev agent for a fix round, then review again`)
  }
  const isAgentFirst = settings.qaMode === 'bot' || (isHumanQaMode(settings.qaMode) && settings.isQaBotFirst)
  if (isAgentFirst) {
    const records = await readBotQa($, context.project)
    for (const ticket of tickets.filter(header => header.visibleChange)) {
      const refusal = botQaRefusal(ticket, records[ticket.id], head, `PR #${pr} is not ready`)
      if (refusal !== undefined) missing.push(refusal.replace(/ Nothing changed\.$/, ''))
    }
  }
  return { isOwn: true, missing }
}

/**
 * Why godmode's own PR may not be marked ready yet (D53, D78): its review and its QA agent are
 * not done at the current commit. A PR godmode did not make has no such step. The person's ask
 * marks it ready as it is: it is their work too.
 */
async function readyRefusal($: EngineInterface, cache: LoopCache, context: LoopContext, pr: string) {
  const choice = await hostOf($, context)
  if ('error' in choice) return undefined
  let head: string
  try {
    head = await choice.host.headCommit(pr)
  } catch {
    // The PR cannot be read: there is no loop state to hold it on.
    return undefined
  }
  const own = await ownLoopState($, context, pr, head)
  if (!own.isOwn || own.missing.length === 0) return undefined
  if (await takeAsk($, 'ready-as-is', pr)) return undefined
  return `PR #${pr} is godmode's own work, and godmode marks it ready once its own checks pass at the current commit ${short(head)}: ${own.missing.join('; ')}. If the person asks for it ready as it is, record their words with mcp__godmode__allow_once (action: ready-as-is, target: ${pr}), then run it again. Nothing ran.`
}

/** What a merge gate decided: a refusal, or a go with lines for the PM (what was missing, said after the merge). */
type MergeDecision = { deny: string } | { deny?: undefined; notes: string[]; asks: Ask[] }

/**
 * The QA merge condition (D69, D78): people's pass at the PR's current commit. godmode's own
 * tickets that name the PR are read first; a PR godmode did not make is looked up by the ticket
 * key in its branch or title, read live, and never linked or recorded. The PR-approval and
 * ticket-status signals count too, where the project uses them.
 */
async function qaCondition($: EngineInterface, context: LoopContext, view: PrView, me: string | undefined) {
  const signals = qaSignalsOf(context.answers)
  const approvers = approversOf(context.answers.qaApprovers)
  if (signals.includes('pr-approval') && (approvers.logins.size > 0 || approvers.teams.length > 0)) {
    const approved = await checkMergeConditions($, context.project.root, view, [{ kind: 'approvals', count: 1, reviewers: String(context.answers.qaApprovers) }], me, async () => ({ met: false, state: '' }))
    if (approved[0]?.met === true) return { met: true, state: 'a QA approver approved the current commit' }
  }
  const found = await ticketsOfPr($, context, view.number)
  if (!('error' in found) && found.tickets.length > 0) {
    const states = found.tickets.map(ticket => qaPassState(ticket, view.head))
    const unmet = states.find(state => !state.met)
    return unmet ?? { met: true, state: states.map(state => state.state).join('; ') }
  }
  const tracker = trackerOf(context.note.shared.answers)
  const key = ticketKeyIn(`${view.branch} ${view.title}`, tracker !== 'jira')
  if (key === undefined) return { met: false, state: 'no ticket key in its branch or title, and no QA pass seen on the PR' }
  if (tracker === 'jira') {
    const status = await jiraStatusOf($, context, key)
    const pass = typeof context.answers.qaPassStatus === 'string' ? context.answers.qaPassStatus : undefined
    if (status === undefined) return { met: false, state: `godmode could not read ${key}'s status in Jira just now` }
    if (pass !== undefined && status.toLowerCase() === pass.toLowerCase()) return { met: true, state: `${key} is in "${status}"` }
    return { met: false, state: `${key} is in "${status}"${pass === undefined ? '' : `, not "${pass}"`}` }
  }
  const backend = backendOrNothing($, context)
  const tickets = backend === undefined ? undefined : await backend.list({ statuses: TICKET_STATUSES }).catch(() => undefined)
  const ticket = tickets?.find(header => header.id.toUpperCase() === key)
  if (ticket === undefined) return { met: false, state: `godmode found no ticket ${key}` }
  return qaPassState(ticket, view.head)
}

/**
 * The merge gate (D78), on every PR whoever made it: the project's merge conditions, checked
 * live, and on godmode's own PR its own review and QA agent. Under "careful" a merge is the
 * person's to ask for: their "merge" goes through when the conditions hold, their "merge anyway"
 * when they do not, and godmode merges on its own only when they set it to and everything
 * holds. Under "not careful" godmode merges, and says what was missing.
 */
async function mergeDecision($: EngineInterface, cache: LoopCache, context: LoopContext, step: ShellStep, pr: string): Promise<MergeDecision> {
  const { settings } = context
  const isCareful = settings.care === 'careful'
  const view = await readPrView($, context.project.root, pr)
  if ('error' in view) {
    if (!isCareful) return { notes: [`godmode merged PR #${pr} without checking its merge conditions: ${view.error}.`], asks: [] }
    if (await takeAsk($, 'merge-anyway', pr, false)) return { notes: [`godmode could not read PR #${pr} (${view.error}); it merged on the person's "merge anyway".`], asks: [] }
    return {
      deny: `godmode could not read PR #${pr} to check its merge conditions (${view.error}). Try again once GitHub answers. If the person says to merge it anyway, record their words with mcp__godmode__allow_once (action: merge-anyway, target: ${pr}), then run it again. Nothing ran.`,
    }
  }
  const me = await ownLogin($, cache, context)
  const checks = await checkMergeConditions($, context.project.root, view, settings.mergeConditions, me, () => qaCondition($, context, view, me))
  const own = await ownLoopState($, context, pr, view.head)
  const projectMissing = checks.filter(check => !check.met)
  const loopMissing = own.missing
  const owner = await prOwnerOf($, cache, context, pr, view)
  const missingText = [missingLine(checks), ...loopMissing].filter(part => part !== '').join('; ')
  const isAuto = step.isAuto === true
  // godmode moves its own tickets to qa when it sees the merge; armed for GitHub to merge later, it never would.
  if (isAuto && settings.qaMode === 'human-staging' && own.isOwn) {
    return { deny: `People test on staging after the merge, and godmode moves PR #${pr}'s tickets to qa when it merges it: armed for later, its tickets would never move to qa for people to test on staging. Merge it directly once the conditions hold (\`gh pr merge ${pr}\`). Nothing ran.` }
  }
  if (isAuto && settings.mergeConditions.some(condition => condition.kind === 'qa')) {
    return { deny: `GitHub's auto-merge cannot wait for this project's QA pass, so PR #${pr} is not armed. Merge it directly once QA passes (\`gh pr merge ${pr}\`). Nothing ran.` }
  }
  if (!isCareful) {
    return { notes: missingText === '' ? [] : [`godmode merged PR #${pr} with these not met: ${missingText}.`], asks: [] }
  }
  // Armed for later, GitHub merges once its own required checks pass: the person set godmode to merge on its own.
  if (isAuto && settings.isAutoMergeOn && loopMissing.length === 0 && owner.kind === 'mine') return { notes: [], asks: [] }
  const state = conditionsState(checks)
  if (projectMissing.length > 0) {
    if (await hasAsk($, 'merge-anyway', pr)) return { notes: [`PR #${pr} merged on the person's "merge anyway", with these not met: ${missingText}.`], asks: [{ action: 'merge-anyway', target: pr }] }
    return {
      deny: `PR #${pr} does not meet this project's merge conditions yet: ${missingLine(checks)}.${loopMissing.length === 0 ? '' : ` godmode's own checks: ${loopMissing.join('; ')}.`} Tell the person what is missing. If they say "merge anyway", record their words with mcp__godmode__allow_once (action: merge-anyway, target: ${pr}), then run it again. Nothing ran.`,
    }
  }
  if (await hasAsk($, 'merge-anyway', pr)) return { notes: loopMissing.length === 0 ? [] : [`PR #${pr} merged on the person's word, before godmode's own checks: ${loopMissing.join('; ')}.`], asks: [{ action: 'merge-anyway', target: pr }] }
  if (await hasAsk($, 'merge', pr)) return { notes: loopMissing.length === 0 ? [] : [`PR #${pr} merged on the person's word, before godmode's own checks: ${loopMissing.join('; ')}.`], asks: [{ action: 'merge', target: pr }] }
  if (settings.isAutoMergeOn && loopMissing.length === 0 && owner.kind === 'mine') return { notes: [], asks: [] }
  const whose = owner.kind === 'others' ? ` It is ${owner.author}'s PR.` : owner.kind === 'unknown' ? ` godmode could not tell whose PR it is (${owner.reason}).` : ''
  const loop = loopMissing.length === 0 ? '' : ` godmode's own checks are not done: ${loopMissing.join('; ')}.`
  return {
    deny: `Merging is a risky action, and godmode asks the person first. ${state}${whose}${loop} When the person says "merge #${pr}", record their words with mcp__godmode__allow_once (action: merge, target: ${pr}), then run it again. Nothing ran.`,
  }
}

/** Where the conditions stand, for a refusal that asks the person. */
const conditionsState = (checks: readonly ConditionCheck[]) =>
  checks.length === 0 ? 'This project sets no merge conditions.' : `Every merge condition holds: ${heldLine(checks)}.`

/** The hard rules of a shell step that are the project's own (D78): drafts and attribution. */
async function projectRuleRefusal($: EngineInterface, context: LoopContext, step: ShellStep, command: string) {
  const { settings } = context
  if (step.action === 'pr-open' && settings.isDraftsOnly && step.isDraft !== true) {
    return 'In this project godmode opens its PRs as drafts and marks each ready once its own review passes: add `--draft` to `gh pr create` and run it again. Nothing ran.'
  }
  if (!settings.isAttributionAllowed && carriesText(step)) {
    for (const text of await textsOf($, command, step)) {
      const line = attributionIn(text)
      if (line !== undefined) {
        const what = step.verb === 'git commit' ? 'commit message' : 'PR text'
        return `This project's commits and PRs carry no AI attribution, and the ${what} carries \`${line}\`. Remove that line and run it again. Nothing ran.`
      }
    }
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
    return `You are a dev agent working in your worktree ${agent.worktree}, and ${path} is outside it. Edit the file inside your worktree${copy} instead.`
  }
  if (!settings.isContentionOn || !isInside(path, agent.worktree)) return undefined
  // A sweep that cannot be read leaves the edit free: godmode never refuses for what it cannot see.
  const prs = await openPullRequests($, cache, context).catch(() => cache.sweep?.prs ?? [])
  const file = relativeTo(path, agent.worktree)
  const holder = prs.find(pr => pr.branch !== agent.branch && pr.files.includes(file))
  if (holder === undefined) return undefined
  return `\`${file}\` is held by open PR #${holder.ref} (${holder.title}${holder.author === '' ? '' : `, by ${holder.author}`}), so editing it now could collide with that work. Stop and report this to the PM, who asks the person how to go on. The file frees up when that PR merges or closes.`
}

/** The tools of the context7 server godmode's `plugin.json` declares (D41). */
const CONTEXT7_PREFIX = 'mcp__plugin_godmode_context7__'

/**
 * Off, the session is plain Claude Code (D12), so godmode's context7 tools serve only while
 * godmode is on in a set-up project. Resolves the refusal, or undefined.
 */
export async function context7Refusal($: EngineInterface, cache: LoopCache, tool: string) {
  if (!tool.startsWith(CONTEXT7_PREFIX)) return undefined
  const why =
    (await read($, isOn)) !== true
      ? 'godmode is off'
      : (await read($, mode)) === 'setup' || (await loopContextOf($, cache)) === undefined
        ? 'this project is not set up for godmode yet'
        : undefined
  return why === undefined ? undefined : `godmode's context7 tools work only while godmode is on in a set-up project, and ${why}. Nothing ran.`
}

/** A Jira tool that deletes an issue: deleting a ticket is a risky action (D78). */
const TICKET_DELETE = /^mcp__.+__(deleteJiraIssue|deleteIssue)$/

/** A Jira tool that moves or edits an issue: on someone else's ticket, a risky action (D78). */
const TICKET_EDIT = /^mcp__.+__(transitionJiraIssue|editJiraIssue)$/

/**
 * The gate every tool call passes while godmode is on (D78): the thin main thread, a dev
 * agent's worktree and held files, the project's own rules (drafts, attribution), the merge
 * gate and the ready step on godmode's own PR, then the risky actions, which ask the person
 * first under "careful".
 */
export async function decideToolCall($: EngineInterface, cache: LoopCache, e: ToolCallInput): Promise<ToolDecision> {
  const isMain = e.agentId === undefined
  if ((await read($, isOn)) !== true) return { isMain, opensPr: false, merges: [], notes: [] }
  const input = e as unknown as Record<string, unknown> & { tool: string }
  const context = await loopContextOf($, cache)
  const settings = context?.settings ?? settingsOf({})
  const agent = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
  const allowed = { isMain, agentId: e.agentId, agent, opensPr: false, merges: [] as string[], notes: [] as string[] }

  if (isMain && settings.isThinMainThread && (await read($, mode)) === 'coding') {
    const verdict = mainThreadVerdict(input, settings, await read($, mainThreadReads), $.plugin.root, await mainThreadAsks($))
    if (!verdict.isAllowed) return { deny: verdict.reason }
    if (verdict.isRead === true) await update($, mainThreadReads, count => count + 1)
  }
  // No readable note (setup mode): the loop rules are not known yet.
  if (context === undefined) return allowed
  if (isMain && input.tool === 'SendMessage' && (await read($, mode)) === 'coding') {
    const refusal = await messageFixRoundRefusal($, context, input.to)
    if (refusal !== undefined) return { deny: refusal }
  }

  const held: Risky[] = []
  if (EDIT_TOOLS.includes(input.tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (path !== undefined && agent?.role === 'dev') {
      const refusal = await devEditRefusal($, cache, context, agent, path)
      if (refusal !== undefined) return { deny: refusal }
    }
  }
  if (TICKET_DELETE.test(input.tool)) held.push({ action: 'delete-ticket', target: String(input.issueIdOrKey ?? 'the ticket').trim().toUpperCase() })
  const ticketEdit = TICKET_EDIT.test(input.tool) ? String(input.issueIdOrKey ?? '').trim().toUpperCase() : ''
  if (ticketEdit !== '' && settings.care === 'careful') {
    const owner = await jiraOwnership($, context.project, ticketEdit)
    if (!owner.isOwn) held.push({ action: 'others-ticket', target: ticketEdit, state: owner.why })
  }
  const asks: Ask[] = []
  if (input.tool === 'Bash' && typeof input.command === 'string') {
    const command = input.command
    for (const step of classifyShell(command)) {
      const refusal = await projectRuleRefusal($, context, step, command)
      if (refusal !== undefined) return { deny: refusal }
      const isMerge = step.action === 'pr-merge' && step.isUndo !== true
      if ((isMerge || (step.action === 'pr-ready' && step.isUndo !== true)) && step.pr === undefined) return { deny: unnamedPrRefusal(step) }
      if (isMerge && step.pr !== undefined) {
        const decision = await mergeDecision($, cache, context, step, step.pr)
        if (decision.deny !== undefined) return { deny: decision.deny }
        allowed.notes.push(...decision.notes)
        asks.push(...decision.asks)
      }
      if (step.action === 'pr-ready' && step.isUndo !== true && step.pr !== undefined) {
        const refusal = await readyRefusal($, cache, context, step.pr)
        if (refusal !== undefined) return { deny: refusal }
      }
      if (settings.care === 'careful') held.push(...(await riskyIn($, cache, context, step, agent)))
      if (step.action === 'pr-open') allowed.opensPr = true
      // A merge that runs now, not one armed for later: what happens after it depends on the QA mode (D69).
      if (isMerge && step.isAuto !== true && step.pr !== undefined) allowed.merges.push(step.pr)
    }
  }
  if (held.length > 0) {
    const missing = await withAsks($, held)
    if (missing.length > 0) return { deny: riskyRefusal(missing) }
  }
  for (const ask of asks) await takeAsk($, ask.action, ask.target)
  return allowed
}

/** How long a recorded ask stays usable. */
const UNLOCK_TTL_MS = 60 * 60_000

/** One recorded ask, as a gate looks it up. */
type Ask = { action: AskAction; target: string }

async function liveUnlocks($: EngineInterface) {
  const now = await $.clock.now()
  return (await read($, unlocks)).filter(unlock => now - unlock.at < UNLOCK_TTL_MS)
}

/** Whether the person's ask for this action on this target is recorded and still fresh. */
async function hasAsk($: EngineInterface, action: AskAction, target: string) {
  return (await liveUnlocks($)).some(unlock => unlock.action === action && targetKey(unlock.target) === targetKey(target))
}

/** Uses up the person's ask for this action on this target: one ask, one action. Resolves whether there was one. */
async function takeAsk($: EngineInterface, action: AskAction, target: string, isUsed = true) {
  const live = await liveUnlocks($)
  const found = live.find(unlock => unlock.action === action && targetKey(unlock.target) === targetKey(target))
  if (found === undefined) return false
  if (isUsed) await update($, unlocks, () => live.filter(unlock => unlock !== found))
  return true
}

/** The tools the person asked the PM to use itself, for their current message (D78). */
async function mainThreadAsks($: EngineInterface) {
  return (await liveUnlocks($)).filter(unlock => unlock.action === 'main-thread').map(unlock => unlock.target)
}

/**
 * The risky actions no recorded ask covers. When every one is covered, their asks are used
 * up: one ask, one action on one target (D78).
 */
async function withAsks($: EngineInterface, held: readonly Risky[]): Promise<Risky[]> {
  const live = await liveUnlocks($)
  const used = new Set<Unlock>()
  const missing = held.filter(entry => {
    const found = live.find(unlock => !used.has(unlock) && unlock.action === entry.action && targetKey(unlock.target) === targetKey(entry.target))
    if (found !== undefined) used.add(found)
    return found === undefined
  })
  if (missing.length === 0) await update($, unlocks, () => live.filter(unlock => !used.has(unlock)))
  return missing
}

/**
 * Whether a branch holds pushed work, read live (D78): `origin` has it. A read that fails is
 * tried again once; when it still fails, the push counts as over pushed work, with why.
 */
async function pushedState($: EngineInterface, context: LoopContext, branch: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await $.process.run(['git', 'ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: context.project.root }).catch(() => undefined)
    if (result?.exitCode === 0) return `${branch} is on origin`
    if (result?.exitCode === 2) return undefined
  }
  return `godmode could not read whether ${branch} is on origin`
}

/** A branch godmode made: its ticket branch prefix, and no open PR on it from someone else. */
async function isOwnBranch($: EngineInterface, cache: LoopCache, context: LoopContext, branch: string) {
  if (!targetKey(branch).startsWith(context.settings.branchPrefix.toLowerCase())) return false
  const pr = (await openPullRequests($, cache, context).catch(() => [])).find(candidate => targetKey(candidate.branch) === targetKey(branch))
  if (pr === undefined) return true
  return (await prOwnerOf($, cache, context, pr.ref)).kind === 'mine'
}

/** The PR actions that act on a PR: on someone else's, a risky action (D78). Comments and reviews that do not approve stay free. */
const ACTS_ON_PR: readonly string[] = ['pr-ready', 'pr-edit']

/**
 * The risky actions in one shell step under "careful" (D78): approving or closing a PR,
 * deleting a branch godmode did not make, force-pushing over pushed work, and acting on someone
 * else's PR. Merging is the merge gate's. Each is read live, and a read that fails asks the
 * person, saying so. Every other write is free.
 */
async function riskyIn($: EngineInterface, cache: LoopCache, context: LoopContext, step: ShellStep, agent: DispatchedAgent | undefined): Promise<Risky[]> {
  const pr = step.pr ?? 'the current branch\'s PR'
  const found: Risky[] = []
  if (step.action === 'pr-approve') found.push({ action: 'approve-pr', target: pr })
  if (step.verb === 'gh pr close') found.push({ action: 'close-pr', target: pr })
  if (step.isApi === true && step.action === 'host-write' && step.endpoint !== undefined && /\/pulls\/\d+\/reviews/.test(step.endpoint)) found.push({ action: 'approve-pr', target: step.endpoint })
  for (const branch of step.deletes ?? []) if (!(await isOwnBranch($, cache, context, branch))) found.push({ action: 'delete-branch', target: branch })
  if (step.action === 'force-push') {
    const branch = step.branch ?? agent?.branch
    const state = branch === undefined ? 'the current branch, which godmode cannot name' : await pushedState($, context, branch)
    if (state !== undefined) found.push({ action: 'force-push', target: branch ?? 'the current branch', state })
  }
  // Merging, approving and closing are risky on any PR already; the rest acts on someone else's work.
  const isOthersStep = ACTS_ON_PR.includes(step.action) && step.pr !== undefined && step.verb !== 'gh pr close'
  if (isOthersStep && step.pr !== undefined) {
    const owner = await prOwnerOf($, cache, context, step.pr)
    if (owner.kind === 'others') found.push({ action: 'others-pr', target: step.pr, state: `opened by ${owner.author}` })
    if (owner.kind === 'unknown') found.push({ action: 'others-pr', target: step.pr, state: owner.reason })
  }
  if ((step.action === 'push' || step.action === 'force-push') && step.branch !== undefined) {
    const open = (await openPullRequests($, cache, context).catch(() => [])).find(candidate => targetKey(candidate.branch) === targetKey(step.branch ?? ''))
    const owner = open === undefined ? undefined : await prOwnerOf($, cache, context, open.ref)
    if (open !== undefined && owner?.kind === 'others') found.push({ action: 'others-pr', target: open.ref, state: `its branch ${step.branch} is ${owner.author}'s PR` })
  }
  return found
}

/** The `allow_once` tool: the PM records the person's explicit ask (D78). */
export const ALLOW_ONCE_TOOL: ToolSpec & { name: 'allow_once' } = {
  name: 'allow_once',
  description:
    'Record that the person explicitly asked, in their current message, for one action that godmode asks about first: merging a PR (merge), merging one whose conditions are not met (merge-anyway), approving or closing a PR, deleting a branch or a ticket, force-pushing over pushed work, acting on someone else\'s PR or ticket; or doing work on this thread yourself (main-thread, target: the tool), or one more agent past the cap (extra-agent). It lets that one action run once, by you or the agent you dispatch for it; main-thread holds until the person\'s next message. Only the main thread may call it, and only on the person\'s own words, never on your initiative.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ASKS] },
      target: { type: 'string', description: 'The PR number, the branch, the ticket key or the tool, as the refusal named it.' },
      ask: { type: 'string', description: 'The person\'s words that ask for it, quoted.' },
    },
    required: ['action', 'target', 'ask'],
  },
  isDeferred: false,
}

/** Serves `allow_once`: the main thread alone records an ask; an agent never unlocks anything. */
export async function serveAllowOnce($: EngineInterface, e: { agentId?: string } & Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so it asks nothing first.' }
  if (e.agentId !== undefined) return { deny: 'Only the PM records the person\'s ask, on the main thread. Report to the PM what you need the person to ask for. Nothing was recorded.' }
  const action = ASKS.find(name => name === e.action)
  const target = typeof e.target === 'string' ? e.target.trim() : ''
  const ask = typeof e.ask === 'string' ? e.ask.trim() : ''
  if (action === undefined || target === '' || ask === '') {
    return { deny: `allow_once needs \`action\` (${ASKS.join(', ')}), \`target\` and \`ask\`, the person's own words. Nothing was recorded.` }
  }
  const at = await $.clock.now()
  await update($, unlocks, current => [...current.filter(unlock => at - unlock.at < UNLOCK_TTL_MS), { action, target, ask, at }])
  const lasts = action === 'main-thread' ? 'It holds until their next message.' : 'It runs once, within the hour.'
  return { result: `Recorded: the person asked for ${action} on ${target}. ${lasts}` }
}

/** The person's next message ends the asks to work on this thread: each holds for one message (D78). */
export async function endMainThreadAsks($: EngineInterface) {
  const current = await read($, unlocks)
  if (current.some(unlock => unlock.action === 'main-thread')) await update($, unlocks, () => current.filter(unlock => unlock.action !== 'main-thread'))
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
    return backendFor($, trackerOf(context.note.shared.answers), context.note.dir, context.answers)
  } catch {
    return undefined
  }
}

/**
 * Records a dev agent's new draft PR on its ticket, then moves the ticket to review: two
 * steps, so a move the board refuses (no review status mapped, no way there) keeps the PR
 * link. A ticket waiting in qa stays there untouched: it leaves qa only with a pass (D69),
 * never on a new PR. Resolves the line for the PM: what to do by hand when a step failed,
 * or the move to mirror in a tracker godmode cannot reach (Other, D25).
 */
async function recordDraftPr($: EngineInterface, context: LoopContext, agent: DispatchedAgent & { ticket: string }, url: string) {
  const { ticket, branch } = agent
  const backend = backendOrNothing($, context)
  if (backend === undefined) return undefined
  const current = (await backend.list({ statuses: ['qa'] }).catch(() => [])).find(header => header.id.toUpperCase() === ticket.toUpperCase())
  if (current !== undefined) return undefined
  const linked = await backend.move(ticket, { pr: url }).then(
    () => undefined,
    (error: unknown) => messageOf(error),
  )
  if (linked !== undefined) {
    return `godmode could not record PR ${url} on ${ticket} (${linked}), nor move it to review. Set both with ticket_move (id: ${ticket}, pr: ${url}, status: review).`
  }
  const moved = await backend.move(ticket, { status: 'review' }).then(
    () => undefined,
    (error: unknown) => messageOf(error),
  )
  if (moved !== undefined) {
    return `godmode recorded PR ${url} on ${ticket}, but could not move it to review: ${moved} Move ${ticket} to review by hand on the board, or fix the status mapping with \`/godmode setup\`.`
  }
  return backend.mirror?.(`move ${ticket} to review with PR ${url}${branch === undefined ? '' : `, on branch ${branch}`}`)
}

/** Takes the draft PRs waiting for a review start, and says what the PM does next (D35). */
export async function takePendingReviews($: EngineInterface) {
  const pending = await read($, pendingReviews)
  if (pending.length === 0) return undefined
  await update($, pendingReviews, () => [])
  const lines = pending.flatMap(review => [
    `- PR #${review.pr}${review.url === undefined ? '' : ` (${review.url})`}${review.ticket === undefined ? '' : ` for ${review.ticket}`}, opened by dev agent ${review.agentId}`,
    ...(review.mirror === undefined ? [] : [`  ${review.mirror}`]),
  ])
  return [
    `godmode: ${pending.length === 1 ? 'a dev agent opened a draft PR' : 'dev agents opened draft PRs'}. Start each review now, without waiting to be asked: dispatch one godmode:reviewer agent per PR.`,
    ...lines,
    'The reviewer records its verdict with review_verdict. A PR is marked ready or merged only with a clean verdict at its current commit.',
  ].join('\n')
}

/**
 * What the gate adds once a call ran: a dev agent's new draft PR is queued for review (D35);
 * a merge in `human-staging` sends its ticket to qa (D69); a main-thread result carries the
 * queue to the PM.
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
    if (url !== undefined && pr !== undefined) {
      const { ticket } = agent
      const mirror = ticket === undefined ? undefined : await recordDraftPr($, context, { ...agent, ticket }, url)
      const review: PendingReview = { pr, url, agentId, ticket, mirror }
      await update($, pendingReviews, queue => [...queue.filter(entry => entry.pr !== pr), review])
      extra.push(`godmode recorded draft PR #${pr} and tells the PM to start its review. Your part is done: stop here and report the PR link.`)
    }
  }
  if (context !== undefined) {
    for (const pr of decision.merges) await clearFixRoundsOfPr($, context, pr)
  }
  extra.push(...decision.notes)
  if (context?.settings.qaMode === 'human-staging') {
    for (const pr of decision.merges) extra.push(...(await afterStagingMerge($, context, pr)))
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

/**
 * The conventions the setup recorded (Step 3), as absolute paths, so every godmode agent
 * reads them wherever the storage keeps them: a gitignored or outside-the-repo file is
 * never loaded on its own.
 */
export const conventionsBrief = (context: Pick<LoopContext, 'project' | 'note'>) => {
  const paths = context.note.shared.conventions.map(file => (file.path.startsWith('/') ? file.path : `${context.project.root}/${file.path}`))
  if (paths.length === 0) return undefined
  return ['---', 'The project\'s conventions (from godmode\'s setup). Read the ones your work touches before you start, and follow them:', ...paths.map(path => `- ${path}`)].join('\n')
}

/** What godmode adds to a dev agent's brief: its ticket, worktree, and the files other PRs hold (D38, D47). */
export const devBrief = (ticket: { id: string; title: string }, worktree: string, branch: string, held: readonly PullRequest[] | undefined, unlisted?: string) => {
  const lines = [
    '---',
    'From godmode (added to this brief by the mod):',
    `- Ticket: ${ticket.id}, "${ticket.title}".`,
    `- Your worktree: ${worktree}, on branch ${branch}. Work, run commands and commit only there: an edit outside it is refused.`,
  ]
  if (unlisted !== undefined) lines.push(`- godmode could not list the open PRs' files just now (${unlisted}). Before editing a file others may be changing, check \`gh pr list\`, and stop and report a clash.`)
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

/** A dev agent's dispatch: a ready ticket (D52) within its fix-round limit (D56), its worktree, and the contention sweep in its brief (D47). */
async function planDevSpawn($: EngineInterface, cache: LoopCache, context: LoopContext, e: AgentSpawnInput): Promise<SpawnPlan> {
  const { settings, project } = context
  let backend: TicketBackend
  try {
    backend = backendFor($, trackerOf(context.note.shared.answers), context.note.dir)
  } catch (error) {
    return { deny: `godmode cannot read the tickets to check this dispatch: ${messageOf(error)}` }
  }
  // Only Jira names its own ids; None and Other both keep godmode's markdown `T-n` (D25).
  const id = ticketIn(e.prompt, backend.tracker !== 'jira')
  if (id === undefined) {
    return { deny: 'A dev agent builds one ticket, and this brief names none. Name the ticket (e.g. T-3) in the brief, then dispatch again.' }
  }
  let tickets: TicketHeader[]
  try {
    tickets = await backend.list({ statuses: TICKET_STATUSES })
  } catch (error) {
    return { deny: `godmode could not read the tickets just now (${messageOf(error)}), so it cannot make ${id}'s worktree and brief. Try again once they can be read.` }
  }
  const ticket = tickets.find(header => header.id.toUpperCase() === id)
  if (ticket === undefined) return { deny: `The brief names ${id}, and there is no such ticket. File it first, or fix the id.` }
  if (ticket.status === 'done') return { deny: `${ticket.id} is done; a dev agent does not start on a done ticket.` }
  if (settings.requiresReadyTicket && !ticket.ready) {
    return {
      deny: `${ticket.id} is not marked ready: a dev agent starts only on a ticket the person said go for. When the person says go, mark it with ticket_move (ready: true) and dispatch again.`,
    }
  }
  const pastLimit = await fixRoundRefusal($, context, ticket)
  if (pastLimit !== undefined) return { deny: pastLimit }
  const branch = ticket.branch ?? `${settings.branchPrefix}${ticket.id.toLowerCase()}-${slugOf(ticket.title)}`
  const worktree = worktreePathOf(project, settings, ticket.id)
  const refusal = await ensureWorktree($, project, settings, worktree, branch)
  if (refusal !== undefined) return { deny: refusal }
  if (ticket.branch === undefined) await backend.move(ticket.id, { branch }).catch(() => undefined)

  let held: PullRequest[] | undefined
  let unlisted: string | undefined
  if (settings.isContentionOn) {
    // A list that cannot be read never stops the dispatch (D78): the brief says so instead.
    held = await openPullRequests($, cache, context, true).then(
      prs => prs.filter(pr => pr.branch !== branch && pr.files.length > 0),
      (error: unknown) => {
        unlisted = messageOf(error)
        return undefined
      },
    )
  }
  const conventions = conventionsBrief(context)
  return {
    input: {
      ...e,
      prompt: [e.prompt, devBrief(ticket, worktree, branch, held, unlisted), conventions].filter(part => part !== undefined).join('\n\n'),
      cwd: worktree,
    },
    record: { role: 'dev', ticket: ticket.id, worktree, branch, name: e.name },
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
  if (running.length >= settings.agentCap && !(await takeAsk($, 'extra-agent', 'agent'))) {
    const names = running.map(agent => agent.description || agent.type).slice(0, 8).join('; ')
    return {
      deny: `godmode runs at most ${settings.agentCap} agents at once, and ${running.length} are running (${names}). Wait for one to finish, or stop one, then dispatch again. If the person asks for this one to start now, record their words with mcp__godmode__allow_once (action: extra-agent, target: agent), then dispatch again.`,
    }
  }
  const role = roleOf(e.subagentType)
  if (role === undefined) return { input: e }
  // A workflow's agent can only be refused, not rewritten; a dev one is noted, so a resume leaves its ticket to the workflow.
  if (e.workflow !== undefined) {
    const ticket = role === 'dev' && context !== undefined ? ticketIn(e.prompt, trackerOf(context.note.shared.answers) !== 'jira') : undefined
    return { input: e, record: ticket === undefined ? { role } : { role, ticket, isWorkflow: true } }
  }
  // A SendMessage wakes a finished agent through a resume, which the message's own gate
  // already counted and limited; its brief need not name the ticket, and its record stands.
  if (e.resume !== undefined) return { input: e }
  const model = spawnModel(e.model, role, context?.note)
  const input = model === e.model ? e : { ...e, model }
  if (context === undefined || role === 'setup' || (await read($, mode)) !== 'coding') return { input, record: { role } }
  if (role !== 'dev') {
    const conventions = conventionsBrief(context)
    return { input: conventions === undefined ? input : { ...input, prompt: `${input.prompt}\n\n${conventions}` }, record: { role } }
  }
  return planDevSpawn($, cache, context, input)
}

/** Remembers a started agent's role, so its tool calls meet its role's rules. */
export async function recordAgent($: EngineInterface, agentId: string, record: DispatchedAgent) {
  // A resumed agent's spawn may not carry its name again; SendMessage still addresses it by it.
  await update($, agents, known => ({ ...known, [agentId]: { ...record, name: record.name ?? known[agentId]?.name } }))
}

// ---------------------------------------------------------------------------
// This person's own dev dispatches (D57)

/**
 * The last dev agent this person's godmode dispatched on a ticket: kept in their own store
 * across sessions, so a resume picks up only their work, never a teammate's ticket that
 * merely sits in progress. `isWorkflow` when a workflow launched it; `endedAsking` when it
 * ended by asking the person something, as its last report reads.
 */
export type DevDispatch = { agentId: string; at: string; isWorkflow?: boolean; endedAsking?: boolean }

const devDispatchesKey = (project: Project) => `devDispatches:${project.id}`

const isDevDispatch = (value: unknown): value is DevDispatch =>
  typeof value === 'object' && value !== null && typeof (value as DevDispatch).agentId === 'string' && typeof (value as DevDispatch).at === 'string'

/** This person's dev dispatches, by ticket id in upper case. */
export async function readDevDispatches($: EngineInterface, project: Project): Promise<Record<string, DevDispatch>> {
  const value: unknown = await $.store.get(devDispatchesKey(project))
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, DevDispatch] => isDevDispatch(entry[1])))
}

/** Notes a dev agent's dispatch on its ticket in the person's store. */
export async function recordDevDispatch($: EngineInterface, cache: LoopCache, agentId: string, record: DispatchedAgent) {
  if (record.role !== 'dev' || record.ticket === undefined) return
  const context = await loopContextOf($, cache)
  if (context === undefined) return
  const entry: DevDispatch = { agentId, at: new Date(await $.clock.now()).toISOString(), ...(record.isWorkflow === true ? { isWorkflow: true } : {}) }
  await $.store.set(devDispatchesKey(context.project), { ...(await readDevDispatches($, context.project)), [record.ticket.toUpperCase()]: entry })
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

/**
 * Whether a dev agent's last report ends by asking the person something: no PR link, and a
 * question in its last lines. The dev agent stops and reports a question when the ticket
 * needs a product decision; a report that opened its PR is done, whatever it asks.
 */
export const endsAsking = (report: string) => {
  if (/\/pull\/\d+|\/merge_requests\/\d+/.test(report)) return false
  const lines = report
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  return lines.slice(-3).some(line => line.includes('?'))
}

/**
 * Reads the task notifications in a delivery: a dev agent that ended has its dispatch
 * marked with whether its last report asked the person something.
 */
export async function noteDevEnds($: EngineInterface, cache: LoopCache, text: string) {
  if (!text.includes('<task-notification>')) return
  const known = await read($, agents)
  const ends: { ticket: string; agentId: string; isAsking: boolean }[] = []
  for (const [, body = ''] of text.matchAll(NOTIFICATION)) {
    const agentId = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
    const agent = agentId === undefined ? undefined : known[agentId]
    if (agentId === undefined || agent?.role !== 'dev' || agent.ticket === undefined) continue
    ends.push({ ticket: agent.ticket.toUpperCase(), agentId, isAsking: endsAsking(/<result>([\s\S]*?)<\/result>/.exec(body)?.[1] ?? '') })
  }
  if (ends.length === 0) return
  const context = await loopContextOf($, cache)
  if (context === undefined) return
  const all = await readDevDispatches($, context.project)
  for (const end of ends) {
    const entry = all[end.ticket]
    if (entry?.agentId === end.agentId) all[end.ticket] = { ...entry, endedAsking: end.isAsking }
  }
  await $.store.set(devDispatchesKey(context.project), all)
}
