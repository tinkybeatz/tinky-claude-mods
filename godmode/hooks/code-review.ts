import type { EngineInterface } from 'claude-code'

import type { Answer } from './storage'

/*
 * GitHub reviews, read through `gh` (D70, D77): the named people a rule counts (logins and
 * `org/team` names), each reviewer's latest deciding review, and the code-review state a
 * merge waits on when a person other than the author must approve. Read only. Every helper
 * that takes `$` is a function declaration: the engine follows `$` past an import only into those.
 */

/** Each `gh` call stops after this, so a slow host never holds the prompt for long. */
const GH_TIMEOUT_MS = 3_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const textOf = (value: Answer | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/** The named QA people (D70): GitHub logins, and teams written `org/team`. */
export const approversOf = (value: Answer | undefined) => {
  const named = (textOf(value) ?? '').split(/[\s,]+/).map(part => part.replace(/^@/, '').trim()).filter(part => part !== '')
  return {
    logins: new Set(named.filter(part => !part.includes('/')).map(part => part.toLowerCase())),
    teams: named.filter(part => /^[^/]+\/[^/]+$/.test(part)),
  }
}

export type Approvers = ReturnType<typeof approversOf>

/** One reviewer's latest review that decides: an approval, changes requested, or a dismissal. */
export type LatestReview = { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED'; commit?: string }

const DECIDING: readonly string[] = ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The PR's head commit and each reviewer's latest deciding review, from `gh pr view --json
 * reviews,headRefOid`; a string says what is wrong with the output. A comment after an
 * approval leaves the approval standing, as on GitHub.
 */
export const parseReviews = (stdout: string): { head: string; latest: LatestReview[]; mergedBy?: string } | string => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return 'gh answered something that is not JSON'
  }
  if (!isRecord(value) || typeof value.headRefOid !== 'string' || !Array.isArray(value.reviews)) return 'gh answered no head commit or reviews'
  const latest = new Map<string, LatestReview>()
  for (const review of value.reviews) {
    if (!isRecord(review) || !isRecord(review.author) || typeof review.author.login !== 'string') continue
    const state = String(review.state)
    if (!DECIDING.includes(state)) continue
    const commit = isRecord(review.commit) && typeof review.commit.oid === 'string' ? review.commit.oid : undefined
    latest.set(review.author.login.toLowerCase(), { login: review.author.login, state: state as LatestReview['state'], commit })
  }
  // `state` and `mergedBy` are read when the merge signal is on; a merge with no login known is "someone".
  const isMerged = value.state === 'MERGED'
  const mergedBy = isMerged ? (isRecord(value.mergedBy) && typeof value.mergedBy.login === 'string' ? value.mergedBy.login : 'someone') : undefined
  return { head: value.headRefOid, latest: [...latest.values()], ...(mergedBy === undefined ? {} : { mergedBy }) }
}

/**
 * What one prompt already asked GitHub, shared by all its tickets: team memberships and
 * whether each team can be seen. Each is a promise, so tickets checked side by side wait
 * on the same call instead of making their own.
 */
export type Lookups = Map<string, Promise<boolean | string>>

const lookedUp = (lookups: Lookups, key: string, read: () => Promise<boolean | string>) => {
  const known = lookups.get(key)
  if (known !== undefined) return known
  const reading = read()
  lookups.set(key, reading)
  return reading
}

