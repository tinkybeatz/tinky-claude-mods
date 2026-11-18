import { atom, read } from 'claude-code'
import type { AgentInfo, EngineInterface } from 'claude-code'

import type { DispatchedAgent, GodmodeMode } from '../types'
import type { PullRequest } from './host'
import { allowedOf, loopContextOf, openPullRequests, readBotQa, readDevDispatches, readFixRounds, readVerdicts, RUNNING_STATUSES, worktreePathOf } from './loop'
import type { BotQaRecord, DevDispatch, LoopCache, LoopContext, VerdictRecord } from './loop'
import { qaCheckBlock, quotedTitle } from './qa-check'
import { changedConventions, godmodeVersionOf, isOlderVersion, readNote } from './storage'
import { backendFor, trackerOf } from './tickets'
import type { TicketHeader, TicketStatus } from './tickets'

/*
 * `/godmode report` (D44, D70) and the resume on `/godmode` (D57). The report reads the
 * project as it is now and says it in a few plain lines; it changes nothing. The resume
 * names the tickets that were in progress with no agent of this session on them, one line
 * each for the person, and tells the PM to pick each up. A ticket waiting in qa is not in
 * progress: it gets no resume line and no dev restart (build defaults). Every helper here
 * that takes `$` is a function declaration: the engine follows `$` past an import only into
 * those.
 */

// Made here: `validate` follows a state source only to an atom made in the file that reads it.
const isOn = atom({ plugin: 'godmode', key: 'isOn' } as const, false)
const mode = atom({ plugin: 'godmode', key: 'mode' } as const, 'coding' as GodmodeMode)
const agents = atom({ plugin: 'godmode', key: 'agents' } as const, {} as Record<string, DispatchedAgent>)

/** At most this many entries per list in the report; the rest are counted. */
export const REPORT_LIST_CAP = 10

/** At most this many files named per PR in the report. */
export const REPORT_FILES_CAP = 6

/** How many tickets the report suggests next (D44: two or three). */
export const SUGGESTED_NEXT = 3

/** The statuses a resume picks up (D57); `qa` waits on testers, not on an agent. */
export const RESUMED_STATUSES: readonly TicketStatus[] = ['doing', 'review']

/** Each git read of the resume stops after this, so a slow repo never holds `/godmode` long. */
const GIT_TIMEOUT_MS = 5_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const short = (commit: string) => commit.slice(0, 7)

/** The line `/godmode` and the report give for a note from an older godmode (D60). */
export const updateLineOf = (noteVersion: string, current: string) =>
  isOlderVersion(noteVersion, current)
    ? `A godmode update is available for this project's conventions (set up with ${noteVersion}, now ${current}): \`/godmode setup\` to apply it.`
    : undefined

/** A list cut at `cap`, with how many more there are. */
const capped = (items: readonly string[], cap: number, join = ', ') =>
  items.length > cap ? `${items.slice(0, cap).join(join)}${join}and ${items.length - cap} more` : items.join(join)

const ticketLabel = (ticket: Pick<TicketHeader, 'id' | 'title'>) => (ticket.title.trim() === '' ? ticket.id : `${ticket.id} ${quotedTitle(ticket.title)}`)

