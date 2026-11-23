import type { EngineInterface } from 'claude-code'

import type { ScanFacts } from '../types'
import { NO_LIVE_FACTS } from './project-rules'
import type { LiveFacts, Protection } from './project-rules'
import { attributionIn } from './rules'

/*
 * What setup reads live besides the file scan (D78): the base branch's protection on GitHub
 * (its rules, else its classic protection), the CI files the repo holds, how PRs land, and
 * whether the history's commits name the AI. Read only, and silent: a read that fails leaves
 * its item open for a question. Every helper that takes `$` is a function declaration: the
 * engine follows `$` past an import only into those.
 */

const GH_TIMEOUT_MS = 5_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The CI files godmode recognises, besides `.github/workflows/*.yml`. */
const CI_FILES: readonly string[] = ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', '.travis.yml', '.buildkite/pipeline.yml']

const parsed = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

/** Branch rules (`repos/o/r/rules/branches/<base>`) as protection: the approvals, the required checks, strictness. */
export const protectionFromRules = (value: unknown): Protection | undefined => {
  if (!Array.isArray(value)) return undefined
  const rules: Protection = { approvals: 0, checks: [], isStrict: false }
  for (const rule of value) {
    if (!isRecord(rule) || !isRecord(rule.parameters)) continue
    const parameters = rule.parameters
    if (rule.type === 'pull_request' && typeof parameters.required_approving_review_count === 'number') rules.approvals = Math.max(rules.approvals, parameters.required_approving_review_count)
    if (rule.type === 'required_status_checks') {
      const checks = Array.isArray(parameters.required_status_checks) ? parameters.required_status_checks : []
      rules.checks.push(...checks.flatMap(check => (isRecord(check) && typeof check.context === 'string' ? [check.context] : [])))
      if (parameters.strict_required_status_checks_policy === true) rules.isStrict = true
    }
  }
  return rules
}

/** Classic protection (`repos/o/r/branches/<base>/protection`) as protection. */
export const protectionFromClassic = (value: unknown): Protection | undefined => {
  if (!isRecord(value)) return undefined
  const reviews = isRecord(value.required_pull_request_reviews) ? value.required_pull_request_reviews : {}
  const status = isRecord(value.required_status_checks) ? value.required_status_checks : {}
  const contexts = Array.isArray(status.contexts) ? status.contexts.filter((context): context is string => typeof context === 'string') : []
  return {
    approvals: typeof reviews.required_approving_review_count === 'number' ? reviews.required_approving_review_count : 0,
    checks: contexts,
    isStrict: status.strict === true,
  }
}

/** One `gh` read: its parsed answer, `missing` for a 404, or why it failed. */
async function ghRead($: EngineInterface, root: string, args: string[]): Promise<{ value: unknown } | { missing: true } | { error: string }> {
  const result = await $.process.run(['gh', ...args], { cwd: root, timeoutMs: GH_TIMEOUT_MS }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (typeof result === 'string') return { error: result }
  if (result.exitCode === 0) return { value: parsed(result.stdout) }
  const said = (result.stderr.trim() || result.stdout.trim()).slice(0, 150)
  return /\b404\b|not found|not protected/i.test(said) ? { missing: true } : { error: said || `exit ${result.exitCode}` }
}

/** The base branch's protection, from its rules and its classic protection together. */
async function protectionOf($: EngineInterface, facts: ScanFacts): Promise<LiveFacts['protection']> {
  const base = facts.git.baseBranch
  if (facts.git.host !== 'github' || base === undefined) return { status: 'no-host' }
  const repo = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: facts.root, timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined)
  const name = repo?.exitCode === 0 ? repo.stdout.trim() : ''
  if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return { status: 'unreadable', reason: 'gh could not name the repository' }
  const branchRules = await ghRead($, facts.root, ['api', `repos/${name}/rules/branches/${base}`])
  const classic = await ghRead($, facts.root, ['api', `repos/${name}/branches/${base}/protection`])
  const reads = [branchRules, classic]
  const found = [
    'value' in branchRules ? protectionFromRules(branchRules.value) : undefined,
    'value' in classic ? protectionFromClassic(classic.value) : undefined,
  ].filter((rules): rules is Protection => rules !== undefined)
  if (found.length === 0) {
    const error = reads.find((read): read is { error: string } => 'error' in read)
    return error === undefined ? { status: 'none' } : { status: 'unreadable', reason: error.error }
  }
  const rules: Protection = {
    approvals: Math.max(...found.map(entry => entry.approvals)),
    checks: [...new Set(found.flatMap(entry => entry.checks))],
    isStrict: found.some(entry => entry.isStrict),
  }
  return rules.approvals === 0 && rules.checks.length === 0 && !rules.isStrict ? { status: 'none' } : { status: 'read', rules }
}

/** The CI files the repo holds. */
async function ciFilesOf($: EngineInterface, root: string) {
  const workflows = await $.fs.list(`${root}/.github/workflows`).catch(() => [])
  const found = workflows.filter(entry => entry.kind === 'file' && /\.ya?ml$/i.test(entry.name)).map(entry => `.github/workflows/${entry.name}`)
  for (const file of CI_FILES) if (await $.fs.exists(`${root}/${file}`).catch(() => false)) found.push(file)
  return found
}

/** How PRs land: the one way the repo allows, when it allows one only. */
async function mergeMethodOf($: EngineInterface, facts: ScanFacts) {
  if (facts.git.host !== 'github') return undefined
  const read = await ghRead($, facts.root, ['repo', 'view', '--json', 'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed'])
  if (!('value' in read) || !isRecord(read.value)) return undefined
  const allowed = [
    ...(read.value.mergeCommitAllowed === true ? ['merge commit'] : []),
    ...(read.value.squashMergeAllowed === true ? ['squash'] : []),
    ...(read.value.rebaseMergeAllowed === true ? ['rebase'] : []),
  ]
  return allowed.length === 1 ? allowed[0] : undefined
}

/** Whether the history's recent commits name the AI: true, false, or undefined with no history to read. */
async function attributionOf($: EngineInterface, root: string) {
  const log = await $.process.run(['git', 'log', '-n', '100', '--format=%B%x00'], { cwd: root }).catch(() => undefined)
  if (log?.exitCode !== 0) return undefined
  const messages = log.stdout.split('\u0000').map(message => message.trim()).filter(message => message !== '')
  if (messages.length === 0) return undefined
  return messages.some(message => attributionIn(message) !== undefined)
}

/** Every live fact setup reads, silently; a read that fails is an item left open. */
export async function liveFactsOf($: EngineInterface, facts: ScanFacts): Promise<LiveFacts> {
  if (!facts.git.hasGit) return NO_LIVE_FACTS
  const [protection, ci, mergeMethod, attribution] = await Promise.all([
    protectionOf($, facts).catch((error: unknown): LiveFacts['protection'] => ({ status: 'unreadable', reason: error instanceof Error ? error.message : String(error) })),
    ciFilesOf($, facts.root),
    mergeMethodOf($, facts).catch(() => undefined),
    attributionOf($, facts.root),
  ])
  return { protection, ci, ...(mergeMethod === undefined ? {} : { mergeMethod }), ...(attribution === undefined ? {} : { attribution }) }
}
