import type { EngineInterface } from 'claude-code'

import { approversOf, isApprover, parseReviews } from './code-review'
import type { Approvers, Lookups } from './code-review'
import { prNumberOf } from './host'
import { codeReviewOf } from './code-review'
import type { CodeReview } from './code-review'
import { jiraLatestComment, jiraMovedToQa, jiraRecorded, jiraStatusOf, jiraWaiting, statusMapOf } from './jira'
import type { JiraComment } from './jira'
import { loopContextOf, ownLogin } from './loop'
import type { LoopCache, LoopContext } from './loop'
import { qaSignalsOf } from './role'
import type { QaMode, QaSignal } from './role'
import { hasQaPassAt, isHumanQaMode } from './rules'
import type { Answer } from './storage'
import { backendFor, TICKET_STATUSES, trackerOf } from './tickets'
import type { QaResult, TrackerKind } from './tickets'

/*
 * The prompt-hook QA check (D73, Step 13.5 and 13.6). On each prompt while godmode is on in
 * coding mode, the tickets waiting in qa are read from the ticket store on disk, never from
 * the PM's memory, so compaction cannot lose one. Each gets one fresh line: a result godmode
 * saw, or still waiting. A result seen here is never recorded here: the line tells the PM,
 * and only the main thread records it with ticket_move (qaResult). Every helper that takes
 * `$` is a function declaration: the engine follows `$` past an import only into those.
 */

/** How long a ticket's answer from `gh` is kept: a kept answer, not a timer (D73). */
export const QA_CHECK_TTL_MS = 5 * 60_000

/** Each `gh` call stops after this, so a slow host never holds the prompt for long. */
export const GH_TIMEOUT_MS = 3_000

/** At most this many tickets are checked per prompt, oldest first. */
export const QA_CHECK_CAP = 10

/** A ticket waiting on QA, as the check reads it. */
type Waiting = {
  id: string
  title?: string
  /** The tracker's status, read now; absent where the hook has not read it. */
  status?: string
  pr?: string
  qaResult?: QaResult
  /** Why the tracker's status cannot be read this prompt; the PM checks it (D73). */
  unreadable?: string
  /** The tracker no longer has it: what became of its record. */
  missing?: string
}

/** What the check saw for one ticket. */
export type QaFinding =
  /** `isMerged` when the pass is the PR's merge outside godmode: the ticket then closes too. */
  | { kind: 'pass'; how: string; isMerged?: true }
  /** `comment` is the latest comment on a Jira ticket the board failed, where a tester's reason usually is; absent elsewhere. */
  | { kind: 'fail'; how: string; comment?: JiraComment | 'none' | 'unreadable' }
  | { kind: 'waiting'; note?: string }
  /** A pass already recorded at the PR's current commit. */
  | { kind: 'recorded'; commit: string }
  | { kind: 'unchecked'; reason: string }
  /** A pass recorded at an older commit than the PR's current one; `status` when the board still shows the pass status. */
  | { kind: 'stale-pass'; recorded: string; head: string; pr: string; status?: string }
  /** In human-staging, moved to the done status outside godmode, as a board's automation does after the merge. */
  | { kind: 'done-outside'; status: string }
  /** The tracker's status is the PM's to read (D73's fallback); `recorded` names a pass whose commit could not be checked. */
  | { kind: 'ask-pm'; tracker: TrackerKind; recorded?: string }

/** A kept answer from `gh` for one ticket, valid for its PR only. */
type KeptCheck = { at: number; pr: string; head?: string; finding: QaFinding }

const FINDING_KINDS: readonly string[] = ['pass', 'fail', 'waiting', 'recorded', 'unchecked', 'stale-pass', 'done-outside', 'ask-pm']

/** Two clones can share a first commit, so the kept answers are per repo too. */
const keptKey = (projectId: string, repo: string) => `qaChecks:${projectId}:${repo}`