/** A ticket's open PR: the one it names (number or link), else the one on its branch. */
export const prOfTicket = (ticket: Pick<TicketHeader, 'pr' | 'branch'>, prs: readonly PullRequest[]) => {
  const named = ticket.pr?.trim().replace(/^#/, '')
  return prs.find(pr => named !== undefined && named !== '' && (pr.ref === named || pr.url === named || pr.branch === named)) ?? prs.find(pr => ticket.branch !== undefined && pr.branch === ticket.branch)
}

// ---------------------------------------------------------------------------
// The report (D44, D70)

/** The setup check: whether the note is there and current, and whether godmode is on. */
async function setupSection($: EngineInterface): Promise<{ lines: string[]; isSetUp: boolean }> {
  const found = await readNote($).catch((error: unknown) => messageOf(error))
  if (typeof found === 'string') return { lines: [`Setup: could not look for the setup note (${found}).`], isSetUp: false }
  if (found.status === 'none') return { lines: ['Setup: not set up in this project yet. `/godmode` runs the setup.'], isSetUp: false }
  if (found.status === 'unreadable') return { lines: [`Setup: the setup note at ${found.path} cannot be read (${found.reason}). \`/godmode\` runs the setup again.`], isSetUp: false }
  const on = (await read($, isOn)) === true ? `on, in ${await read($, mode)} mode` : 'off'
  const lines = [`Setup: done with godmode ${found.shared.godmodeVersion}; godmode is ${on}.`]
  const current = await godmodeVersionOf($).catch(() => found.shared.godmodeVersion)
  const update = updateLineOf(found.shared.godmodeVersion, current)
  if (update !== undefined) lines.push(update)
  if (found.personal === undefined) lines.push('Your own setup answers are missing: `/godmode` asks them.')
  const changed = await changedConventions($, found.project, found.shared.conventions).catch(() => [])
  if (changed.length > 0) lines.push(`Conventions edited since the setup: ${capped(changed, REPORT_LIST_CAP)}.`)
  return { lines, isSetUp: true }
}

/** The open PRs and the files each holds (D44, D47). */
async function prSection($: EngineInterface, cache: LoopCache, context: LoopContext): Promise<{ lines: string[]; prs: PullRequest[] }> {
  let prs: PullRequest[]
  try {
    prs = await openPullRequests($, cache, context, true)
  } catch (error) {
    return { lines: [`Open PRs: could not list them (${messageOf(error)}).`], prs: [] }
  }
  if (prs.length === 0) return { lines: ['Open PRs: none.'], prs }
  const lines = prs.slice(0, REPORT_LIST_CAP).map(pr => {
    const who = [pr.isDraft ? 'draft' : undefined, pr.author === '' ? undefined : `by ${pr.author}`].filter(part => part !== undefined).join(', ')
    const files = pr.files.length === 0 ? 'no files' : capped(pr.files, REPORT_FILES_CAP)
    return `- #${pr.ref} ${quotedTitle(pr.title)}${who === '' ? '' : ` (${who})`}: ${files}`
  })
  if (prs.length > REPORT_LIST_CAP) lines.push(`- and ${prs.length - REPORT_LIST_CAP} more`)
  return { lines: [`Open PRs (${prs.length}):`, ...lines], prs }
}

/** Whether a ticket waits on another one that is not done yet. */
const blockersOf = (ticket: TicketHeader, open: ReadonlySet<string>) => ticket.blockedBy.filter(id => open.has(id.toUpperCase()))

/**
 * The tickets by status, and the ones to build next: todo, nothing blocking, the ones the
 * person said go for first (D44, D52).
 */
const ticketLines = (tickets: readonly TicketHeader[]) => {
  if (tickets.length === 0) return ['Tickets: none open.']
  const open = new Set(tickets.map(ticket => ticket.id.toUpperCase()))
  const counts = (['todo', 'doing', 'review', 'qa'] as const).map(status => [status, tickets.filter(ticket => ticket.status === status)] as const)
  const lines = [`Tickets: ${counts.filter(([, list]) => list.length > 0).map(([status, list]) => `${list.length} ${status}`).join(', ')}.`]
  // The qa ones are in the QA section, with their signal.
  for (const [status, list] of counts) {
    if (status === 'qa' || list.length === 0) continue
    const labels = list.map(ticket => {
      const blockers = blockersOf(ticket, open)
      const notes = [status === 'todo' && ticket.ready ? 'ready' : undefined, blockers.length > 0 ? `blocked by ${blockers.join(', ')}` : undefined].filter(note => note !== undefined)
      return `${ticketLabel(ticket)}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`
    })
    lines.push(`- ${status}: ${capped(labels, REPORT_LIST_CAP, '; ')}`)
  }
  const buildable = tickets.filter(ticket => ticket.status === 'todo' && blockersOf(ticket, open).length === 0)
  const ready = buildable.filter(ticket => ticket.ready)
  if (ready.length > 0) lines.push(`Next: ${ready.slice(0, SUGGESTED_NEXT).map(ticketLabel).join('; ')}.`)
  else if (buildable.length > 0) lines.push(`Next, once you say go: ${buildable.slice(0, SUGGESTED_NEXT).map(ticketLabel).join('; ')}.`)
  return lines
}

/** The fix rounds each open ticket has had (D56), only those with one or more. */
async function fixRoundLines($: EngineInterface, context: LoopContext, tickets: readonly TicketHeader[]) {
  const rounds: string[] = []
  for (const ticket of tickets) {
    const entry = await readFixRounds($, context.project, ticket.id).catch(() => undefined)
    if (entry === undefined || entry.count === 0) continue
    const allowed = allowedOf(context.settings, entry)
    rounds.push(`${ticket.id} ${entry.count} of ${allowed}${entry.count >= allowed ? ' (at the limit)' : ''}`)
  }
  return [`Fix rounds: ${rounds.length === 0 ? 'none.' : `${capped(rounds, REPORT_LIST_CAP)}.`}`]
}

/** The agents running now, godmode's named by role and ticket. */
async function agentLines($: EngineInterface) {
  const running = (await $.agent.list().catch(() => [] as AgentInfo[])).filter(agent => RUNNING_STATUSES.includes(agent.status))
  if (running.length === 0) return ['Agents running: none.']
  const known = await read($, agents)
  const lines = running.slice(0, REPORT_LIST_CAP).map(agent => {
    const record = known[agent.id]
    const role = record === undefined ? agent.type : `${record.role}${record.ticket === undefined ? '' : ` on ${record.ticket}`}`
    const what = agent.description.trim() === '' ? '' : `: ${quotedTitle(agent.description)}`
    return `- ${role}${what} (${agent.id})`
  })
  if (running.length > REPORT_LIST_CAP) lines.push(`- and ${running.length - REPORT_LIST_CAP} more`)
  return [`Agents running (${running.length}):`, ...lines]
}

/**
 * The status report (D44): the setup check, the open PRs and their files, the tickets by
 * status with the next ones to build, the tickets waiting on QA with their signal read the
 * way the prompt hook reads it (D70, D73), fix rounds, and the agents running. It writes
 * nothing; a part that cannot be read says so on its line.
 */
export async function godmodeReport($: EngineInterface, cache: LoopCache): Promise<string> {
  const setup = await setupSection($)
  const lines = ['godmode report', ...setup.lines]
  const context = setup.isSetUp ? await loopContextOf($, cache).catch(() => undefined) : undefined
  if (context !== undefined) {
    lines.push(...(await prSection($, cache, context)).lines)
    let tickets: TicketHeader[] | undefined
    try {
      tickets = await backendFor($, trackerOf(context.note.shared.answers), context.note.dir, context.answers).list({})
      lines.push(...ticketLines(tickets))
    } catch (error) {
      lines.push(`Tickets: could not read them (${messageOf(error)}).`)
    }
    const qa = await qaCheckBlock($, cache)
    lines.push(qa === undefined ? 'Waiting on QA: none.' : `Waiting on QA:\n${qa}`)
    if (tickets !== undefined) lines.push(...(await fixRoundLines($, context, tickets)))
  }
  lines.push(...(await agentLines($)))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Resume (D57)

/** Where one in-progress ticket stands, as the resume found it. */
export type ResumedTicket = {
  ticket: TicketHeader
  worktree?: string
  /** The last commit on its worktree or branch, `abc1234 subject`. */
  lastCommit?: string
  pr?: PullRequest
  verdict?: VerdictRecord
  /** The QA agent's last result on the ticket, or the person's skip. */
  qa?: BotQaRecord
  /** This person's last dev dispatch on it. */
  dispatch?: DevDispatch
}

/** The last commit in a folder, or on a branch from the repo's root: `abc1234 subject`. */
async function lastCommitOf($: EngineInterface, cwd: string, branch?: string) {
  const argv = ['git', 'log', '-1', '--format=%h %s', ...(branch === undefined ? [] : [`refs/heads/${branch}`])]
  const result = await $.process.run(argv, { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined)
  const line = result?.exitCode === 0 ? (result.stdout.trim().split('\n')[0] ?? '') : ''
  return line === '' ? undefined : line
}

/** One ticket's worktree, last commit, PR and review verdict. */
async function standingOf(
  $: EngineInterface,
  context: LoopContext,
  ticket: TicketHeader,
  prs: readonly PullRequest[],
  records: { verdicts: Readonly<Record<string, VerdictRecord>>; qa: Readonly<Record<string, BotQaRecord>>; dispatch?: DevDispatch },
): Promise<ResumedTicket> {
  const path = worktreePathOf(context.project, context.settings, ticket.id)
  const worktree = (await $.fs.exists(path).catch(() => false)) ? path : undefined
  const lastCommit =
    worktree !== undefined ? await lastCommitOf($, worktree) : ticket.branch === undefined ? undefined : await lastCommitOf($, context.project.root, ticket.branch)
  const pr = prOfTicket(ticket, prs)
  return { ticket, worktree, lastCommit, pr, verdict: pr === undefined ? undefined : records.verdicts[pr.ref], qa: records.qa[ticket.id], dispatch: records.dispatch }
}

/** The person's line for one resumed ticket (D57). */
export const resumeLine = (found: ResumedTicket) => {
  const { ticket, worktree, lastCommit, pr } = found
  const parts = [worktree === undefined ? (ticket.branch === undefined ? 'no worktree yet' : `branch ${ticket.branch}`) : `worktree ${worktree}`]
  if (lastCommit !== undefined) parts.push(`last commit ${lastCommit.replace(/^(\S+) (.*)$/, (_all, hash: string, subject: string) => `${hash} ${quotedTitle(subject)}`)}`)
  if (pr !== undefined) parts.push(`PR #${pr.ref}`)
  return `Resuming ${ticketLabel(ticket)}, ${ticket.status === 'review' ? 'in review' : 'doing'}: ${parts.join(', ')}.`
}

/** What the PM does for one resumed ticket. */
export const resumeStep = (found: ResumedTicket) => {
  const { ticket, lastCommit, pr, verdict, qa } = found
  if (ticket.status === 'doing' && found.dispatch?.endedAsking === true) {
    return `- ${ticket.id} (doing): its last dev agent stopped to ask the person something (its last report holds the question). Ask the person first, and dispatch again only once they answered.`
  }
  if (ticket.status === 'doing') {
    const from = lastCommit === undefined ? 'from the start' : `from its last commit (${lastCommit.split(' ')[0] ?? ''})`
    return `- ${ticket.id} (doing): dispatch one godmode:dev agent on ${ticket.id}, briefed to read what its worktree holds and go on ${from}; godmode gives it the same worktree and branch.`
  }
  if (pr === undefined) return `- ${ticket.id} (review): godmode found no open PR for it. Check where it stands with ticket_list and the host before doing anything.`
  if (verdict === undefined || verdict.headCommit !== pr.headCommit) {
    return `- ${ticket.id} (review, PR #${pr.ref}): no review verdict at its current commit ${short(pr.headCommit)}. Dispatch one godmode:reviewer on PR #${pr.ref}, unless one you dispatched is still running on it.`
  }
  if (verdict.verdict === 'clean' && qa?.result === 'fail' && qa.commit === pr.headCommit) {
    return `- ${ticket.id} (review, PR #${pr.ref}): its review was clean at ${short(pr.headCommit)}, and the QA agent failed it there. Start the fix round with the QA agent's findings.`
  }
  if (verdict.verdict === 'clean') return `- ${ticket.id} (review, PR #${pr.ref}): its review was clean at ${short(pr.headCommit)}. Go on from there, as the QA mode says.`
  return `- ${ticket.id} (review, PR #${pr.ref}): its review asked for changes at ${short(pr.headCommit)} (${verdict.verdict}). Start the fix round as usual.`
}

/**
 * The resume on `/godmode` (D57): the tickets in doing or review that this person's godmode
 * dispatched a dev agent on (never a teammate's), that no workflow carries, and that no
 * running agent of this session builds, matched with their worktrees, branches and PRs.
 * Resolves one line per ticket for the person, and the PM's instructions; undefined when
 * nothing is to resume. Never throws: a resume that cannot read the tickets leaves the
 * switch-on quiet.
 */
export async function resumeOf($: EngineInterface, cache: LoopCache): Promise<{ lines: string[]; context: string } | undefined> {
  try {
    const context = await loopContextOf($, cache)
    if (context === undefined) return undefined
    const backend = backendFor($, trackerOf(context.note.shared.answers), context.note.dir, context.answers)
    const dispatches = await readDevDispatches($, context.project)
    // Only this person's own work, and none a workflow carries on.
    const inProgress = (await backend.list({ statuses: RESUMED_STATUSES })).filter(ticket => {
      const dispatch = dispatches[ticket.id.toUpperCase()]
      return dispatch !== undefined && dispatch.isWorkflow !== true
    })
    if (inProgress.length === 0) return undefined
    const listed = await $.agent.list().catch(() => undefined)
    const running = new Set((listed ?? []).filter(agent => RUNNING_STATUSES.includes(agent.status)).map(agent => agent.id))
    const known = await read($, agents)
    // A dev agent of this session still at work on a ticket carries on by itself.
    const busy = new Set(Object.entries(known).flatMap(([id, agent]) => (agent.role === 'dev' && agent.ticket !== undefined && running.has(id) ? [agent.ticket.toUpperCase()] : [])))
    const toResume = inProgress.filter(ticket => !busy.has(ticket.id.toUpperCase()))
    if (toResume.length === 0) return undefined
    const prs = await openPullRequests($, cache, context, true).catch(() => [] as PullRequest[])
    const verdicts = await readVerdicts($, context.project).catch(() => ({}))
    const qa = await readBotQa($, context.project).catch(() => ({}))
    const found: ResumedTicket[] = []
    for (const ticket of toResume) found.push(await standingOf($, context, ticket, prs, { verdicts, qa, dispatch: dispatches[ticket.id.toUpperCase()] }))
    const them = found.length === 1 ? 'it' : 'them'
    const head =
      listed === undefined
        ? `godmode resumed: ${found.length === 1 ? 'this ticket was' : 'these tickets were'} in progress, and godmode could not list the running agents, so it cannot tell whether an agent still works on ${them}. Do not dispatch on any of ${them} until you can check which agents run; then pick each up where it stands:`
        : `godmode resumed: ${found.length === 1 ? 'this ticket was' : 'these tickets were'} in progress, and no agent of this session is working on ${them}. Pick each up where it stands, without waiting to be asked:`
    return {
      lines: found.map(resumeLine),
      context: [head, ...found.map(resumeStep), 'Dispatch within the agent cap; the rest wait for a free slot.'].join('\n'),
    }
  } catch {
    return undefined
  }
}