/** A `gh api` read: what it printed, or what went wrong and whether GitHub said 404. */
async function ghApi($: EngineInterface, cwd: string, path: string, jq: string): Promise<{ stdout: string } | { said: string; isNotFound: boolean }> {
  const result = await $.process.run(['gh', 'api', path, '--jq', jq], { cwd, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => messageOf(error))
  if (typeof result === 'string') return { said: result, isNotFound: false }
  if (result.exitCode === 0) return { stdout: result.stdout }
  const said = (result.stderr.trim() || result.stdout.trim()).slice(0, 200) || `exit ${result.exitCode}`
  return { said, isNotFound: /\b404\b|not found/i.test(said) }
}

/** Whether `gh` can see a team at all: true, or why not. */
async function teamVisibility($: EngineInterface, cwd: string, team: string): Promise<boolean | string> {
  const [org = '', slug = ''] = team.split('/')
  const read = await ghApi($, cwd, `orgs/${org}/teams/${slug}`, '.slug')
  return 'stdout' in read ? true : read.said
}

/** Whether a login is in a team: true, false, or why it could not be read. */
async function isTeamMember($: EngineInterface, cwd: string, team: string, login: string, lookups: Lookups): Promise<boolean | string> {
  const [org = '', slug = ''] = team.split('/')
  // GitHub answers 404 both for "not a member" and for a team gh may not see (no read:org
  // scope, a secret team). The team is read beside the membership, in the same round, and
  // only a team gh can see turns a 404 into "not a member".
  const [membership, isVisible] = await Promise.all([
    ghApi($, cwd, `orgs/${org}/teams/${slug}/memberships/${login}`, '.state'),
    lookedUp(lookups, `team:${team}`, () => teamVisibility($, cwd, team)),
  ])
  if ('stdout' in membership) return membership.stdout.trim() === 'active'
  if (membership.isNotFound && isVisible === true) return false
  const why = membership.isNotFound
    ? `GitHub answered 404, which also means gh cannot see ${team} or lacks the read:org scope${typeof isVisible === 'string' ? `; reading the team gave: ${isVisible}` : ''}`
    : membership.said
  return `the membership of ${team} could not be read (${why})`
}

/** Whether a reviewer is a named QA person: a listed login, or a member of a listed team. */
export async function isApprover($: EngineInterface, cwd: string, approvers: Approvers, login: string, lookups: Lookups): Promise<boolean | string> {
  if (approvers.logins.has(login.toLowerCase())) return true
  const answers = await Promise.all(
    approvers.teams.map(team => lookedUp(lookups, `member:${team}:${login.toLowerCase()}`, () => isTeamMember($, cwd, team, login, lookups))),
  )
  if (answers.includes(true)) return true
  return answers.find((answer): answer is string => typeof answer === 'string') ?? false
}


/** The code-review rule (D77): how many approvals, and whose count ("" for anyone but the author and the person). */
export type ReviewRule = { count: number; reviewers: string }

/** Where a PR's code review stands, at its current commit. */
export type CodeReview =
  | { kind: 'approved'; have: number; need: number }
  | { kind: 'waiting'; have: number; need: number }
  | { kind: 'changes'; by: string[] }
  | { kind: 'unchecked'; reason: string }

/** `gh pr view --json reviewDecision,reviews,author,headRefOid` read: GitHub's own decision, the author, the head and each reviewer's latest review. */
export const parseReviewView = (stdout: string) => {
  const reviews = parseReviews(stdout)
  if (typeof reviews === 'string') return reviews
  const value = JSON.parse(stdout) as Record<string, unknown>
  const author = isRecord(value.author) && typeof value.author.login === 'string' ? value.author.login.toLowerCase() : ''
  const decision = typeof value.reviewDecision === 'string' ? value.reviewDecision : ''
  return { ...reviews, author, decision }
}

/**
 * The code-review state (D77) from GitHub's answer: only each reviewer's latest review counts,
 * never the PR author's nor the person's own, and only the named people's when the rule names
 * some. Changes requested holds the merge. GitHub's `reviewDecision` is followed where branch
 * protection gives one: `APPROVED` keeps approvals GitHub kept after a push, `REVIEW_REQUIRED`
 * waits. With no decision, an approval counts only at the PR's current commit.
 */
export async function codeReviewOf($: EngineInterface, cwd: string, pr: string, rule: ReviewRule, me: string | undefined, lookups: Lookups = new Map()): Promise<CodeReview> {
  const result = await $.process.run(['gh', 'pr', 'view', pr, '--json', 'reviewDecision,reviews,author,headRefOid'], { cwd, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => messageOf(error))
  if (typeof result === 'string') return { kind: 'unchecked', reason: `gh pr view ${pr} did not answer: ${result}` }
  if (result.exitCode !== 0) return { kind: 'unchecked', reason: `gh pr view ${pr} failed: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 150) || `exit ${result.exitCode}`}` }
  return codeReviewOfView($, cwd, pr, result.stdout, rule, me, lookups)
}

/** The code-review state from a `gh pr view --json reviewDecision,reviews,author,headRefOid` answer already read. */
export async function codeReviewOfView($: EngineInterface, cwd: string, pr: string, stdout: string, rule: ReviewRule, me: string | undefined, lookups: Lookups = new Map()): Promise<CodeReview> {
  const view = parseReviewView(stdout)
  if (typeof view === 'string') return { kind: 'unchecked', reason: `PR #${pr}: ${view}` }
  const others = view.latest.filter(review => review.login.toLowerCase() !== view.author && review.login.toLowerCase() !== me?.toLowerCase())
  const named = approversOf(rule.reviewers)
  const isNamed = named.logins.size > 0 || named.teams.length > 0
  const answers = isNamed ? await Promise.all(others.map(review => isApprover($, cwd, named, review.login, lookups))) : others.map(() => true)
  const counted = others.filter((_review, index) => answers[index] === true)
  const changes = counted.filter(review => review.state === 'CHANGES_REQUESTED').map(review => review.login)
  if (changes.length > 0) return { kind: 'changes', by: changes }
  const kept = view.decision === 'APPROVED'
  const have = counted.filter(review => review.state === 'APPROVED' && (kept || review.commit === view.head)).length
  const need = Math.max(1, rule.count)
  if (view.decision === 'REVIEW_REQUIRED' || have < need) return { kind: 'waiting', have, need }
  return { kind: 'approved', have, need }
}

/** The approvals branch protection asks for on `base`, read only; undefined when it cannot be read (no admin rights, no protection). */
export async function protectionCount($: EngineInterface, root: string, base: string): Promise<number | undefined> {
  const repo = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: root, timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined)
  const name = repo?.exitCode === 0 ? repo.stdout.trim() : ''
  if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return undefined
  const read = await ghApi($, root, `repos/${name}/branches/${base}/protection`, '.required_pull_request_reviews.required_approving_review_count')
  if (!('stdout' in read)) return undefined
  const count = Number(read.stdout.trim())
  return Number.isInteger(count) && count >= 1 ? count : undefined
}
