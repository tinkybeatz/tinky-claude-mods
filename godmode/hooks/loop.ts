import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, ToolCallInput, ToolCallResult, ToolSpec } from 'claude-code'

import type { DispatchedAgent, GodmodeMode, PendingReview, Unlock } from '../types'
import { chooseHost, HostError, hostFor, prNumberOf } from './host'
import type { GitHost, HostKind, PullRequest } from './host'
import {
  ACTION_WORDS,
  attributionIn,
  carriesText,
  classifyShell,
  howToChange,
  isHumanQaMode,
  isInside,
  mainThreadVerdict,
  normalisePath,
  controlledRefusal,
  CONTROLLED,
  OVERRIDE_HINT,
  qaGateRefusal,
  qaMoveRefusal,
  relativeTo,
  roleOf,
  SCRATCH_FOLDERS,
  SETTING,
  settingsOf,
  spawnModel,
  targetKey,
  ticketIn,
  waitsOnPeople,
} from './rules'
import type { Controlled, ControlledAction, LoopSettings, ShellStep } from './rules'
import { jiraOwnership } from './jira'
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
const indicator = atom({ plugin: 'godmode', key: 'indicator' } as const, 'mode' as 'mode' | 'hint' | 'band')
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
  /** The person's own login on the host, once looked up; null when it could not be. */
  login?: string | null
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

/** The person's own login on GitHub, so godmode can tell their PRs from others' (D18, D74). */
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

/**
 * What follows a clean review in the project's QA mode. In `human-pr` a visible change
 * moves to qa for people to test, unless the QA agent tests it first (D71); the other
 * modes keep Step 7's flow, where the PM runs bot QA (D35).
 */
async function afterCleanReview($: EngineInterface, context: LoopContext, pr: string) {
  const plain = ' It may now be marked ready; a new commit needs a new review.'
  const { settings } = context
  if (settings.qaMode === 'bot') return afterCleanReviewInBot($, context, pr, plain)
  if (settings.qaMode !== 'human-pr') return plain
  const gate = 'and the PR is marked ready only once their pass is recorded at its current commit'
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found || found.tickets.length === 0) {
    return ` People test this PR before it is marked ready (QA mode human-pr), ${gate}. godmode found no ticket naming PR #${pr}: the PM sets the PR on its ticket and moves that ticket to qa.`
  }
  const tested = found.tickets.filter(ticket => waitsOnPeople(settings.qaMode, ticket))
  if (tested.length === 0) return plain
  if (settings.isQaBotFirst) {
    const ids = idsOf(tested)
    return ` Next the QA agent tests ${ids}; once it passes, ${ids} ${tested.length === 1 ? 'moves' : 'move'} to qa for people to test, ${gate}.`
  }
  const lines: string[] = []
  const mirrors: string[] = []
  for (const ticket of tested) {
    if (ticket.status === 'qa' || ticket.status === 'done') {
      lines.push(`${ticket.id} waits in qa for people to test it`)
      continue
    }
    const moved = await moveToQa($, context, ticket.id)
    lines.push(moved === undefined ? `godmode could not move ${ticket.id} to qa, so the PM moves it` : `godmode moved ${ticket.id} to qa`)
    if (moved?.mirror !== undefined) mirrors.push(moved.mirror)
  }
  return [` ${lines.join('; ')}: people test the PR now (QA mode human-pr), ${gate}.`, ...mirrors].join('\n')
}

/** In `bot`, a clean review of a visible change is followed by the QA agent's test, which the ready gate waits on (D35). */
async function afterCleanReviewInBot($: EngineInterface, context: LoopContext, pr: string, plain: string) {
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found || found.tickets.length === 0) {
    return ` The QA agent tests a visible change before its PR is marked ready (QA mode bot). godmode found no ticket naming PR #${pr}: the PM sets the PR on its ticket with ticket_move (pr: ${pr}).`
  }
  const tested = found.tickets.filter(ticket => ticket.visibleChange)
  if (tested.length === 0) return plain
  return ` Next the QA agent tests ${idsOf(tested)} at this commit; the PR is marked ready only once its pass is recorded there (QA mode bot).`
}

