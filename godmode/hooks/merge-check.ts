import type { EngineInterface } from 'claude-code'

import { codeReviewOfView } from './code-review'
import type { Lookups } from './code-review'
import { conditionWords } from './project-rules'
import type { MergeCondition } from './project-rules'

/*
 * The project's merge conditions, checked live on a PR (D78), whoever made it: one read of the
 * PR through `gh`, then each condition's state in words. Read only. Every helper that takes
 * `$` is a function declaration: the engine follows `$` past an import only into those.
 */

/** Each `gh` read stops after this, so a slow host never holds a call for long. */
const GH_TIMEOUT_MS = 10_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One check on a PR's commit, as `statusCheckRollup` gives it: a check run or a commit status. */
export type PrCheck = { name: string; state: 'passed' | 'failed' | 'running' }

/** A PR as one live read gives it. `stdout` is the raw answer, which the review count reads again. */
export type PrView = {
  number: string
  author: string
  head: string
  title: string
  branch: string
  state: string
  isDraft: boolean
  mergeState: string
  checks: PrCheck[]
  stdout: string
}

const PR_FIELDS = 'number,author,headRefOid,headRefName,title,state,isDraft,mergeStateStatus,reviewDecision,reviews,statusCheckRollup'

const PASSED: readonly string[] = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILED: readonly string[] = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']

/** One `statusCheckRollup` row as a check: done and passed, done and failed, or still running. */
const checkOf = (row: unknown): PrCheck | undefined => {
  if (!isRecord(row)) return undefined
  const name = String(row.name ?? row.context ?? 'a check')
  const conclusion = String(row.conclusion ?? row.state ?? '').toUpperCase()
  const status = String(row.status ?? '').toUpperCase()
  if (status !== '' && status !== 'COMPLETED') return { name, state: 'running' }
  if (PASSED.includes(conclusion)) return { name, state: 'passed' }
  if (FAILED.includes(conclusion)) return { name, state: 'failed' }
  return { name, state: 'running' }
}

/** A `gh pr view --json ...` answer as a PR, or what is wrong with it. */
export const parsePrView = (stdout: string): PrView | string => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return 'gh answered something that is not JSON'
  }
  if (!isRecord(value) || typeof value.headRefOid !== 'string') return 'gh answered no head commit'
  const author = isRecord(value.author) && typeof value.author.login === 'string' ? value.author.login : ''
  const rows = Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : []
  return {
    number: String(value.number ?? ''),
    author,
    head: value.headRefOid,
    title: typeof value.title === 'string' ? value.title : '',
    branch: typeof value.headRefName === 'string' ? value.headRefName : '',
    state: typeof value.state === 'string' ? value.state : 'OPEN',
    isDraft: value.isDraft === true,
    mergeState: typeof value.mergeStateStatus === 'string' ? value.mergeStateStatus : 'UNKNOWN',
    checks: rows.flatMap(row => checkOf(row) ?? []),
    stdout,
  }
}

/** One live read of a PR, tried again once when it fails: the PR, or why it could not be read. */
export async function readPrView($: EngineInterface, cwd: string, pr: string): Promise<PrView | { error: string }> {
  let said = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await $.process.run(['gh', 'pr', 'view', pr, '--json', PR_FIELDS], { cwd, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => messageOf(error))
    if (typeof result === 'string') {
      said = result
      continue
    }
    if (result.exitCode !== 0) {
      said = (result.stderr.trim() || result.stdout.trim()).slice(0, 150) || `exit ${result.exitCode}`
      continue
    }
    const view = parsePrView(result.stdout)
    if (typeof view !== 'string') return view
    said = view
  }
  return { error: `gh could not read PR #${pr}: ${said}` }
}

/** Whether the PR's checks are green: every one done and passed. No check at all is not green. */
export const ciState = (checks: readonly PrCheck[]): { met: boolean; state: string } => {
  if (checks.length === 0) return { met: false, state: 'no CI check has reported on this commit' }
  const failed = checks.filter(check => check.state === 'failed')
  if (failed.length > 0) return { met: false, state: `failing: ${failed.map(check => check.name).slice(0, 4).join(', ')}` }
  const running = checks.filter(check => check.state === 'running')
  if (running.length > 0) return { met: false, state: `${running.length} of ${checks.length} still running` }
  return { met: true, state: `${checks.length} green` }
}

/** Whether the PR's branch holds its base's latest commit, as GitHub's merge state says. */
export const upToDateState = (mergeState: string): { met: boolean; state: string } => {
  if (mergeState === 'BEHIND') return { met: false, state: 'the branch is behind its base' }
  if (mergeState === 'UNKNOWN') return { met: false, state: 'GitHub has not worked out the merge state yet' }
  return { met: true, state: 'up to date' }
}

/** One merge condition on one PR: whether it holds now, and its live state in words. */
export type ConditionCheck = { condition: MergeCondition; met: boolean; state: string }

/** The `qa` condition's live state, read by the caller: it knows the tickets and the tracker. */
export type QaLookup = () => Promise<{ met: boolean; state: string }>

/** Every merge condition the project sets, checked on this PR now (D78). An empty list checks nothing. */
export async function checkMergeConditions(
  $: EngineInterface,
  cwd: string,
  view: PrView,
  conditions: readonly MergeCondition[],
  me: string | undefined,
  qa: QaLookup,
  lookups: Lookups = new Map(),
): Promise<ConditionCheck[]> {
  const checks: ConditionCheck[] = []
  for (const condition of conditions) {
    if (condition.kind === 'ci') checks.push({ condition, ...ciState(view.checks) })
    else if (condition.kind === 'up-to-date') checks.push({ condition, ...upToDateState(view.mergeState) })
    else if (condition.kind === 'qa') checks.push({ condition, ...(await qa().catch((error: unknown) => ({ met: false, state: `could not be read (${messageOf(error)})` }))) })
    else {
      const review = await codeReviewOfView($, cwd, view.number, view.stdout, condition, me, lookups)
      const state =
        review.kind === 'approved' || review.kind === 'waiting'
          ? `${review.have}/${review.need} at the current commit`
          : review.kind === 'changes'
            ? `${review.by.join(', ')} requested changes`
            : `could not be read (${review.reason})`
      checks.push({ condition, met: review.kind === 'approved', state })
    }
  }
  return checks
}

/** The conditions that do not hold, as one line: each with its live state. */
export const missingLine = (checks: readonly ConditionCheck[]) =>
  checks
    .filter(check => !check.met)
    .map(check => `${conditionWords(check.condition)} (${check.state})`)
    .join('; ')

/** The conditions that hold, as one line. */
export const heldLine = (checks: readonly ConditionCheck[]) => checks.map(check => `${conditionWords(check.condition)} (${check.state})`).join('; ')

/**
 * The ticket key a PR godmode did not make names in its branch or title (D78): a Jira key, or
 * godmode's `T-n` on markdown tickets. Read only to look the ticket up; never linked or recorded.
 */
export const ticketKeyIn = (text: string, isMarkdown: boolean) => (isMarkdown ? /\b(T-\d+)\b/i : /\b([A-Z][A-Z0-9]+-\d+)\b/i).exec(text)?.[1]?.toUpperCase()