/** `owner/name` from a git remote URL, `https://`, `ssh://` or `user@host:path` alike. */
export const repoNameOf = (url: string) => /[:/]([^/:]+\/[^/:]+?)(?:\.git)?\/*$/.exec(url.trim())?.[1]?.toLowerCase()

/** The repo's `origin` as `owner/name`, or `no-origin`. */
async function repoOf($: EngineInterface, root: string) {
  const origin = await $.process.run(['git', 'remote', 'get-url', 'origin'], { cwd: root, timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined)
  return (origin?.exitCode === 0 ? repoNameOf(origin.stdout) : undefined) ?? 'no-origin'
}

/** The longest ticket title a line quotes. */
const TITLE_MAX = 80

/** The longest Jira comment a line quotes. */
const COMMENT_MAX = 200

/**
 * Text people or agents wrote, as quoted data on one line: line breaks, quotes, backticks
 * and angle brackets go, and a long one is cut at `max`, so it cannot pass for a line of
 * its own, a tag or an instruction to the PM.
 */
const quotedText = (text: string, max: number) => {
  const flat = text.replace(/[\p{Cc}"`<>\\]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return `"${flat.length > max ? `${flat.slice(0, max - 3)}...` : flat}"`
}

/** A ticket title as quoted data on one line, cut at 80 characters. */
export const quotedTitle = (title: string) => quotedText(title, TITLE_MAX)

const isKeptCheck = (value: unknown): value is KeptCheck =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as KeptCheck).at === 'number' &&
  typeof (value as KeptCheck).pr === 'string' &&
  FINDING_KINDS.includes((value as KeptCheck).finding?.kind)

const short = (commit: string) => commit.slice(0, 7)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const textOf = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

const sameStatus = (a: string, b: string | undefined) => b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

/** A ticket's PR as a GitHub PR number: `12`, `#12` or a PR link; a branch name is none. */
export const githubPrOf = (pr: string | undefined) => {
  if (pr === undefined) return undefined
  return /^#?(\d+)$/.exec(pr.trim())?.[1] ?? prNumberOf(pr)
}

/**
 * The ticket-status signal (D70): the tracker's status equal to the pass status is a pass;
 * moved out of the waiting status to anything but the pass status is a fail (build
 * default). Undefined while it still waits. `done` is given in human-staging only: there the
 * change is merged, and a board's automation may close the ticket on its own, which is no
 * tester's verdict.
 */
export const statusFinding = (status: string, waiting: string, pass: string | undefined, done?: string): QaFinding | undefined => {
  if (sameStatus(status, pass)) return { kind: 'pass', how: `its status is "${status}", the pass status` }
  if (sameStatus(status, waiting)) return undefined
  if (sameStatus(status, done)) return { kind: 'done-outside', status }
  return { kind: 'fail', how: `it moved from "${waiting}" to "${status}", not to the pass status${pass === undefined ? '' : ` "${pass}"`}` }
}

/**
 * The PR-approval signal (D70) on GitHub: an approval from a named QA person at the PR's
 * current commit is a pass, changes requested by one at that commit a fail. An approval
 * at an older commit waits for a new one, as a pass holds only at its commit.
 */
async function approvalFinding($: EngineInterface, cwd: string, pr: string, watch: Watch, lookups: Lookups): Promise<{ head?: string; finding: QaFinding }> {
  const { approvers } = watch
  const isApprovalRead = watch.isPrSignalOn && (approvers.logins.size > 0 || approvers.teams.length > 0)
  if (!isApprovalRead && !watch.isMergeSignalOn) {
    return { finding: { kind: 'waiting', note: 'no QA approvers are named in the setup, so PR approvals are not read' } }
  }
  const fields = watch.isMergeSignalOn ? 'reviews,headRefOid,state,mergedBy' : 'reviews,headRefOid'
  const result = await $.process.run(['gh', 'pr', 'view', pr, '--json', fields], { cwd, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => messageOf(error))
  if (typeof result === 'string') return { finding: { kind: 'unchecked', reason: `gh pr view ${pr} did not answer: ${result}` } }
  if (result.exitCode !== 0) {
    return { finding: { kind: 'unchecked', reason: `gh pr view ${pr} failed: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 200) || `exit ${result.exitCode}`}` } }
  }
  const parsed = parseReviews(result.stdout)
  if (typeof parsed === 'string') return { finding: { kind: 'unchecked', reason: `PR #${pr}: ${parsed}` } }
  const { head, latest, mergedBy } = parsed
  const at = `PR #${pr}'s current commit ${short(head)}`
  // godmode merges in human-pr only after a QA pass recorded at the head, which reads as
  // "recorded" before this; so a merge of a PR whose ticket still waits was someone else's.
  if (mergedBy !== undefined && watch.isMergeSignalOn) {
    return { head, finding: { kind: 'pass', how: `${mergedBy} merged PR #${pr} at ${short(head)} outside godmode`, isMerged: true } }
  }
  if (!isApprovalRead) {
    return { head, finding: { kind: 'waiting', note: mergedBy === undefined ? 'its PR is not merged yet' : `${mergedBy} merged PR #${pr} outside godmode` } }
  }
  // Team lookups cost a call each, so only a review at the current commit, which decides, gets one.
  const relevant = latest.filter(review => review.state !== 'DISMISSED' && (review.commit === head || approvers.logins.has(review.login.toLowerCase())))
  const answers = await Promise.all(relevant.map(review => isApprover($, cwd, approvers, review.login, lookups)))
  const named = relevant.filter((_review, index) => answers[index] === true)
  const unknown = relevant.flatMap((review, index) => {
    const answer = answers[index]
    return typeof answer === 'string' && review.commit === head ? [{ review, why: answer }] : []
  })
  const atHead = named.filter(review => review.commit === head)
  const failed = atHead.filter(review => review.state === 'CHANGES_REQUESTED').map(review => review.login)
  if (failed.length > 0) return { head, finding: { kind: 'fail', how: `${failed.join(', ')} requested changes at ${at}` } }
  // Changes requested by someone who may be a QA person outweigh any approval: no pass until it is known.
  const maybeFailed = unknown.find(({ review }) => review.state === 'CHANGES_REQUESTED')
  if (maybeFailed !== undefined) {
    return { head, finding: { kind: 'unchecked', reason: `${maybeFailed.review.login} requested changes at ${at}, and ${maybeFailed.why}` } }
  }
  const passed = atHead.filter(review => review.state === 'APPROVED').map(review => review.login)
  if (passed.length > 0) return { head, finding: { kind: 'pass', how: `${passed.join(', ')} approved ${at}` } }
  if (unknown.length > 0) return { head, finding: { kind: 'unchecked', reason: unknown[0]?.why ?? '' } }
  const older = named.filter(review => review.state === 'APPROVED' && review.commit !== undefined)
  if (older.length > 0) {
    const who = older.map(review => `${review.login} at ${short(review.commit ?? '')}`).join(', ')
    return { head, finding: { kind: 'waiting', note: `approved at an older commit (${who}); ${at} needs a new approval` } }
  }
  return { head, finding: { kind: 'waiting', note: `no approval or change request from the QA approvers at ${at}${mergedBy === undefined ? '' : `; ${mergedBy} merged PR #${pr} outside godmode, which this setup does not count as a QA pass, so ask the person whether QA passed`}` } }
}

/**
 * A tracker ticket's status, read by the hook itself through `$.mcp.call` (spike 10),
 * within 3 seconds. Undefined where it cannot be read (no Atlassian server, a failed or slow
 * call, the "Other" tracker), and the line then tells the PM to check it (D73).
 */
async function trackerStatusOf($: EngineInterface, context: LoopContext, ticket: Waiting): Promise<string | undefined> {
  if (trackerOf(context.note.shared.answers) !== 'jira' || ticket.unreadable !== undefined) return undefined
  return jiraStatusOf($, context, ticket.id)
}

/**
 * The tickets waiting in qa, oldest first, read from the ticket store, never from memory.
 * Markdown tickets are read from their files, the "Other" tracker's from godmode's own
 * copies. Jira's are asked of Jira: godmode's tickets in the waiting status, and those its
 * side files say it moved to qa, so a ticket a tester moved on is seen too.
 */
async function waitingTickets($: EngineInterface, context: LoopContext, waitStatus: string): Promise<{ tickets: Waiting[] }> {
  const tracker = trackerOf(context.note.shared.answers)
  // Only people testing by hand move a ticket on the board, so in bot or none nothing there is watched.
  if (tracker === 'jira' && !isHumanQaMode(context.settings.qaMode)) return { tickets: await jiraMovedToQa($, context.project) }
  if (tracker === 'jira') {
    const { tickets, unreadable } = await jiraWaiting($, context, waitStatus)
    return { tickets: tickets.map(ticket => (unreadable === undefined ? ticket : { ...ticket, unreadable })) }
  }
  const headers = await backendFor($, tracker, context.note.dir, context.answers).list({ statuses: TICKET_STATUSES })
  // A staging original whose fix ticket is filed is no longer watched: it closes when the fix ticket passes (build default).
  const fixed = new Set(headers.flatMap(header => (header.fixFor === undefined ? [] : [header.fixFor.toUpperCase()])))
  const waiting = headers.filter(header => header.status === 'qa' && !fixed.has(header.id.toUpperCase()))
  // The "Other" tracker's status is on a board godmode cannot read; its own copy only says it waits.
  return {
    tickets: waiting.map(header => ({ id: header.id, title: header.title, ...(tracker === 'none' ? { status: header.status } : {}), pr: header.pr, qaResult: header.qaResult })),
  }
}

/** What the project's setup says to watch, read once per prompt. */
type Watch = {
  tracker: TrackerKind
  qaMode: QaMode
  signals: readonly QaSignal[]
  /** The PR signal counts only in `human-pr` and on GitHub (D70); in `human-staging` an approval is ignored. */
  isPrSignalOn: boolean
  /** The merge signal: a merge outside godmode while the ticket waits is a pass, in `human-pr` on GitHub only. */
  isMergeSignalOn: boolean
  waitStatus: string
  passStatus?: string
  /** The board's done status, read on Jira only. */
  doneStatus?: string
  /** Whether `gh` reads the project's PRs. */
  isGitHub: boolean
  approvers: Approvers
}

const watchOf = (context: LoopContext, tracker: TrackerKind): Watch => {
  // The signals are people's (D70): a mode where nobody tests by hand reads none of them.
  const signals = isHumanQaMode(context.settings.qaMode) ? qaSignalsOf(context.answers) : []
  const isGitHub =
    (context.host === undefined || ('kind' in context.host && context.host.kind === 'github')) && context.answers.gitHost !== 'local' && context.answers.gitHost !== 'other'
  return {
    tracker,
    qaMode: context.settings.qaMode,
    signals,
    // With code review on (D77), an approval is a code-review approval: the QA signal counts only the named QA approvers, and none named skips it.
    isPrSignalOn:
      signals.includes('pr-approval') &&
      context.settings.qaMode === 'human-pr' &&
      isGitHub &&
      (context.settings.humanReview === undefined || textOf(context.answers.qaApprovers) !== undefined),
    isMergeSignalOn: signals.includes('pr-merged') && context.settings.qaMode === 'human-pr' && isGitHub,
    waitStatus: tracker === 'none' ? 'qa' : (textOf(context.answers.qaWaitStatus) ?? 'qa'),
    passStatus: textOf(context.answers.qaPassStatus),
    ...(tracker === 'jira' ? { doneStatus: statusMapOf(context.answers).done } : {}),
    isGitHub,
    approvers: approversOf(context.answers.qaApprovers),
  }
}

/** A PR's current commit on GitHub, read within 3 seconds, or why it could not be. */
async function prHeadOf($: EngineInterface, cwd: string, pr: string): Promise<{ head: string } | { error: string }> {
  const result = await $.process.run(['gh', 'pr', 'view', pr, '--json', 'headRefOid'], { cwd, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => messageOf(error))
  if (typeof result === 'string') return { error: `gh pr view ${pr} did not answer: ${result}` }
  if (result.exitCode !== 0) return { error: `gh pr view ${pr} failed: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 200) || `exit ${result.exitCode}`}` }
  try {
    const value: unknown = JSON.parse(result.stdout)
    if (isRecord(value) && typeof value.headRefOid === 'string') return { head: value.headRefOid }
  } catch {
    // Not JSON: said below.
  }
  return { error: `gh pr view ${pr} answered no head commit` }
}

type RecordedPass = Extract<QaFinding, { kind: 'recorded' | 'stale-pass' | 'unchecked' }>

/**
 * A recorded pass against the PR's current commit: it holds only there (build default), so
 * a board still showing the pass status after a new push is no pass. Undefined with no pass
 * recorded; "unchecked" when the current commit cannot be read.
 */
async function recordedPassOf($: EngineInterface, context: LoopContext, watch: Watch, ticket: Waiting): Promise<RecordedPass | undefined> {
  const result = ticket.qaResult
  if (result?.result !== 'passed') return undefined
  const pr = githubPrOf(ticket.pr)
  const at = `a QA pass is recorded at ${short(result.commit)}`
  if (pr === undefined) return { kind: 'unchecked', reason: `${at}, but godmode knows no PR for it, so it cannot tell whether that is the current commit` }
  if (!watch.isGitHub) return { kind: 'unchecked', reason: `${at}, but godmode cannot read PR #${pr}'s current commit on this host` }
  const read = await prHeadOf($, context.project.root, pr)
  if ('error' in read) return { kind: 'unchecked', reason: `${at}, but godmode could not read PR #${pr}'s current commit (${read.error})` }
  return hasQaPassAt(result, read.head) ? { kind: 'recorded', commit: read.head } : { kind: 'stale-pass', recorded: result.commit, head: read.head, pr }
}

/**
 * The ticket-status signal with what is recorded: a pass at the PR's current commit no
 * longer waits, and a pass status on the board never stands for a commit nobody tested.
 */
async function boardFindingOf($: EngineInterface, context: LoopContext, watch: Watch, ticket: Waiting): Promise<QaFinding | undefined> {
  const pass = await recordedPassOf($, context, watch, ticket)
  if (pass?.kind === 'recorded') return pass
  const status = ticket.status ?? (await trackerStatusOf($, context, ticket))
  if (status === undefined) {
    if (pass?.kind === 'stale-pass') return pass
    return { kind: 'ask-pm', tracker: watch.tracker, ...(pass === undefined || ticket.qaResult === undefined ? {} : { recorded: ticket.qaResult.commit }) }
  }
  const seen = statusFinding(status, watch.waitStatus, watch.passStatus, watch.qaMode === 'human-staging' ? watch.doneStatus : undefined)
  // No godmode tool gives the PM a Jira comment, so the hook quotes the latest one, where a tester's reason usually is.
  if (seen?.kind === 'fail' && watch.tracker === 'jira') return { ...seen, comment: await jiraLatestComment($, context, ticket.id) }
  if (seen?.kind !== 'pass' || pass === undefined) return seen
  return pass.kind === 'stale-pass' ? { ...pass, status } : { kind: 'unchecked', reason: `${seen.how}, and ${pass.reason}` }
}

/** One ticket's finding: its status first (read now), then its PR's reviews (kept 5 minutes). */
async function findingOf(
  $: EngineInterface,
  context: LoopContext,
  watch: Watch,
  ticket: Waiting,
  kept: Readonly<Record<string, KeptCheck>>,
  now: number,
  lookups: Lookups,
): Promise<{ finding: QaFinding; keep?: KeptCheck }> {
  if (ticket.missing !== undefined) return { finding: { kind: 'unchecked', reason: ticket.missing } }
  if (watch.signals.includes('ticket-status')) {
    const seen = await boardFindingOf($, context, watch, ticket)
    if (seen !== undefined) return { finding: seen }
  }
  const pr = githubPrOf(ticket.pr)
  if (!watch.isPrSignalOn && !watch.isMergeSignalOn) return { finding: { kind: 'waiting' } }
  if (pr === undefined) return { finding: { kind: 'waiting', note: 'godmode knows no PR for it, so it reads no approval' } }
  const old = kept[ticket.id]
  // Only "still waiting" is served from a kept answer. A pass or a fail holds at the commit it
  // was read at, and a push since would have the line name a commit nobody approved; a
  // ticket with a pass recorded is read afresh too, so "recorded" names the current commit.
  const isReusable = old !== undefined && old.pr === pr && now - old.at < QA_CHECK_TTL_MS && old.finding.kind === 'waiting' && ticket.qaResult?.result !== 'passed'
  const checked = isReusable ? old : { at: now, pr, ...(await approvalFinding($, context.project.root, pr, watch, lookups)) }
  // A failure to check is no answer: the next prompt tries again.
  const keep = checked.finding.kind === 'waiting' ? checked : undefined
  const finding: QaFinding = checked.head !== undefined && hasQaPassAt(ticket.qaResult, checked.head) ? { kind: 'recorded', commit: checked.head } : checked.finding
  return { finding, keep }
}

const TRACKER_NAMES: Readonly<Record<TrackerKind, string>> = { none: 'the ticket files', jira: 'Jira', other: 'the tracker' }

/** Where the PM takes a fail's reason from: the Jira comment the hook read, else the person. */
const failReason = (id: string, comment: Extract<QaFinding, { kind: 'fail' }>['comment']) => {
  if (comment === undefined) return 'take the tester\'s reason from their latest comment on the PR or ticket (none: ask the person)'
  if (comment === 'none') return `${id} has no comment in Jira, so ask the person for the tester's reason`
  if (comment === 'unreadable') return `godmode could not read ${id}'s comments in Jira, so ask the person for the tester's reason`
  const by = comment.author === undefined ? '' : ` by ${quotedText(comment.author, TITLE_MAX)}`
  return `the latest comment on ${id} in Jira${by} reads ${quotedText(comment.text, COMMENT_MAX)}; take it as the tester's reason if it is one, else ask the person for it`
}

/** The line the PM reads for one ticket. */
export const findingLine = (ticket: { id: string; title?: string }, finding: QaFinding, watch: Pick<Watch, 'qaMode' | 'waitStatus' | 'passStatus'> & { doneStatus?: string }) => {
  const label = ticket.title === undefined || ticket.title.trim() === '' ? `QA ${ticket.id}` : `QA ${ticket.id} (${quotedTitle(ticket.title)})`
  // In human-staging the change is already merged, so a pass also closes the ticket.
  const closes = watch.qaMode === 'human-staging' ? ', status: done' : ''
  const record = (word: 'passed' | 'failed') => `ticket_move (id: ${ticket.id}, qaResult: ${word}${word === 'passed' ? closes : ''})`
  switch (finding.kind) {
    case 'pass':
      if (finding.isMerged === true) {
        return `${label}: ${finding.how}. The setup counts that as a QA pass godmode saw but did not record; the change is merged, so record it and close the ticket with ticket_move (id: ${ticket.id}, qaResult: passed, status: done).`
      }
      return `${label}: ${finding.how}. That is a QA pass godmode saw but did not record: record it with ${record('passed')}.`
    case 'fail':
      return `${label}: ${finding.how}. That is a QA fail godmode saw but did not record: ${failReason(ticket.id, finding.comment)}, then record it with ${record('failed')}.`
    case 'recorded':
      return `${label}: a QA pass is recorded at its PR's current commit ${short(finding.commit)}; it no longer waits on testers.`
    case 'stale-pass': {
      const again = `so the testers must test again. Do not record a pass: move it back to "${watch.waitStatus}" with ticket_move (id: ${ticket.id}, status: qa), or ask the person`
      return finding.status === undefined
        ? `${label}: a QA pass is recorded at ${short(finding.recorded)}, but PR #${finding.pr} moved to a new commit ${short(finding.head)} since, ${again}. A board status out of "${watch.waitStatus}" other than the pass status is still a fail: record it with ${record('failed')}.`
        : `${label}: the board still shows the pass status "${finding.status}", but PR #${finding.pr} moved to a new commit ${short(finding.head)} since the QA pass recorded at ${short(finding.recorded)}, ${again}.`
    }
    case 'done-outside':
      return `${label}: it was moved to "${finding.status}", the done status, outside godmode (by hand or by the board's automation), not to the pass status${watch.passStatus === undefined ? '' : ` "${watch.passStatus}"`}. That is not a QA fail and needs no fix ticket: ask the person whether QA passed, then record what they say with ${record('passed')} or ${record('failed')}.`
    case 'unchecked':
      return `${label}: could not check (${finding.reason}); still waiting as far as godmode knows.`
    case 'ask-pm': {
      // ticket_list reaches Jira (D24); the "Other" tracker only the person can read, as the PM's tools are limited (D63).
      const where = finding.tracker === 'jira' ? 'with ticket_list' : `by asking the person what ${TRACKER_NAMES[finding.tracker]} shows for it (neither godmode nor you can reach it)`
      const closed =
        watch.qaMode === 'human-staging' && watch.doneStatus !== undefined
          ? ` "${watch.doneStatus}" means it was closed outside godmode, which is no fail: ask the person whether QA passed, and file no fix ticket.`
          : ''
      const recorded =
        finding.recorded === undefined
          ? ''
          : ` A QA pass is already recorded at ${short(finding.recorded)}, and godmode could not tell whether the PR moved since: if it did, a pass status on the board predates the new commit, so ask the person rather than record a pass.`
      return `${label}: still waiting as far as godmode knows, but it cannot read ${TRACKER_NAMES[finding.tracker]}'s status itself. Check this ticket's status ${where}: "${watch.passStatus ?? 'the pass status'}" is a pass, and any other status out of "${watch.waitStatus}" a fail.${closed} Record what you find with ${record('passed')} or ${record('failed')}.${recorded}`
    }
    default:
      return `${label}: still waiting${finding.note === undefined ? '' : ` (${finding.note})`}.`
  }
}

/** The line for one ticket's code review (D77). */
export const codeReviewLine = (id: string, pr: string, review: CodeReview) => {
  const label = `Code review ${id}`
  if (review.kind === 'approved') return `${label}: approved (${review.have}/${review.need}) at PR #${pr}'s current commit; it merges once QA passes too.`
  if (review.kind === 'waiting') return `${label}: waiting for code review (${review.have}/${review.need}) on PR #${pr}.`
  if (review.kind === 'changes') {
    return `${label}: ${review.by.join(', ')} requested changes on PR #${pr}. Offer the person a fix round from the review comments; start it only on their word or under the fix-round rules.`
  }
  return `${label}: could not check (${review.reason}).`
}

/**
 * The code-review block for this prompt (D77): with code review on and PRs on GitHub, one line
 * per ticket in review or qa with a PR, at most `QA_CHECK_CAP`, read fresh from GitHub.
 * Undefined when there is nothing to say. It never throws.
 */
export async function codeReviewBlock($: EngineInterface, cache: LoopCache): Promise<string | undefined> {
  try {
    const context = await loopContextOf($, cache)
    const rule = context?.settings.humanReview
    if (context === undefined || rule === undefined) return undefined
    const tracker = trackerOf(context.note.shared.answers)
    if (!watchOf(context, tracker).isGitHub) return undefined
    const tickets =
      tracker === 'jira'
        ? await jiraRecorded($, context.project, ['review', 'qa'])
        : await backendFor($, tracker, context.note.dir, context.answers).list({ statuses: ['review', 'qa'] })
    const withPr = tickets.flatMap(ticket => {
      const pr = githubPrOf(ticket.pr)
      return pr === undefined ? [] : [{ id: ticket.id, pr }]
    })
    if (withPr.length === 0) return undefined
    const me = await ownLogin($, cache, context)
    const lookups = new Map<string, Promise<boolean | string>>()
    const lines = await Promise.all(withPr.slice(0, QA_CHECK_CAP).map(async ticket => codeReviewLine(ticket.id, ticket.pr, await codeReviewOf($, context.project.root, ticket.pr, rule, me, lookups))))
    return lines.join('\n')
  } catch (error) {
    return `Code review: godmode could not read the PRs' reviews (${messageOf(error)}).`
  }
}

/** The line for the tickets past the cap, which are not checked this prompt. */
export const moreLine = (count: number) => `QA: and ${count} more ticket${count === 1 ? '' : 's'} in qa, not checked this prompt (still waiting).`

/**
 * The QA block for this prompt: one line per ticket waiting in qa, at most `QA_CHECK_CAP`
 * checked, oldest first, then how many more. Undefined when no ticket waits or godmode is
 * not set up. It never throws: a failure is a line, and the prompt goes on.
 */
export async function qaCheckBlock($: EngineInterface, cache: LoopCache): Promise<string | undefined> {
  try {
    const context = await loopContextOf($, cache)
    if (context === undefined) return undefined
    const watch = watchOf(context, trackerOf(context.note.shared.answers))
    const { tickets } = await waitingTickets($, context, watch.waitStatus)
    if (tickets.length === 0) return undefined
    // Only PR reads are kept, so with the PR signal off nothing is read or written.
    const key = watch.isPrSignalOn || watch.isMergeSignalOn ? keptKey(context.project.id, await repoOf($, context.project.root)) : undefined
    const stored: unknown = key === undefined ? undefined : await $.store.get(key).catch(() => undefined)
    const kept: Record<string, KeptCheck> = {}
    if (isRecord(stored)) for (const [id, check] of Object.entries(stored)) if (isKeptCheck(check)) kept[id] = check
    const now = await $.clock.now()
    const checked = tickets.slice(0, QA_CHECK_CAP)
    const lookups: Lookups = new Map()
    const results = await Promise.all(
      checked.map(ticket =>
        findingOf($, context, watch, ticket, kept, now, lookups).catch((error: unknown): { finding: QaFinding; keep?: KeptCheck } => ({
          finding: { kind: 'unchecked', reason: messageOf(error) },
        })),
      ),
    )
    const next: Record<string, KeptCheck> = {}
    checked.forEach((ticket, index) => {
      const keep = results[index]?.keep
      if (keep !== undefined && now - keep.at < QA_CHECK_TTL_MS) next[ticket.id] = keep
    })
    if (key !== undefined) await $.store.set(key, next).catch(() => undefined)
    const lines = checked.map((ticket, index) => findingLine(ticket, results[index]?.finding ?? { kind: 'waiting' }, watch))
    if (tickets.length > checked.length) lines.push(moreLine(tickets.length - checked.length))
    return lines.join('\n')
  } catch (error) {
    return `QA: godmode could not read the tickets waiting in qa (${messageOf(error)}); list them with ticket_list (status: qa).`
  }
}