/** After a merge in `human-staging`, each visible change the PR carries goes to qa, not done: people test it on staging (D69). */
async function afterStagingMerge($: EngineInterface, context: LoopContext, pr: string) {
  const found = await ticketsOfPr($, context, pr)
  const tickets = 'error' in found ? [] : found.tickets
  const rule = 'people test it on staging after the merge (QA mode human-staging), and it leaves qa only once their pass is recorded with ticket_move (qaResult: passed)'
  if (tickets.length === 0) return [`godmode found no ticket naming PR #${pr}. If it has one with a visible change, move that ticket to qa, not done: ${rule}.`]
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
  const { qaMode } = context.settings
  if (!waitsOnPeople(qaMode, ticket)) return ' With a clean review at this commit, its PR may now be marked ready.'
  if (qaMode === 'human-staging') return ' With a clean review at this commit, its PR may be merged on the person\'s go; people then test it on staging.'
  if (ticket.status === 'qa' || ticket.status === 'done') return ` ${ticket.id} waits in qa for people to test it.`
  return (await moveToQa($, context, ticket.id))
    ? ` godmode moved ${ticket.id} to qa: people test it now (QA mode human-pr), and the PR is marked ready only once their pass is recorded at its current commit.`
    : ` godmode could not move ${ticket.id} to qa, so the PM moves it: people test it next (QA mode human-pr).`
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
    return `This would be ${roundOf(count, allowed)} on ${ticket.id}, past the fix-round limit, so ${start.stopped}. Stop and ask the person what to do, saying what keeps failing. If they say to go on, allow more rounds with ticket_move (id: ${ticket.id}, moreFixRounds: 1 or more), then ${start.retry}. To change the limit for every ticket, ${howToChange(SETTING.fixRoundLimit)}.`
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
    // A Jira ticket godmode did not file is moved only when the person created it, or asked for it (D74).
    if (ticket === undefined && trackerOf(context.note.shared.answers) === 'jira') {
      const owner = await jiraOwnership($, context.project, wanted)
      if (!owner.isOwn) {
        const held = await withUnlocks($, [{ action: 'edit-ticket', target: wanted, reason: owner.why }])
        if (held.length > 0) throw new TicketError(controlledRefusal(held))
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

const doingOf = (step: ShellStep) => (step.action === 'pr-ready' ? 'marked ready' : step.action === 'pr-approve' ? 'approved' : 'merged')

/** Why a gated step that names no PR is refused: godmode cannot tell which PR's verdict and tickets to check. */
const unnamedPrRefusal = (step: ShellStep) => {
  const doing = doingOf(step)
  if (step.isApi === true) {
    const plain = step.action === 'pr-ready' ? 'gh pr ready 12' : 'gh pr merge 12'
    return `godmode cannot tell which PR this \`gh api\` call would have ${doing}, so it cannot check its review and QA first. Use \`${plain}\` with the PR's number instead. Nothing ran.`
  }
  return `Name the PR by number (\`${step.verb} 12\`) so godmode can check its review verdict and its tickets before it is ${doing}. Nothing ran.`
}

/** Why auto-merge is refused in a human QA mode (D53, D69), whatever the auto-merge setting says. */
const autoMergeInHumanQaRefusal = (qaMode: LoopSettings['qaMode'], step: ShellStep) => {
  const pr = step.pr ?? '12'
  const why =
    qaMode === 'human-pr'
      ? 'auto-merge would merge a later commit that people never tested'
      : 'auto-merge would merge without godmode seeing it, so the ticket would never move to qa for people to test on staging'
  return `In QA mode ${qaMode}, a PR is never armed for auto-merge: ${why}. Merge it directly (\`gh pr merge ${pr}\`) on the person's go. Nothing ran. To change how this project is tested, ${howToChange(SETTING.qaMode)}.`
}

/**
 * Why a PR may not be marked ready or merged yet, or undefined when nothing holds it: a
 * clean review verdict at its current commit (D53), then in `human-pr` a QA pass at that
 * commit (D69) for every ticket the PR carries.
 */
async function readyRefusal($: EngineInterface, context: LoopContext, step: ShellStep, pr: string) {
  const doing = doingOf(step)
  const label = `PR #${pr}`
  const choice = await hostOf($, context)
  if ('error' in choice) return `godmode could not reach the git host to check ${label}'s review (${choice.error}). Nothing ran.`
  let head: string
  try {
    head = await choice.host.headCommit(pr)
  } catch (error) {
    return `godmode could not read ${label}'s head commit (${messageOf(error)}), so it cannot check its review verdict. Nothing ran; try again once the host answers.`
  }
  if (context.settings.isMergeGateOn) {
    const record = (await readVerdicts($, context.project))[pr]
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
  }
  if (context.settings.qaMode === 'bot') return botReadyRefusal($, context, pr, doing, head)
  if (context.settings.qaMode !== 'human-pr') return undefined
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found) return `godmode could not read the tickets to check whether ${label} waits on QA (${found.error}). Nothing ran; try again once the tickets can be read.`
  if (found.tickets.length === 0) return qaGateRefusal(context.settings, pr, doing, undefined, head)
  // A PR that carries several tickets waits on each one's own pass.
  for (const ticket of found.tickets) {
    const refusal = qaGateRefusal(context.settings, pr, doing, ticket, head)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/**
 * In `bot`, why a PR may not be marked ready or merged yet: each visible change it carries
 * needs the QA agent's pass, or the person's skip, at its current commit (D35, D36).
 */
async function botReadyRefusal($: EngineInterface, context: LoopContext, pr: string, doing: string, head: string) {
  const label = `PR #${pr}`
  const found = await ticketsOfPr($, context, pr)
  if ('error' in found) return `godmode could not read the tickets to check whether ${label} waits on the QA agent (${found.error}). Nothing ran; try again once the tickets can be read.`
  if (found.tickets.length === 0) {
    return `In this project the QA agent tests a visible change before its PR is ${doing} (QA mode bot), and no ticket names ${label}, so godmode cannot tell whether it waits on QA. Set the PR on its ticket with ticket_move (pr: ${pr}), then try again. Nothing ran.`
  }
  const records = await readBotQa($, context.project)
  for (const ticket of found.tickets) {
    if (!ticket.visibleChange) continue
    const refusal = botQaRefusal(ticket, records[ticket.id], head, `${label} cannot be ${doing}`)
    if (refusal !== undefined) return refusal.replace(/Nothing changed\.$/, 'Nothing ran.')
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The tool-call gate

/** What the gate decided: a refusal, or what `afterToolCall` needs once the call ran. */
export type ToolDecision =
  | { deny: string }
  | { deny?: undefined; isMain: boolean; agentId?: string; agent?: DispatchedAgent; opensPr: boolean; merges: string[] }

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

/** The hard rules that refuse a shell step outright: drafts, attribution, auto-merge, the verdict and QA gate. */
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
  // Approving once review and QA passed (D74) waits on the same gate as ready and merge.
  const isApprovalGated = step.action === 'pr-approve' && settings.prApproval === 'when-passed'
  const isGated = (step.action === 'pr-ready' || step.action === 'pr-merge' || isApprovalGated) && step.isUndo !== true
  if (!isGated) return undefined
  const isAuto = step.action === 'pr-merge' && step.isAuto === true
  if (isAuto && isHumanQaMode(settings.qaMode)) return autoMergeInHumanQaRefusal(settings.qaMode, step)
  if (isAuto && !settings.isAutoMergeOn) {
    return `Auto-merge is off: a PR is merged only once the person says so. Tell them the PR is ready for their go instead. To arm auto-merge on its own, ${howToChange(SETTING.autoMerge)}.`
  }
  const isChecked = settings.isMergeGateOn || settings.qaMode === 'human-pr' || settings.qaMode === 'bot'
  // In human-staging a merge moves its tickets to qa, so its PR must be known even with the merge gate off.
  const isStagingMerge = settings.qaMode === 'human-staging' && step.action === 'pr-merge'
  if (step.pr === undefined) return isChecked || isStagingMerge ? unnamedPrRefusal(step) : undefined
  return isChecked ? readyRefusal($, context, step, step.pr) : undefined
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

/**
 * The gate every tool call passes while godmode is on: the thin main thread (D63), the
 * dev agent's worktree and held files (D38, D48), drafts, attribution and the verdict
 * gate (D15, D53), then the few writes that wait for the person's yes (D74), asked directly (D66).
 */
export async function decideToolCall($: EngineInterface, cache: LoopCache, e: ToolCallInput): Promise<ToolDecision> {
  const isMain = e.agentId === undefined
  if ((await read($, isOn)) !== true) return { isMain, opensPr: false, merges: [] }
  const input = e as unknown as Record<string, unknown> & { tool: string }
  const context = await loopContextOf($, cache)
  const settings = context?.settings ?? settingsOf({})
  const agent = e.agentId === undefined ? undefined : (await read($, agents))[e.agentId]
  const allowed = { isMain, agentId: e.agentId, agent, opensPr: false, merges: [] as string[] }

  if (isMain && settings.isThinMainThread && (await read($, mode)) === 'coding') {
    const verdict = mainThreadVerdict(input, settings, await read($, mainThreadReads), $.plugin.root)
    if (!verdict.isAllowed) return { deny: verdict.reason }
    if (verdict.isRead === true) await update($, mainThreadReads, count => count + 1)
  }
  // No readable note (setup mode): the loop rules are not known yet.
  if (context === undefined) return allowed
  if (isMain && input.tool === 'SendMessage' && (await read($, mode)) === 'coding') {
    const refusal = await messageFixRoundRefusal($, context, input.to)
    if (refusal !== undefined) return { deny: refusal }
  }

  const held: Controlled[] = []
  if (EDIT_TOOLS.includes(input.tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (path !== undefined && agent?.role === 'dev') {
      const refusal = await devEditRefusal($, cache, context, agent, path)
      if (refusal !== undefined) return { deny: refusal }
    }
  }
  const ticketEdit = /^mcp__.+__(transitionJiraIssue|editJiraIssue)$/.test(input.tool) ? String(input.issueIdOrKey ?? '').trim().toUpperCase() : ''
  if (ticketEdit !== '') {
    const owner = await jiraOwnership($, context.project, ticketEdit)
    if (!owner.isOwn) held.push({ action: 'edit-ticket', target: ticketEdit, reason: owner.why })
  }
  if (input.tool === 'Bash' && typeof input.command === 'string') {
    const command = input.command
    for (const step of classifyShell(command)) {
      const refusal = await shellRefusal($, context, step, command)
      if (refusal !== undefined) return { deny: refusal }
      held.push(...(await controlledIn($, cache, context, step, agent)))
      if (step.action === 'pr-open') allowed.opensPr = true
      // A merge that runs now, not one armed for later: what happens after it depends on the QA mode (D69).
      if (step.action === 'pr-merge' && step.isAuto !== true && step.isUndo !== true && step.pr !== undefined) allowed.merges.push(step.pr)
    }
  }
  if (held.length === 0) return allowed
  const missing = await withUnlocks($, held)
  return missing.length === 0 ? allowed : { deny: controlledRefusal(missing) }
}

/** How long a recorded ask stays usable. */
const UNLOCK_TTL_MS = 60 * 60_000

/**
 * The controlled actions no recorded ask covers. When every one is covered, their unlocks are
 * used up: one ask, one action on one target (D74).
 */
async function withUnlocks($: EngineInterface, held: readonly Controlled[]): Promise<Controlled[]> {
  const now = await $.clock.now()
  const live = (await read($, unlocks)).filter(unlock => now - unlock.at < UNLOCK_TTL_MS)
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
 * Whether a force-push could overwrite a reviewed commit: the pushed branch has an open PR
 * with a review verdict recorded. Where the PRs cannot be read, it counts as reviewed.
 */
async function isReviewedBranch($: EngineInterface, cache: LoopCache, context: LoopContext, branch: string) {
  const prs = await openPullRequests($, cache, context).catch(() => undefined)
  if (prs === undefined) return true
  const pr = prs.find(candidate => targetKey(candidate.branch) === targetKey(branch))
  return pr !== undefined && (await readVerdicts($, context.project))[pr.ref] !== undefined
}

/**
 * The controlled actions in one shell step (D74): approving a PR (unless the setting lets
 * godmode approve once review and QA passed), closing a PR, deleting a branch whose name does
 * not start with godmode's branch prefix, force-pushing a branch whose PR has a review
 * verdict, and a raw host API write. Every other write is free.
 */
async function controlledIn($: EngineInterface, cache: LoopCache, context: LoopContext, step: ShellStep, agent: DispatchedAgent | undefined): Promise<Controlled[]> {
  const { settings } = context
  const pr = step.pr ?? 'unnamed PR'
  const found: Controlled[] = []
  if (step.action === 'pr-approve' && settings.prApproval === 'ask') found.push({ action: 'approve-pr', target: pr })
  if (step.verb === 'gh pr close') found.push({ action: 'close-pr', target: pr })
  for (const branch of step.deletes ?? []) if (!targetKey(branch).startsWith(settings.branchPrefix.toLowerCase())) found.push({ action: 'delete-branch', target: branch })
  if (step.action === 'force-push') {
    const branch = step.branch ?? agent?.branch
    if (branch === undefined || (await isReviewedBranch($, cache, context, branch))) found.push({ action: 'force-push', target: branch ?? 'the current branch' })
  }
  if (step.action === 'host-write' || step.isApi === true) found.push({ action: 'host-write', target: step.endpoint ?? (step.pr === undefined ? 'gh api' : `PR ${step.pr}`) })
  return found
}

/** The `allow_once` tool: the PM records the person's explicit ask for one controlled action (D74). */
export const ALLOW_ONCE_TOOL: ToolSpec & { name: 'allow_once' } = {
  name: 'allow_once',
  description:
    'Record that the person explicitly asked, in their current message, for one controlled action on one target: approving or closing a PR, deleting a branch godmode did not create, force-pushing over a reviewed commit, editing a ticket godmode did not file, or a raw host API write. It lets that one action run once, by you or the agent you dispatch for it. Only the main thread may call it, and only on the person\'s own words, never on your initiative.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...CONTROLLED] },
      target: { type: 'string', description: 'The PR number, the branch, the ticket key or the API endpoint, as the refusal named it.' },
      ask: { type: 'string', description: 'The person\'s words that ask for it, quoted.' },
    },
    required: ['action', 'target', 'ask'],
  },
  isDeferred: false,
}

/** Serves `allow_once`: the main thread alone records an ask; an agent never unlocks anything. */
export async function serveAllowOnce($: EngineInterface, e: { agentId?: string } & Record<string, unknown>) {
  if ((await read($, isOn)) !== true) return { deny: 'godmode is off, so nothing is controlled.' }
  if (e.agentId !== undefined) return { deny: 'Only the PM records the person\'s ask, on the main thread. Report to the PM what you need the person to ask for. Nothing was recorded.' }
  const action = CONTROLLED.find(name => name === e.action)
  const target = typeof e.target === 'string' ? e.target.trim() : ''
  const ask = typeof e.ask === 'string' ? e.ask.trim() : ''
  if (action === undefined || target === '' || ask === '') {
    return { deny: `allow_once needs \`action\` (${CONTROLLED.join(', ')}), \`target\` and \`ask\`, the person's own words. Nothing was recorded.` }
  }
  const at = await $.clock.now()
  await update($, unlocks, current => [...current.filter(unlock => at - unlock.at < UNLOCK_TTL_MS), { action: action satisfies ControlledAction, target, ask, at }])
  return { result: `Recorded: the person asked for ${action} on ${target}. It runs once, within the hour.` }
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
  const ticket = (await backend.list({ statuses: TICKET_STATUSES })).find(header => header.id.toUpperCase() === id)
  if (ticket === undefined) return { deny: `The brief names ${id}, and there is no such ticket. File it first, or fix the id.` }
  if (ticket.status === 'done') return { deny: `${ticket.id} is done; a dev agent does not start on a done ticket.` }
  if (settings.requiresReadyTicket && !ticket.ready) {
    return {
      deny: `${ticket.id} is not marked ready: a dev agent starts only on a ticket the person said go for. Once they have, mark it with ticket_move (ready: true) and dispatch again. To change the rule, ${howToChange(SETTING.requireReadyTicket)}.`,
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
  if (settings.isContentionOn) {
    try {
      held = (await openPullRequests($, cache, context, true)).filter(pr => pr.branch !== branch && pr.files.length > 0)
    } catch (error) {
      return {
        deny: `godmode could not list the open PRs and their files (${messageOf(error)}), so the dev agent did not start: without that list it could edit a file another PR holds. Try again once the host answers. To change the rule, ${howToChange(SETTING.contention)}.`,
      }
    }
  }
  const conventions = conventionsBrief(context)
  return {
    input: { ...e, prompt: [e.prompt, devBrief(ticket, worktree, branch, held), conventions].filter(part => part !== undefined).join('\n\n'), cwd: worktree },
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
  if (running.length >= settings.agentCap) {
    const names = running.map(agent => agent.description || agent.type).slice(0, 8).join('; ')
    return {
      deny: `godmode runs at most ${settings.agentCap} agents at once, and ${running.length} are running (${names}). Wait for one to finish or stop one, then dispatch again. To change the cap, ${howToChange(SETTING.agentCap)}.`,
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
